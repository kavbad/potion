// Serving-grade latency binding for the serving path (G2.6).
//
// The owner's first requirement: "latency evidence must be serving-grade, not
// harness-grade. Bind against serving-path latency distributions (p95, not
// mean) where they exist; where they don't, treat the harness number as
// provisional and say so."
//
// The binding implementation moved to @potion/pareto's serving module
// (2026-08-31, one-resolver P0) so the learning period binds exactly as the
// serve path does; this file keeps the ctx-shaped seam every server call
// site uses, plus the trace/condition halves that are server concerns. All
// three resolveOperatingPoint call sites (chat, openai-parity, playground)
// still go through here, because a bound enforced only in
// /v1/chat/completions is silently non-binding on /v1/completions — the
// "handled in one route is not handled" class that G2.4 closed out.
import type { Frontier, Policy } from '@potion/core';
import {
  POLICY_INFEASIBLE,
  clearPolicyCondition,
  raisePolicyCondition,
  type PolicyInfeasibleDetail,
} from '@potion/db';
import {
  bindServingLatency as bindServingLatencyOnDb,
  policyHasLatencyDimension,
  type LatencyBinding,
} from '@potion/pareto';
import type { PotionContext } from './context.js';
import type { LatencyViolation } from './routes/chat.js';

// Moved machinery, re-exported so every existing import keeps working.
export {
  SERVING_LATENCY_WINDOW_MIN,
  SERVING_LATENCY_CACHE_TTL_MS,
  clearServingLatencyCache,
  policyHasLatencyDimension,
  type LatencyBinding,
} from '@potion/pareto';

/**
 * Resolve the latency the policy will be evaluated against — the ctx-shaped
 * seam over @potion/pareto's bindServingLatency (same cache, same
 * semantics; the package function takes the raw db handle so workers can
 * call it too).
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
  return bindServingLatencyOnDb(ctx.db.db, policy, frontier, orgId, clusterId, warn, now);
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
