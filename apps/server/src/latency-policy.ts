// Serving-grade latency binding for the serving path (G2.6).
//
// The owner's first requirement: "latency evidence must be serving-grade, not
// harness-grade. Bind against serving-path latency distributions (p95, not
// mean) where they exist; where they don't, treat the harness number as
// provisional and say so."
//
// This module is the ONE seam where that substitution happens. All three
// resolveOperatingPoint call sites (chat, openai-parity, playground) go
// through it, because a bound enforced only in /v1/chat/completions is
// silently non-binding on /v1/completions — the "handled in one route is not
// handled" class that G2.4 closed out.
//
// Three non-negotiables, in order of how badly they break things:
//   1. A rollup failure NEVER breaks serving. Catch, warn, fall back to the
//      harness numbers marked provisional (the resolveGuaranteeOverride
//      precedent).
//   2. Only policies with a latency DIMENSION pay the query. A min_cost
//      policy must not acquire a per-request database read.
//   3. The cached frontier is never mutated — resolveLatency shallow-copies,
//      and so does everything here.
import {
  latencyPremium,
  resolveLatency,
  type Frontier,
  type LatencyEvidence,
  type LatencyPremium,
  type Policy,
  type ServingLatencySample,
} from '@potion/core';
import {
  POLICY_INFEASIBLE,
  clearPolicyCondition,
  raisePolicyCondition,
  servingLatencyP95,
  type PolicyInfeasibleDetail,
} from '@potion/db';
import type { PotionContext } from './context.js';
import type { LatencyViolation } from './routes/chat.js';

/** Rollup window. An hour of traffic is long enough to accumulate the sample
 * minimum on a modest workload and short enough that a regression shows up
 * while it still matters. */
export const SERVING_LATENCY_WINDOW_MIN = 60;

/** Per-(org, cluster) rollup cache TTL. Matches the org provider-set cache
 * (context.ts ORG_PROVIDER_CACHE_TTL_MS): fresh enough that a latency
 * regression binds within a minute, cheap enough that a hot cluster does not
 * issue a quantile query per request. Per-replica by construction — a shared
 * cache is a G2.5 (Redis) seam, not a correctness gap: replicas converge
 * within the TTL. */
export const SERVING_LATENCY_CACHE_TTL_MS = 60_000;

interface CacheEntry {
  at: number;
  rows: ServingLatencySample[];
}

const cache = new Map<string, CacheEntry>();

/** Test seam: drop the memo so a suite can observe a fresh rollup. */
export function clearServingLatencyCache(): void {
  cache.clear();
}

/** True when the policy states a latency constraint at all. Only these pay
 * for the rollup — and latency_bound gets the SAME binding as compound,
 * because shipping two meanings of "p95" would be worse than shipping one
 * that is sometimes provisional. */
export function policyHasLatencyDimension(policy: Policy): boolean {
  return policy.type === 'compound' || policy.type === 'latency_bound';
}

export interface LatencyBinding {
  /** The frontier the policy should be evaluated against — serving-grade p95
   * substituted where the evidence supports it. Identity-equal to the input
   * when no substitution applies. */
  frontier: Frontier | null;
  /** Per-strategyHash evidence: which number, from which clock, over what n. */
  evidence: Record<string, LatencyEvidence>;
  /** 'serving' when ANY point resolved to serving-grade evidence. The value
   * the trace's latency_src= field reports. */
  source: 'serving' | 'harness';
  /** The cost the bound is charging, computed against the SAME resolved
   * points the selection used. */
  premium: LatencyPremium;
}

/** The no-op binding: the policy has no latency dimension, or there is no
 * frontier to bind against. */
function inert(frontier: Frontier | null): LatencyBinding {
  return {
    frontier,
    evidence: {},
    source: 'harness',
    premium: latencyPremium({ type: 'min_cost', qualityFloor: 0 }, []),
  };
}

/**
 * Resolve the latency the policy will be evaluated against.
 *
 * Returns the frontier unchanged for policies without a latency dimension, so
 * the common path costs one boolean.
 */
export async function bindServingLatency(
  ctx: PotionContext,
  policy: Policy,
  frontier: Frontier | null,
  orgId: string,
  clusterId: string,
  warn: (msg: string) => void = () => {},
  now: Date = new Date(),
): Promise<LatencyBinding> {
  if (!policyHasLatencyDimension(policy)) return inert(frontier);
  if (!frontier || frontier.points.length === 0) return inert(frontier);

  let rows: ServingLatencySample[] = [];
  try {
    rows = await cachedRollup(ctx, orgId, clusterId, now);
  } catch (err) {
    // Non-negotiable 1. The customer's request is served against the harness
    // numbers, and every surface says the evidence is provisional — which is
    // exactly the honest answer: we could not measure, so we did not claim to.
    warn(
      `serving-latency rollup failed for org=${orgId} cluster=${clusterId} — ` +
        `binding against PROVISIONAL harness latency: ${String(err)}`,
    );
    rows = [];
  }

  const resolved = resolveLatency(frontier.points, rows, SERVING_LATENCY_WINDOW_MIN);
  return {
    frontier: { ...frontier, points: resolved.points },
    evidence: resolved.evidence,
    source: resolved.allProvisional ? 'harness' : 'serving',
    premium: latencyPremium(policy, resolved.points),
  };
}

async function cachedRollup(
  ctx: PotionContext,
  orgId: string,
  clusterId: string,
  now: Date,
): Promise<ServingLatencySample[]> {
  const key = `${orgId}::${clusterId}`;
  const hit = cache.get(key);
  if (hit && now.getTime() - hit.at < SERVING_LATENCY_CACHE_TTL_MS) return hit.rows;
  const rows = await servingLatencyP95(
    ctx.db.db,
    orgId,
    clusterId,
    SERVING_LATENCY_WINDOW_MIN,
    now,
  );
  cache.set(key, { at: now.getTime(), rows });
  return rows;
}

/**
 * The trace fields a latency-dimensioned policy contributes (G2.6).
 *
 * `latency_src` is emitted ALWAYS for such a policy — the reader must be able
 * to tell a measured bind from a provisional one without a second lookup.
 * The premium and violation markers appear only when they are true, so their
 * presence in a trace is itself the signal.
 */
export function latencyTraceFields(
  policy: Policy,
  binding: LatencyBinding,
  violated: boolean,
): string {
  if (!policyHasLatencyDimension(policy)) return '';
  let out = `;latency_src=${binding.source}`;
  if (binding.premium.binding === 'latency' && binding.premium.savingsPct > 0) {
    out +=
      `;latency_premium=${binding.premium.savingsPct.toFixed(2)}` +
      `;relax_ms=${Math.round(binding.premium.relaxLatencyToMs ?? 0)}`;
  }
  if (violated) out += ';latency_violated=1';
  return out;
}

/**
 * Maintain the STANDING policy-level condition for a compound policy (G2.6,
 * owner refinement: "persistent infeasibility escalates as a standing
 * policy-level condition on the guarantee status — deduped, like advisories —
 * not just per-request labels").
 *
 * Raise on violation, clear on the first feasible evaluation. Both are deduped
 * in the repo layer, so this is safe to call on every request; a policy
 * serving a thousand violating requests mints one row.
 *
 * Like every other guarantee-adjacent lookup on this path, a failure here
 * NEVER breaks serving — the request is already answered and labeled; losing
 * the standing condition degrades the monthly report, not the response.
 */
export async function maintainPolicyCondition(
  ctx: PotionContext,
  args: {
    orgId: string;
    policyId: string | null;
    clusterId: string;
    policy: Policy;
    binding: LatencyBinding;
    violation: LatencyViolation | undefined;
    emit?: (created: boolean, detail: PolicyInfeasibleDetail) => void;
  },
  warn: (msg: string) => void = () => {},
): Promise<void> {
  // A policy with no id is an inline override, not a standing configuration —
  // there is nothing durable to raise a condition against.
  if (args.policy.type !== 'compound' || args.policyId === null) return;
  const scope = { orgId: args.orgId, policyId: args.policyId, clusterId: args.clusterId };
  try {
    if (args.violation) {
      const detail: PolicyInfeasibleDetail = {
        leg: 'policy',
        condition: POLICY_INFEASIBLE,
        policyId: args.policyId,
        clusterId: args.clusterId,
        boundMs: args.violation.boundMs,
        qualityFloor: args.violation.qualityFloor,
        servedStrategy: args.violation.servedStrategyHash,
        servedP95Ms: args.violation.servedP95Ms,
        latencySource: args.binding.source,
        relaxLatencyToMs: args.violation.relaxLatencyToMs,
        relaxQualityToFloor: args.violation.relaxQualityToFloor,
      };
      const { created } = await raisePolicyCondition(ctx.db.db, detail, args.orgId);
      // The alert fires ONCE per episode, on the transition — not per request.
      if (created) args.emit?.(true, detail);
      return;
    }
    await clearPolicyCondition(ctx.db.db, scope, {
      reason: 'feasible',
      latencySource: args.binding.source,
      boundMs: args.policy.p95Ms,
      qualityFloor: args.policy.qualityFloor,
    });
  } catch (err) {
    warn(`policy-condition maintenance failed for policy=${args.policyId}: ${String(err)}`);
  }
}
