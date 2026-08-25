// POST /v1/chat/completions (SPEC §8) — OpenAI-compatible subset.
//
// Pipeline: zod-validate → Bearer auth → api_keys row → its policy → cluster
// assign (<30ms target; cached by sha256(first 512 chars of concatenated user
// content)) → loadCurrentFrontier(cluster) → selectPoint(policy) → NULL
// fallback to the highest-quality point (documented in SPEC §1/§8) → execute
// the resolved strategy → OpenAI-shaped response.
//
// Every response carries `x-frontier-trace:
//   cluster=<id>;strategy=<hash8>;frontier=v<n>;policy=<type>;fallback=<0|1>;provenance=<live|mock|blocked>`.
// (provenance added in M1a — see guardFrontierProvenance.)
// stream:true + single strategy → SSE (chat.completion.chunk deltas + [DONE]);
// stream:true + composite strategy (M3 #23, SPEC §12.6) → SSE too, with the
// keep/upgrade decision recorded as `upgraded=0|1` on x-frontier-trace;
// stream:true + any other multi-call strategy → 200 JSON +
// `x-latency-contract: non-streamed` (documented latency contract: those
// strategies fan out model calls and cannot honor token streaming).
// EVERY request (including 4xx/5xx) is logged to request_logs.
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ChatMessageSchema,
  ToolChoiceSchema,
  ToolSchema,
  fastestQualityQualifyingPoint,
  highestQualityPoint,
  latencyPremium,
  lshBucket,
  requestShape,
  shapeClass,
  selectPoint,
  strategyHash,
  type ChatMessage,
  type Frontier,
  type Policy,
  type StrategyConfig,
  type ToolCall,
  type Usage,
  flattenWireMessage,
  SamplingParamsSchema,
  type SamplingParams,
} from '@potion/core';
import { DEFAULT_ORG_ID, getClusterByIdForOrg, getLatestFrontier, getOrgById, insertRequestLog, resolvePolicyRef, type NewRequestLog, listPolicies } from '@potion/db';
import { maybeKeepLearningSample } from '../learning/sampling.js';
import type { RankedAssignment } from '@potion/cluster';
import { loadCurrentFrontier } from '@potion/pareto';
import { strategyCapabilities } from '@potion/strategies';
import { ambiguityMargin, ambiguousRunnerUp, pickSafer } from '../routing/ambiguity.js';
import { baselineFor } from '../routing/baseline.js';
import { policyForCluster } from '../routing/floors.js';
import { learnFromAnswer, tooSmallForReasoning } from '../routing/reasoning.js';
import { unwrapJsonFences, wantsJson } from '../routing/json-mode.js';
import { answerShapeOf, promptFingerprint, sessionFingerprint, taskShapeOf } from '../routing/task-shape.js';
import { execute } from '@potion/strategies';
import { authenticate, bearerToken, openAiError } from '../auth.js';
import {
  fallbackStrategyFor,
  DEFAULT_STRATEGY,
  assignmentCacheKey,
  type PotionContext,
} from '../context.js';
// ---- M3 #21 shadow (m3-shadow) — appended import ----
import { runShadow, shouldSample } from '../shadow.js';
// ---- end M3 #21 shadow imports ----
// ---- M3 #22 guarantee (m3-guarantee) — appended import ----
import {
  resolveGuaranteeOverride,
  runGuaranteeErrorSample,
  runGuaranteeSample,
  shouldSampleGuarantee,
} from '../guarantee.js';
// ---- end M3 #22 guarantee imports ----
// ---- M4 #33/#35 alerts + budget (m4-alerts-budget) — appended imports ----
import { emitAlert } from '../alerts.js';
import {
  bindServingLatency,
  latencyTraceFields,
  maintainPolicyCondition,
} from '../latency-policy.js';
import { enforceBudgetHardStop } from './budgets.js';
import { ProviderError, breakerStates } from '@potion/providers';
// ---- end M4 #33/#35 imports ----

// ---- M4 #33 breaker_open alerts (m4-alerts-budget) ----
// Transition detector: the resilience circuit breaker fast-rejects with a
// breakerOpen ProviderError for as long as the breaker stays open — alerting
// on every refusal would spam. Emit ONLY on the closed→open edge per
// `${provider}:${model}` key; the edge re-arms when the resilience registry
// reports the key no longer open (cooldown/half-open recovery). Per-instance
// state (HA: each instance may emit once — documented, acceptable for an
// incident signal).
const breakerAlertedKeys = new Set<string>();
function notifyBreakerOpen(
  ctx: PotionContext,
  orgId: string,
  err: unknown,
  warn: (msg: string) => void,
): void {
  if (!(err instanceof ProviderError) || err.breakerOpen !== true) return;
  const key = `${err.provider}:${err.model ?? 'unknown'}`;
  // Re-arm keys the registry no longer reports open.
  const states = breakerStates();
  for (const k of breakerAlertedKeys) {
    if (states[k] !== 'open') breakerAlertedKeys.delete(k);
  }
  if (breakerAlertedKeys.has(key)) return;
  breakerAlertedKeys.add(key);
  emitAlert(ctx, {
    orgId,
    event: 'breaker_open',
    detail: { breaker: key, kind: err.kind, message: err.message },
  }).catch((e: unknown) => warn(`breaker_open alert emit failed — swallowed: ${(e as Error).message}`));
}
// ---- end M4 #33 breaker_open alerts ----

/** zod-validated OpenAI subset; unknown fields are stripped (ignored).
 * M3 #25: tools / tool_choice (function-calling passthrough — 'single'
 * strategy only, enforced below) and stream_options.include_usage. */
export const ChatCompletionsRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(ChatMessageSchema).min(1),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  max_tokens: z.number().int().positive().optional(),
  tools: z.array(ToolSchema).min(1).optional(),
  tool_choice: ToolChoiceSchema.optional(),
  stream_options: z.object({ include_usage: z.boolean().optional() }).optional(),
  // 2026-08-23: caller sampling/format parameters, forwarded on single-model
  // points (SamplingParamsSchema); response_format and stop pin the request
  // to single points the way tools do. `n` is accepted only as 1.
  n: z.number().int().min(1).max(1).optional(),
}).merge(SamplingParamsSchema);

export interface OperatingPoint {
  /** Why the fallback fired (2026-08-24, beta feedback): 'policy_infeasible'
   * = no measured point met the policy (e.g. the quality floor); the best
   * point served. Absent when fallback is 0. */
  fallbackReason?: 'no_frontier' | 'no_point_resolvable' | 'policy_infeasible';
  /** null = no strategy is resolvable for this server's mode (live server,
   * no non-mock price entry) — the caller REFUSES rather than serving mock
   * output on a live path (G2.4). */
  config: StrategyConfig | null;
  /** 1 when the policy was infeasible (or no frontier exists) and the
   * documented fallback fired. */
  fallback: 0 | 1;
  frontierVersion: number;
  frontier: Frontier | null;
  /**
   * G2.6 — set ONLY in the compound-policy latency-infeasible case: points
   * cleared the quality floor but none cleared the latency bound, so the
   * FASTEST quality-qualifying point was served and the SLO was knowingly
   * missed. Owner's rule: violate the customer-observable dimension
   * (latency), never the customer-invisible one (quality) — detecting quality
   * degradation is the product itself. Never silent: it rides the trace, the
   * DTO, the playground response, and a standing policy condition.
   */
  latencyViolation?: LatencyViolation;
  /**
   * Set ONLY when a request carried `tools` and the policy's optimum was a
   * prompt-transforming strategy, so selection was narrowed to single-model
   * points. Same discipline as latencyViolation: the substitution is real, so
   * it is labelled rather than hidden.
   *
   * Note what is and is not given up. Restricting to single points can never
   * BREACH a policy's stated bound — a quality floor still holds, a cost
   * ceiling still holds, a latency bound still holds, because the restricted
   * set is a subset of the qualifying set. It costs optimality only. That is
   * why `fallback` stays 0 when a single point still satisfies the policy:
   * the request genuinely was routed on measured evidence.
   */
  toolConstraint?: ToolConstraint;
}

/** The labelled consequence of tools forcing a single-model point. */
export interface ToolConstraint {
  /** The strategy type the policy would have selected without tools. */
  wouldHaveServedType: string;
  /** Its hash, so the substitution is auditable against the frontier. */
  wouldHaveServedHash: string;
}

/** The labeled consequence of an unmeetable latency bound (G2.6). */
export interface LatencyViolation {
  boundMs: number;
  qualityFloor: number;
  /** The p95 actually served — always > boundMs. */
  servedP95Ms: number;
  servedStrategyHash: string;
  /** Relax the bound to this and the policy is feasible on cost again. */
  relaxLatencyToMs: number | null;
  /** Or relax quality to this and the CURRENT bound is feasible. */
  relaxQualityToFloor: number | null;
}

/** Highest-quality point (tie → lower cost) — the documented NULL fallback. */
// Canonical home is @potion/core (select.ts) since M4b #37 — imported above
// and re-exported here for the dashboard route's existing import.
export { highestQualityPoint };

/**
 * selectPoint(policy) with the §8 NULL fallback applied.
 *
 * G2.4: `fallbackStrategy` is the LAST-RESORT config for this server's
 * provider mode — DEFAULT_STRATEGY (mock-mid) under mock, the designated
 * live default under live (fallbackStrategyFor in context.ts). It is null
 * only when a live server's price table has no non-mock entry; callers turn
 * that into an honest refusal instead of serving mock text as a live 200
 * (the fifth false-live instance, first on the serving path).
 */
export function resolveOperatingPoint(
  policy: Policy,
  frontier: Frontier | null,
  fallbackStrategy: StrategyConfig | null = DEFAULT_STRATEGY,
  opts: { toolCapableOnly?: boolean } = {},
): OperatingPoint {
  // TOOL-CAPABLE NARROWING. A request carrying `tools` cannot be served by a
  // strategy that rewrites or fans out the prompt — cascade/ensemble/
  // draft-verify transform what the model sees, and tool-call semantics
  // cannot be guaranteed through that. This used to be a hard 400, which
  // meant a customer whose policy happened to select a cascade discovered it
  // in production and had no route through: the refusal named the problem and
  // offered only "choose a different policy".
  //
  // Instead: resolve normally, and if the optimum is not single, re-resolve
  // over the single-only subset and LABEL the substitution. 41 of the 44
  // points on the committed platform frontier are single, so this almost
  // always finds a measured answer, and both last-resort fallbacks
  // (DEFAULT_STRATEGY, liveDefaultStrategy) are single by construction.
  if (opts.toolCapableOnly) {
    const unrestricted = resolveOperatingPoint(policy, frontier, fallbackStrategy);
    if (unrestricted.config === null) return unrestricted;
    if (unrestricted.config.type === 'single') return unrestricted;
    const unrestrictedPoint = frontier?.points.find((p) => p.strategyHash === strategyHash(unrestricted.config as StrategyConfig));
    if (strategyCapabilities(unrestricted.config).canServeTools && unrestrictedPoint?.evidence?.toolsMeasured === true) return unrestricted;
    // MIXING M3: a point may carry tools when its SHAPE can (strategyCapabilities)
    // and — for anything but a single model — it was MEASURED on items that
    // carried tools (evidence.toolsMeasured). Singles are trusted as before.
    const singles = frontier
      ? frontier.points.filter(
          (p) =>
            strategyCapabilities(p.strategyConfig).canServeTools &&
            (p.strategyConfig.type === 'single' || p.evidence?.toolsMeasured === true),
        )
      : [];
    const narrowed: Frontier | null =
      frontier && singles.length > 0 ? { ...frontier, points: singles } : null;
    const restricted = resolveOperatingPoint(policy, narrowed, fallbackStrategy);
    return {
      ...restricted,
      // A narrowed frontier still reports its real version; only an absent
      // one falls to 0, which resolveOperatingPoint already handles.
      toolConstraint: {
        wouldHaveServedType: unrestricted.config.type,
        wouldHaveServedHash: strategyHash(unrestricted.config),
      },
    };
  }
  if (!frontier || frontier.points.length === 0) {
    return { config: fallbackStrategy, fallback: 1, fallbackReason: 'no_frontier', frontierVersion: 0, frontier };
  }
  const selected = selectPoint(policy, frontier);
  if (selected) {
    return {
      config: selected.strategyConfig,
      fallback: 0,
      frontierVersion: frontier.version,
      frontier,
    };
  }
  // G2.6 case (ii) — LATENCY-side infeasibility on a compound policy. Points
  // clear the quality floor; none clear the bound. Serving the highest-quality
  // point (the generic fallback below) would ignore the SLO entirely; refusing
  // would break serving. So: serve the FASTEST point that still meets the
  // quality floor, and label the violation everywhere. Quality is never traded
  // away to meet latency — that is the one substitution the customer cannot
  // detect for themselves.
  //
  // Case (i), quality-side infeasibility, falls through to the existing
  // highest-quality fallback: no latency SLO is violated by serving the best
  // quality available, and blaming the bound would send the customer to relax
  // the wrong knob.
  if (policy.type === 'compound') {
    const fastest = fastestQualityQualifyingPoint(frontier.points, policy.qualityFloor);
    if (fastest) {
      const premium = latencyPremium(policy, frontier.points);
      return {
        config: fastest.strategyConfig,
        fallback: 1,
        frontierVersion: frontier.version,
        frontier,
        latencyViolation: {
          boundMs: policy.p95Ms,
          qualityFloor: policy.qualityFloor,
          servedP95Ms: fastest.latencyP95,
          servedStrategyHash: fastest.strategyHash,
          relaxLatencyToMs: premium.relaxLatencyToMs,
          relaxQualityToFloor: premium.relaxQualityToFloor,
        },
      };
    }
  }
  const best = highestQualityPoint(frontier.points);
  if (!best) {
    return { config: fallbackStrategy, fallback: 1, fallbackReason: 'no_point_resolvable', frontierVersion: frontier.version, frontier };
  }
  return { config: best.strategyConfig, fallback: 1, fallbackReason: 'policy_infeasible', frontierVersion: frontier.version, frontier };
}

/**
 * Serve-time provenance guard (ROADMAP M1a item 4): a simulated number may
 * never masquerade as live evidence.
 *
 * A frontier is TAINTED when any point's provider_mode is 'mock' or
 * 'unknown' (absent on the value object — pre-M1a rows). When the server
 * runs with live providers we REFUSE to serve from a tainted frontier: the
 * request falls back per the existing no-frontier rule (DEFAULT_STRATEGY,
 * frontier=v0, fallback=1) and the trace header carries provenance=blocked.
 * When running mock-only (dev), tainted frontiers serve with
 * provenance=mock. All-live frontiers always serve with provenance=live.
 */
export function guardFrontierProvenance(
  frontier: Frontier | null,
  serverMode: 'mock' | 'live',
  warn: (msg: string) => void = () => {},
): { frontier: Frontier | null; provenance: 'live' | 'mock' | 'blocked' } {
  if (!frontier || frontier.points.length === 0) {
    return { frontier, provenance: serverMode };
  }
  const tainted = frontier.points.some((p) => (p.providerMode ?? 'unknown') !== 'live');
  if (!tainted) return { frontier, provenance: 'live' };
  if (serverMode === 'live') {
    warn(
      `provenance guard: refusing to serve cluster '${frontier.clusterId}' from ` +
        `frontier v${frontier.version} — provider_mode mock/unknown under live providers ` +
        `(falling back to the no-frontier default)`,
    );
    return { frontier: null, provenance: 'blocked' };
  }
  return { frontier, provenance: 'mock' };
}

/**
 * What this request would have cost on the frontier's HIGHEST-QUALITY point —
 * the counterfactual behind any "money saved" claim (S3, migration 0039).
 *
 * "Saved versus what?" has to be answered honestly, and the honest answer is
 * the alternative the customer is actually choosing between: just always
 * using the best model. That is `highestQualityPoint`, which the serving path
 * already computes for the §8 NULL fallback.
 *
 * THE METHOD, and its one assumption. Frontier `costPer1K` is USD per 1000
 * requests measured over the eval suite — an AVERAGE, not this request. The
 * actual cost in the log is this request's REAL tokens. Comparing those two
 * directly would mix measurement bases and make savings scale with request
 * size in the wrong direction: a large request would look like a small
 * saving. So the baseline is the real cost scaled by the RATIO of the two
 * measured points, which shares a basis and cancels:
 *
 *     baseline = actualCost × (baseline.costPer1K / chosen.costPer1K)
 *
 * The assumption is that the cost ratio between two strategies does not
 * depend on request size — exactly true under pure per-token pricing, and
 * approximately true otherwise. It is recorded here rather than buried
 * because a savings number is a claim about money.
 *
 * Returns null — NOT zero — whenever the comparison is undefined: no
 * frontier (the fallback path), an unknown chosen point, or a zero-cost
 * denominator. Zero would enter a sum as "saved nothing"; null reads as
 * "not measured", which is what it is.
 */
export function baselineCostUsd(
  frontier: Frontier | null,
  chosenStrategyHash: string,
  actualCostUsd: number | undefined,
  baselineStrategyHash: string | null = null,
): number | null {
  if (!frontier || frontier.points.length === 0) return null;
  if (actualCostUsd === undefined || !Number.isFinite(actualCostUsd)) return null;
  const chosen = frontier.points.find((p) => p.strategyHash === chosenStrategyHash);
  // routing/baseline.ts: the org's designated or named incumbent when it is a
  // point on this frontier; the highest-quality point otherwise.
  const best =
    (baselineStrategyHash !== null
      ? frontier.points.find((p) => p.strategyHash === baselineStrategyHash)
      : undefined) ?? highestQualityPoint(frontier.points);
  if (!chosen || !best || !(chosen.costPer1K > 0)) return null;
  const scaled = actualCostUsd * (best.costPer1K / chosen.costPer1K);
  return Number.isFinite(scaled) ? scaled : null;
}

/** A public name for what a strategy runs — sent as the x-potion-model response
 * header next to the receipt (2026-08-22: an app could not tell which model
 * answered from the receipt alone; found by dogfooding). */
/**
 * An answer that is empty after the output budget was exhausted (2026-08-23,
 * found live: the extraction pick is a reasoning model that spends a
 * customer-sized max_tokens entirely on thinking — with or without JSON
 * mode — and returns nothing, while the frontier had measured it under the
 * harness's generous budget). The budget is the customer's contract, so the
 * request is served ONCE more on the next single point the policy admits
 * with the served point excluded; nothing else about the request changes.
 */
export function isEmptyAnswer(result: { text: string; toolCalls?: unknown[]; finishReason?: string; usage: { outputTokens: number } }, maxOutputTokens: number | undefined): boolean {
  if (result.text.trim() !== '' || (result.toolCalls && result.toolCalls.length > 0)) return false;
  if (result.finishReason === 'length') return true;
  return maxOutputTokens !== undefined && result.usage.outputTokens >= maxOutputTokens;
}

export function nextPointExcluding(
  policy: Policy,
  frontier: Frontier | null,
  servedHash: string,
  fallbackStrategy: StrategyConfig | null,
  opts: { toolCapableOnly?: boolean; maxOutputTokens?: number | undefined },
): OperatingPoint | null {
  if (!frontier) return null;
  const rest = {
    ...frontier,
    points: frontier.points.filter(
      (p) =>
        p.strategyHash !== servedHash &&
        p.strategyConfig.type === 'single' &&
        !tooSmallForReasoning(p.strategyConfig.model, opts.maxOutputTokens),
    ),
  };
  if (rest.points.length === 0) return null;
  const op = resolveOperatingPoint(policy, rest, fallbackStrategy, opts);
  if (op.config === null || op.fallback === 1 || strategyHash(op.config) === servedHash) return null;
  return op;
}

export function strategyModelLabel(cfg: { type: string; model?: string }): string {
  return cfg.type === 'single' ? (cfg.model ?? 'single') : `combination:${cfg.type}`;
}

/** SPEC §8 trace header (semicolon-separated, no spaces), plus the M1a
 * provenance marker: provenance=live|mock|blocked. */
export function traceHeaderValue(op: {
  clusterId: string;
  strategyHash8: string;
  frontierVersion: number;
  policyType: string;
  fallback: 0 | 1;
  provenance: 'live' | 'mock' | 'blocked';
  /** Present only when tools narrowed selection — see ToolConstraint. */
  constrained?: 'tools';
}): string {
  return (
    `cluster=${op.clusterId};strategy=${op.strategyHash8};` +
    `frontier=v${op.frontierVersion};policy=${op.policyType};fallback=${op.fallback};` +
    `provenance=${op.provenance}` +
    // Appended only when it actually fired, so ordinary traffic's trace is
    // byte-identical to before this change.
    (op.constrained ? `;constrained=${op.constrained}` : '')
  );
}

/** The routing decision as recorded, read back out of a trace string. */
export interface ParsedTrace {
  clusterId: string | null;
  strategyHash8: string | null;
  frontierVersion: number | null;
  policyType: string | null;
  /** null when the token is absent or unrecognised — never silently 0. */
  fallback: 0 | 1 | null;
  /** 'tools' when tools narrowed selection to a single-model point. */
  constrained: 'tools' | null;
  provenance: 'live' | 'mock' | 'blocked' | null;
  /** Every other token verbatim (upgraded, policy_override, latency fields). */
  extra: Record<string, string>;
}

/**
 * Inverse of `traceHeaderValue`, over the string persisted on
 * `request_logs.trace` — which is byte-identical to the `x-frontier-trace`
 * header the caller received, so reading it back is quoting what we told
 * them, not re-deriving it.
 *
 * Every field is nullable on purpose. A missing or unrecognised token means
 * "we do not know", and the surfaces above treat that as unproven rather than
 * defaulting it to the reassuring value: `fallback: null` must never render
 * as routed. Rows that predate a token, and the non-serving rows that carry
 * no trace at all, are exactly the cases that would otherwise be flattered.
 */
export function parseTraceHeader(trace: string | null | undefined): ParsedTrace {
  const out: ParsedTrace = {
    clusterId: null,
    strategyHash8: null,
    frontierVersion: null,
    policyType: null,
    fallback: null,
    constrained: null,
    provenance: null,
    extra: {},
  };
  if (!trace) return out;
  for (const part of trace.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    switch (key) {
      case 'cluster':
        out.clusterId = value;
        break;
      case 'strategy':
        out.strategyHash8 = value;
        break;
      case 'frontier': {
        const n = Number(value.replace(/^v/, ''));
        out.frontierVersion = Number.isFinite(n) ? n : null;
        break;
      }
      case 'policy':
        out.policyType = value;
        break;
      case 'constrained':
        out.constrained = value === 'tools' ? 'tools' : null;
        break;
      case 'fallback':
        out.fallback = value === '0' ? 0 : value === '1' ? 1 : null;
        break;
      case 'provenance':
        out.provenance =
          value === 'live' || value === 'mock' || value === 'blocked' ? value : null;
        break;
      default:
        out.extra[key] = value;
    }
  }
  return out;
}

/**
 * Did the auto-switch actually do work on this request?
 *
 * Both halves are required and neither is inferable from the other: a real
 * frontier had to exist (`frontier=v<n>`, n>0) AND the policy had to select a
 * point from it (`fallback=0`). A request can carry a frontier version and
 * still be a fallback — no point satisfied the policy — and that is precisely
 * the case a one-field check would report as routed. Unknown ⇒ false.
 */
export function traceWasRouted(t: ParsedTrace): boolean {
  return t.fallback === 0 && t.frontierVersion !== null && t.frontierVersion > 0;
}

/** OpenAI streaming tool_calls delta (M3 #25): the wire format carries an
 * `index` per tool call inside the delta. */
interface SseToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
}

interface SseChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: 0;
    delta: { role?: 'assistant'; content?: string; tool_calls?: SseToolCallDelta[] };
    finish_reason: 'stop' | 'length' | 'tool_calls' | null;
  }>;
}

function sseChunk(
  base: { id: string; created: number; model: string },
  delta: { role?: 'assistant'; content?: string; tool_calls?: SseToolCallDelta[] },
  finishReason: 'stop' | 'length' | 'tool_calls' | null = null,
): SseChunk {
  return {
    id: base.id,
    object: 'chat.completion.chunk',
    created: base.created,
    model: base.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

/** Final usage-only chunk (M3 #25): emitted when the request sets
 * stream_options.include_usage — choices is EMPTY per the OpenAI spec. */
function sseUsageChunk(
  base: { id: string; created: number; model: string },
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
): {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: [];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
} {
  return {
    id: base.id,
    object: 'chat.completion.chunk',
    created: base.created,
    model: base.model,
    choices: [],
    usage,
  };
}

/** Convert provider-verbatim ToolCalls to the streaming delta wire shape. */
function toolCallDeltas(toolCalls: ToolCall[]): SseToolCallDelta[] {
  return toolCalls.map((tc, index) => ({
    index,
    id: tc.id,
    type: 'function' as const,
    function: { name: tc.function.name, arguments: tc.function.arguments },
  }));
}

export function registerChatRoutes(app: FastifyInstance, ctx: PotionContext): void {
  const logRequest = async (fields: NewRequestLog): Promise<void> => {
    try {
      await insertRequestLog(ctx.db.db, fields);
    } catch (err) {
      app.log.warn(err, 'request_logs insert failed');
    }
  };

  app.post('/v1/chat/completions', async (req, reply) => {
    const t0 = performance.now();
    const elapsed = (): number => Math.round((performance.now() - t0) * 100) / 100;

    // ---- 1. validate (unknown fields ignored) ----
    const parsed = ChatCompletionsRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      await logRequest({
        // request_logs.org_id is NOT NULL (M2 #13); a request that failed
        // validation BEFORE auth has no tenant, so unattributed traffic is
        // recorded under the default org.
        orgId: DEFAULT_ORG_ID,
        model: null,
        status: 'invalid_request',
        latencyMs: elapsed(),
        trace: null,
      });
      return reply
        .code(400)
        .send(openAiError(message, 'invalid_request_error', 'invalid_request_error'));
    }
    const body = parsed.data;
    // Wire messages → internal text messages (content-part arrays flattened;
    // tool_calls / tool results carried verbatim). Images are refused with a
    // precise message until a vision frontier exists — never silently dropped.
    const flattened = body.messages.map(flattenWireMessage);
    const imageParts = flattened.reduce((n, f) => n + f.images, 0);
    const audioParts = flattened.reduce((n, f) => n + f.audio, 0);
    // G (2026-08-23): image-carrying requests are served only from a
    // cluster's frontier MEASURED ON VISION (instrument 'vision') — the
    // refusal moves below, after the cluster is known, so it can say which
    // frontier is missing. Classification reads the text view; the images
    // never enter it, nor the learning sampler.
    const messages: ChatMessage[] = flattened.map((f) => f.message);
    const execMaxOutputTokens = body.max_tokens !== undefined ? resolveMaxOutputTokens(body.max_tokens) : undefined;
    // Pre-auth log fields: unattributed → default org (see above). Replaced
    // with the authenticated org as soon as the key resolves.
    // Flywheel (0055): the content-free shape is derivable only NOW (content
    // is not retained), and the signals array is shared BY REFERENCE across
    // every {...logBase} spread — pushes later in the request are visible to
    // whichever insert runs. [] on a completed request = recorded silence.
    const implicitSignals: string[] = [];
    const logBase: NewRequestLog = {
      orgId: DEFAULT_ORG_ID,
      model: body.model,
      taskShape: { ...taskShapeOf(body) },
      implicitSignals,
    };

    // ---- 2. auth: Bearer → api_keys row → its policy ----
    const auth = await authenticate(ctx.db.db, bearerToken(req.headers.authorization));
    if (!auth) {
      await logRequest({ ...logBase, status: 'auth_failed', latencyMs: elapsed() });
      return reply
        .code(401)
        .send(openAiError('missing or invalid api key', 'invalid_request_error', 'invalid_api_key'));
    }
    logBase.apiKeyId = auth.key.id;
    logBase.orgId = auth.org.orgId; // tenant scope (M2 #13)
    // Flywheel (0056): salted with the REAL org id, so these exist only for
    // authenticated traffic and link nothing across tenants.
    logBase.promptFp = promptFingerprint(auth.org.orgId, body);
    logBase.sessionFp = sessionFingerprint(auth.org.orgId, (body as { user?: unknown }).user);

    // ---- least-surprise model semantics (external review, 2026-08-25) ----
    // 'potion-auto' routes. A known model name PINS to exactly that model —
    // applications use `model` for entitlements, eval conditions, and
    // explicit choices, and silently rerouting a named model violates least
    // surprise. An unknown name is a 400, never a silent reroute. Orgs
    // migrating a label-blind app opt into route-all-models explicitly
    // (Settings · Controls, migration 0058); the recommended path
    // ('potion-auto') never pays the org-row read below.
    let pinnedModel: string | null = null;
    if (body.model !== 'potion-auto') {
      const entry = ctx.prices.entries.find((e) => e.alias === body.model || e.model === body.model);
      const orgRow = await getOrgById(ctx.db.db, auth.org.orgId);
      const routeAll = orgRow?.routeAllModels === true;
      if (!routeAll) {
        if (entry) {
          pinnedModel = entry.alias;
        } else {
          await logRequest({ ...logBase, status: 'unknown_model', latencyMs: elapsed() });
          return reply.code(400).send(
            openAiError(
              `unknown model '${body.model}' — use 'potion-auto' to route by measurement, name a model from /v1/models to pin it, or enable route-all-models in Settings·Controls for label-blind routing`,
              'invalid_request_error',
              'unknown_model',
              'model',
            ),
          );
        }
      }
    }
    // ---- M4 #35 budget autopilot (m4-alerts-budget) ----
    // Hard-stop (SPEC §13.7): BEFORE any strategy work, if the org's budget
    // has hard_stop=true and MTD spend ≥ cap → 429 OpenAI-shaped
    // budget_exceeded. Soft caps NEVER block. The check is cached 60s/org
    // and fails OPEN on db errors (availability; see routes/budgets.ts).
    // The refusal is also an ALERT event — deduped per (org, kind, UTC day)
    // through the budget_events ledger, then alerts:dispatch.
    // F6: the block now lives in routes/budgets.ts so EVERY spend-bearing
    // route runs the same guard — it was inline here, and only here, which
    // is why /v1/completions and /v1/embeddings served past an exceeded cap.
    if (
      await enforceBudgetHardStop(ctx, auth.org.orgId, reply, logBase, {
        latencyMs: elapsed(),
        onError: (err, msg) => app.log.warn(err, msg),
      })
    ) {
      return reply;
    }
    if (!auth.policy) {
      await logRequest({ ...logBase, status: 'no_policy', latencyMs: elapsed() });
      return reply
        .code(403)
        .send(
          openAiError(
            'api key has no policy bound — POST /v1/policies first',
            'invalid_request_error',
            'no_policy_bound',
          ),
        );
    }
    // ---- M4 #30 policy override (m4-sdks) ----
    // X-Potion-Policy: <policyId | policyName> — per-request policy override
    // (SPEC §13.1), resolved within the caller's org (a ref that only exists
    // in another org is NOT FOUND — no cross-org existence oracle). The api
    // key's bound policy remains the default when the header is absent. An
    // unknown ref is a client error: OpenAI-shaped 400
    // invalid_request_error/policy_not_found with param echoing the header
    // name. The resolution is recorded in request_logs.policy_id (the bound
    // policy id by default, the override row id when overridden) and echoed
    // on x-frontier-trace: policy=<type> always reflects the ACTIVE policy
    // (override included); an override additionally appends
    // `;policy_override=<name>` so the name flows to the client (SDKs parse
    // it into frontier_trace).
    let policy = auth.policy;
    let policyId: string | null = auth.policyId;
    let policyOverrideName: string | null = null;
    const overrideHeader = req.headers['x-potion-policy'];
    const overrideRef = Array.isArray(overrideHeader) ? overrideHeader[0] : overrideHeader;
    if (overrideRef !== undefined && overrideRef.trim() !== '') {
      const overrideRow = await resolvePolicyRef(ctx.db.db, auth.org.orgId, overrideRef.trim());
      if (!overrideRow) {
        await logRequest({ ...logBase, status: 'policy_not_found', latencyMs: elapsed() });
        return reply
          .code(400)
          .send({
            error: {
              ...openAiError(
                `unknown policy '${overrideRef.trim()}' — no policy with that id or name exists in your org`,
                'invalid_request_error',
                'policy_not_found',
                'X-Potion-Policy',
              ).error,
              // Beta feedback (2026-08-24): say what IS valid and what the
              // safe default is, instead of leaving the caller to guess.
              hint: 'omit the x-potion-policy header to use the policy bound to this key',
              available_policies: (await listPolicies(ctx.db.db, auth.org.orgId)).map((pl) => ({ id: pl.id, name: pl.name })),
            },
          });
      }
      policy = overrideRow.config;
      policyId = overrideRow.id;
      policyOverrideName = overrideRow.name;
    }
    logBase.policyType = policy.type;
    logBase.policyId = policyId;
    // ---- end M4 #30 policy override ----

    // ---- M5 #36 X-Potion-Cluster hint (SPEC §14.2): agent workloads may
    // pin their cluster explicitly (e.g. X-Potion-Cluster: agent-<slug>)
    // instead of relying on content embedding. Unknown cluster → 400, same
    // contract as X-Potion-Policy: an explicit request is rejected
    // explicitly, never silently re-routed. ----
    const clusterHeader = req.headers['x-potion-cluster'];
    const clusterHintRaw = Array.isArray(clusterHeader) ? clusterHeader[0] : clusterHeader;
    let hintedClusterId: string | null = null;
    if (clusterHintRaw !== undefined && clusterHintRaw.trim() !== '') {
      // G1.2: ownership-checked — platform clusters resolve for everyone,
      // tenant clusters only for their owner. Cross-org ids get the SAME
      // 400 as unknown ids (never a 403 existence oracle).
      const hint = clusterHintRaw.trim();
      // A hint names a kind of work. It is valid if the org (or the platform)
      // has a cluster row by that id — OR if a platform frontier exists for
      // it, which is what routing actually serves from. Production never
      // seeds cluster rows from the taxonomy, so without the second test the
      // documented header 400'd for every customer (found 2026-08-22 by
      // using the product ourselves).
      const clusterRow =
        (await getClusterByIdForOrg(ctx.db.db, hint, auth.org.orgId)) ??
        ((await getLatestFrontier(ctx.db.db, hint, null)) ? { id: hint } : null);
      if (!clusterRow) {
        await logRequest({ ...logBase, status: 'cluster_not_found', latencyMs: elapsed() });
        return reply
          .code(400)
          .send(
            openAiError(
              `unknown cluster '${clusterHintRaw.trim()}' — no cluster with that id exists`,
              'invalid_request_error',
              'cluster_not_found',
              'X-Potion-Cluster',
            ),
          );
      }
      hintedClusterId = clusterRow.id;
    }
    // ---- end M5 #36 cluster hint ----

    // ---- 3. cluster assign (<30ms target; cached by content hash) ----
    let clusterId: string;
    // Hoisted: the demand observation below needs the ranking, and a hinted
    // request has none — `undefined` there means "the customer told us",
    // which is a different fact from a weak match.
    let ranked: RankedAssignment | undefined;
    let tClassifyMs: number | null = null;
    if (hintedClusterId !== null) {
      // M5 #36: hint wins; the embedder/assigner is skipped entirely.
      clusterId = hintedClusterId;
    } else {
      const userContents = messages.filter((m) => m.role === 'user').map((m) => m.content);
      const contents = userContents.length > 0 ? userContents : messages.map((m) => m.content);
      const cacheKey = assignmentCacheKey(contents);
      ranked = ctx.assignCache.get(cacheKey);
      const tClassify0 = performance.now();
      if (!ranked) {
        // S7 L1: assignRanked, not assign — ONE embedding, and it returns the
        // per-cluster cosines pickBest already computed instead of throwing
        // all but one away. The decision is unchanged (same threshold, same
        // 'general' fallback); what is new is that the row can now say how
        // well this request fit anything we have measured.
        ranked = await ctx.assigner.assignRanked(contents.join('\n'));
        ctx.assignCache.set(cacheKey, ranked);
        // Item C (2026-08-23): the classifier's real cost on the critical
        // path, measured in the request instead of probed from outside — a
        // probe conflated it with the routed model's own speed.
        tClassifyMs = Math.round(performance.now() - tClassify0);
      }
      clusterId = ranked.assignment.clusterId;
      logBase.clusterConfidence = ranked.assignment.confidence;
      // The runner-up is read from the RANKING, not from the decision: when
      // the decision fell back to 'general' the best match is still the most
      // informative thing we know about the request.
      const runnerUp = ranked.ranking.find((r) => r.clusterId !== clusterId);
      if (runnerUp !== undefined) {
        logBase.runnerUpCluster = runnerUp.clusterId;
        logBase.clusterMargin =
          Math.round((ranked.assignment.confidence - runnerUp.confidence) * 1e6) / 1e6;
      }
    }
    logBase.clusterId = clusterId;
    // Content-free request structure (S7 L1). Recorded for hinted clusters
    // too — the hint skips classification, not the shape, and agent traffic
    // is the most tool-carrying traffic there is.
    const shape = requestShape({ ...body, messages });
    logBase.shape = shape;

    // ---- S7 L2: contribute to the demand aggregate ----
    // In-process only: a Map update, no query, no write. What leaves this
    // process is a SUM over many requests from many orgs, and only once the
    // k-gate opens (repos/demand.ts). An opted-out org is skipped HERE, so
    // its traffic never enters an accumulator at all.
    if (ctx.demandEnabled && !ctx.demandOptOut.has(auth.org.orgId)) {
      // An unassigned request is bucketed by its embedding's LSH label, not
      // by 'general' — 'general' is where every unlike thing piles up, and
      // the whole point is to tell those things apart. A hinted cluster has
      // no embedding and is counted under its own id with no centroid.
      const bucket =
        ranked !== undefined && ranked.fellBack ? lshBucket(ranked.embedding) : clusterId;
      ctx.demand.observe({
        bucket,
        shapeClass: shapeClass(shape),
        at: new Date(),
        orgId: auth.org.orgId,
        // Absent for a hinted request: nothing measured the fit, and a 1.0
        // would be a fabricated certainty inside the cell's mean.
        ...(ranked !== undefined ? { confidence: ranked.assignment.confidence } : {}),
        ...(ranked !== undefined ? { embedding: ranked.embedding } : {}),
      });
    }

    // ---- 4. frontier → provenance guard → selectPoint(policy) → NULL fallback ----
    // G1.6 retracts the old "NEVER org-scoped" contract: the read is
    // org-PREFERRED with platform fallback — an org's agent frontier serves
    // its own traffic; everyone else (and every platform cluster) gets the
    // shared platform frontier. NOTE: the assignment LRU (context.ts) stays
    // content-keyed — safe ONLY while cluster ASSIGNMENT remains platform
    // taxonomy; revisit if assignment ever considers org clusters.
    // One resolution per candidate cluster: frontier → provenance guard →
    // serving-latency binding → operating point under the org's policy.
    const resolveFor = async (cid: string) => {
      const clusterPolicy = policyForCluster(policy, cid);
      // MIXING M3: a tool-carrying request consults the cluster's frontier
      // measured ON TOOL USE when one exists (instrument 'tools'); otherwise
      // the default frontier, narrowed to points that can carry tools below.
      const modalFrontier =
        audioParts > 0
          ? await loadCurrentFrontier(ctx.db.db, cid, auth.org.orgId, 'audio')
          : imageParts > 0
            ? await loadCurrentFrontier(ctx.db.db, cid, auth.org.orgId, 'vision')
            : body.tools !== undefined
              ? await loadCurrentFrontier(ctx.db.db, cid, auth.org.orgId, 'tools')
              : null;
      if ((audioParts > 0 || imageParts > 0) && (modalFrontier === null || modalFrontier.points.length === 0)) return null;
      const loaded =
        modalFrontier !== null && modalFrontier.points.length > 0
          ? modalFrontier
          : await loadCurrentFrontier(ctx.db.db, cid, auth.org.orgId);
      const guarded = guardFrontierProvenance(loaded, ctx.providerMode, (msg) => app.log.warn(msg));
      const bound = await bindServingLatency(
        ctx,
        clusterPolicy,
        guarded.frontier,
        auth.org.orgId,
        cid,
        (msg) => app.log.warn(msg),
      );
      const point = resolveOperatingPoint(
        clusterPolicy,
        bound.frontier,
        fallbackStrategyFor(ctx.providerMode, ctx.prices),
        { toolCapableOnly: body.tools !== undefined || body.response_format !== undefined || body.stop !== undefined },
      );
      const served =
        point.config === null
          ? null
          : ((bound.frontier?.points ?? guarded.frontier?.points ?? []).find(
              (pt) => pt.strategyHash === strategyHash(point.config as StrategyConfig),
            ) ?? null);
      return { clusterId: cid, ...guarded, latency: bound, op: point, served, servedInstrument: (loaded?.instrument ?? 'default') as 'default' | 'tools' | 'vision' | 'audio' };
    };
    let chosen = await resolveFor(clusterId);
    if (chosen === null) {
      await logRequest({ ...logBase, status: 'unsupported_content', latencyMs: elapsed() });
      return reply
        .code(400)
        .send(
          openAiError(
            audioParts > 0
              ? `audio inputs need a measured audio frontier and '${clusterId}' has none yet (${audioParts} audio part${audioParts === 1 ? '' : 's'}); send text for now`
              : `image inputs need a measured vision frontier and '${clusterId}' has none yet (${imageParts} image part${imageParts === 1 ? '' : 's'}); send text, or route vision traffic directly to a vision model for now`,
            'invalid_request_error',
            'unsupported_content',
            'messages',
          ),
        );
    }
    // Quality-safe tiebreak (routing/ambiguity.ts): a near-equal runner-up is
    // resolved too, and the pair is served under the higher measured quality.
    const runnerUpId = ranked !== undefined ? ambiguousRunnerUp(ranked, ambiguityMargin()) : null;
    if (runnerUpId !== null) {
      const other = await resolveFor(runnerUpId);
      if (other !== null) {
      const asCandidate = (r: NonNullable<typeof chosen>) => ({
        ...r,
        quality: r.served?.quality ?? null,
        costPer1K: r.served?.costPer1K ?? null,
      });
      const winner = pickSafer(asCandidate(chosen), asCandidate(other));
      logBase.clusterTiebreak = winner.clusterId !== clusterId;
      if (winner.clusterId !== clusterId) {
        clusterId = winner.clusterId;
        logBase.clusterId = clusterId;
        chosen = other;
      }
      }
    }
    const { frontier, provenance, latency } = chosen;
    let op = chosen.op;
    if (op.fallbackReason !== undefined) implicitSignals.push(`fallback_${op.fallbackReason}`);
    // A known reasoning model under a small output budget is skipped BEFORE
    // the call (routing/reasoning.ts); the trace says so.
    let skippedReasoning: string | null = null;
    if (op.config?.type === 'single' && tooSmallForReasoning(op.config.model, execMaxOutputTokens)) {
      const next = nextPointExcluding(policy, op.frontier, strategyHash(op.config), fallbackStrategyFor(ctx.providerMode, ctx.prices), { toolCapableOnly: body.tools !== undefined || body.response_format !== undefined || body.stop !== undefined, maxOutputTokens: execMaxOutputTokens });
      if (next?.config) { skippedReasoning = strategyModelLabel(op.config); op = next; }
    }
    try {
      const guaranteeOverride = await resolveGuaranteeOverride(
        ctx,
        auth.org.orgId,
        clusterId,
        frontier,
        (msg) => app.log.warn(msg),
      );
      if (guaranteeOverride) op = { ...op, config: guaranteeOverride };
    } catch (err) {
      app.log.warn(err, 'guarantee override lookup failed — serving the policy-resolved point');
    }
    // ---- end M3 #22 guarantee override ----
    if (pinnedModel !== null) {
      // The customer named the model; nothing (guarantee override, reasoning
      // skip, policy) outranks an explicit pin. fallback=0: this IS the ask.
      op = { ...op, config: { type: 'single', model: pinnedModel }, fallback: 0 as const };
    }
    const sh = strategyHash(op.config);
    logBase.strategyHash = sh;
    const servedInstrument = chosen.servedInstrument !== 'default' ? chosen.servedInstrument : null;
    if (skippedReasoning !== null) app.log.warn({ orgId: auth.org.orgId, clusterId, skipped: skippedReasoning, served: strategyModelLabel(op.config as { type: string; model?: string }), maxOutputTokens: execMaxOutputTokens }, 'reasoning model skipped under a small output budget');
    const baseline = await baselineFor(ctx.db.db, auth.org.orgId, clusterId, op.frontier);
    logBase.frontierVersion = op.frontierVersion;
    const trace =
      traceHeaderValue({
        clusterId,
        strategyHash8: sh.slice(0, 8),
        frontierVersion: op.frontierVersion,
        policyType: pinnedModel !== null ? 'pinned' : policy.type,
        fallback: op.fallback,
        provenance,
        ...(op.toolConstraint ? { constrained: 'tools' as const } : {}),
      }) +
      (servedInstrument !== null ? `;instrument=${servedInstrument}` : '') +
      (policyOverrideName !== null ? `;policy_override=${policyOverrideName}` : '') +
      latencyTraceFields(policy, latency, op.latencyViolation !== undefined);
    logBase.trace = trace;
    void reply.header('x-frontier-trace', trace);
    // Item C: stage timing in its own header — the trace string is a pinned contract.
    if (tClassifyMs !== null) void reply.header('x-potion-timing', `classify=${tClassifyMs}`);
    void reply.header('x-potion-model', strategyModelLabel(op.config as { type: string; model?: string }));
    // G2.6: the standing policy-level condition. Deduped in the repo, so it
    // is safe per-request; the alert fires once per episode, on the raise.
    void maintainPolicyCondition(
      ctx,
      {
        orgId: auth.org.orgId,
        policyId: auth.policyId ?? null,
        clusterId,
        policy,
        binding: latency,
        violation: op.latencyViolation,
        emit: (_created, detail) => {
          void emitAlert(ctx, {
            orgId: auth.org.orgId,
            event: 'policy_infeasible',
            detail,
          }).catch((e: unknown) =>
            app.log.warn(`policy_infeasible alert emit failed — swallowed: ${String(e)}`),
          );
        },
      },
      (msg) => app.log.warn(msg),
    );
    // ---- M3 #26 observability (m3-observability) ----
    // One frontier-decision observation per served request, next to where
    // the trace header is built (same inputs).
    ctx.observability?.meter.observeFrontierDecision({
      clusterId,
      strategyHash: sh,
      fallback: op.fallback === 1,
      provenance,
    });
    // ---- end M3 #26 observability ----

    // ---- M3 #21 shadow (m3-shadow) — sampling decision ----
    // Policies with a shadow config (SPEC §12.4): decide per-request whether
    // this request is shadow-sampled. The decision happens BEFORE execution
    // so the observeShadow metric sees BOTH outcomes for every shadow-policy
    // request; the shadow run itself fires AFTER the response is sent
    // (5a/5b below) and never touches the primary latency path.
    const shadowCfg = policy.shadow ?? null;
    const shadowSampled = shadowCfg !== null && shouldSample(shadowCfg);
    if (shadowCfg) {
      ctx.observability?.meter.observeShadow?.({ clusterId, sampled: shadowSampled });
    }
    // ---- end M3 #21 shadow sampling ----

    // ---- M3 #22 guarantee (m3-guarantee) — sampling decision ----
    // Policies with a guarantee config (SPEC §12.5): per-request decision on
    // whether this request's SERVED answer gets quality-scored. The sample
    // itself runs AFTER the response is sent (5a/5b below, next to the
    // shadow trigger) and never touches the primary latency path.
    const guaranteeCfg = policy.guarantee ?? null;
    const guaranteeSampled = guaranteeCfg !== null && shouldSampleGuarantee(guaranteeCfg);
    // ---- end M3 #22 guarantee sampling ----

    // ---- 4b. M3 #25 tool-calling passthrough gate ----
    // tools/tool_choice are forwarded UNMODIFIED to the provider — but ONLY
    // through the 'single' strategy: composite strategies transform prompts
    // (fan-out, judges, decomposers) and cannot guarantee tool semantics, so
    // a tool request routed to one is a client-visible 400, not a silent
    // degradation. tool_choice without tools is meaningless (OpenAI 400s too).
    // G2.4 (fifth false-live instance, serving path): a LIVE server with no
    // resolvable live strategy refuses honestly rather than falling back to
    // a mock alias and returning mock text as a live 200. Reaching here
    // means the price table carries no non-mock entry — a deployment fault,
    // not a customer error.
    if (op.config === null) {
      await logRequest({ ...logBase, status: 'error', latencyMs: elapsed() });
      return reply
        .code(503)
        .send(
          openAiError(
            'no live strategy is resolvable for this cluster — the price table has no non-mock ' +
              'entry, and a live server never serves mock output',
            'service_unavailable',
            'service_unavailable',
          ),
        );
    }
    if (body.tool_choice !== undefined && body.tools === undefined) {
      await logRequest({ ...logBase, status: 'invalid_request', latencyMs: elapsed() });
      return reply
        .code(400)
        .send(
          openAiError(
            "'tool_choice' requires 'tools' to be set",
            'invalid_request_error',
            'invalid_request_error',
            'tool_choice',
          ),
        );
    }
    // FAIL-CLOSED BACKSTOP. Selection above already narrows to single-model
    // points when tools are present, and both last-resort fallbacks are single
    // by construction — so reaching here means a guarantee rollback override
    // (below) swapped in a transforming strategy after selection. Serving
    // tools through one would silently drop them, which is the failure this
    // guard exists to prevent. It is no longer the ordinary path: a customer
    // whose policy prefers a cascade now gets the best measured SINGLE point
    // instead of a 400.
    if (body.tools !== undefined && op.config.type !== 'single') {
      await logRequest({ ...logBase, status: 'invalid_request', latencyMs: elapsed() });
      return reply
        .code(400)
        .send(
          openAiError(
            `tools/tool_choice cannot be served by a '${op.config.type}' strategy, which ` +
              `transforms prompts and cannot guarantee tool semantics. The operating point ` +
              `was overridden after selection (guarantee rollback) — resolve the incident ` +
              `or send this request without tools`,
            'invalid_request_error',
            'invalid_request_error',
            'tools',
          ),
        );
    }

    const id = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    // The learning period's sampler (consent-gated, capped per kind of work,
    // PII-redacted; never throws into the served response). Called after a
    // successful completion on every path, fire-and-forget.
    const keepSample = (text: string, cfg: { type: string; model?: string }, usage: { costUsd?: number } | undefined, cluster: string) => {
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      const prompt = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content ?? '');
      void maybeKeepLearningSample(ctx.db.db, {
        orgId: auth.org.orgId,
        requestId: id,
        clusterId: cluster,
        model: cfg.type === 'single' ? (cfg.model ?? null) : `combination:${cfg.type}`,
        prompt,
        completion: text,
        costUsd: usage?.costUsd ?? 0,
        usage: (usage ?? {}) as Record<string, unknown>,
      }, () => {
        // enough of this kind of work sampled: measure now, not at the next tick
        ctx.queue?.enqueue('learning:period', { orgId: auth.org.orgId }).catch(() => undefined);
      });
    };
    // G2.1: the completion id becomes the request log's correlation label —
    // every ok/error row from here down joins quality_samples.request_id
    // (quality meets spend/latency). Pre-generation failures stay NULL.
    logBase.completionId = id;
    const created = Math.floor(Date.now() / 1000);
    // BYOK serving path (M2 Wave 2, ROADMAP #16): resolve the provider set
    // for the request's ORG — an org with active provider keys is served by
    // providers built from its DECRYPTED keys (decrypts audited in
    // custody_audit, cached 60s per org); everyone else gets the platform
    // boot set. Platform env keys remain the per-provider fallback.
    const orgProviders = await ctx.providersForOrg(auth.org.orgId);
    // S3 (billing truth): WHO PAID, recorded at the one place it is known.
    // Set here rather than earlier on purpose — rows logged before this line
    // never reached execution (auth failures, budget refusals, unknown
    // policy) and cost nobody anything, so they correctly keep paid_by NULL.
    logBase.paidBy = orgProviders.byok ? 'byok' : 'platform';
    let emptyAnswerRetry = false;
    // Caller sampling/format parameters (only the ones set), OpenAI names.
    const sampling: SamplingParams = {};
    for (const k of ['temperature', 'top_p', 'stop', 'seed', 'user', 'response_format', 'parallel_tool_calls'] as const) {
      if (body[k] !== undefined) (sampling as Record<string, unknown>)[k] = body[k];
    }
    const execBase = {
      providers: orgProviders.providers,
      prices: ctx.prices,
      resolve: orgProviders.resolve,
      // `max_tokens` is the caller's bound on answer length and therefore on
      // cost. Found ignored on 2026-08-22 by using the product ourselves
      // (50 → 805 tokens): the schema accepted it and nothing threaded it.
      ...(body.max_tokens !== undefined ? { maxOutputTokens: resolveMaxOutputTokens(body.max_tokens) } : {}),
      ...(body.tools !== undefined
        ? {
            params: {
              tools: body.tools,
              ...(body.tool_choice !== undefined ? { toolChoice: body.tool_choice } : {}),
            },
          }
        : {}),
      ...(Object.keys(sampling).length > 0 ? { sampling } : {}),
    };
    const wantStream = body.stream === true;
    const includeUsage = body.stream_options?.include_usage === true;

    // ---- 5a. SSE path: stream:true + single strategy ----
    if (wantStream && op.config.type === 'single') {
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-frontier-trace': trace,
        'x-potion-model': strategyModelLabel(op.config as { type: string; model?: string }),
        // M3 #26 observability: echo the request id (hijacked responses
        // bypass the plugin's onSend hook).
        'x-request-id': req.id,
      });
      const base = { id, created, model: body.model };
      const writeData = (obj: unknown): void => {
        reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`);
      };
      writeData(sseChunk(base, { role: 'assistant' }));
      let result;
      try {
        const sseCtx = {
          ...execBase,
          stream: (token: string) => writeData(sseChunk(base, { content: token })),
        };
        result = await execute(op.config, messages, sseCtx);
        if (op.config.type === 'single') learnFromAnswer(op.config.model, result, execBase.maxOutputTokens);
        if (op.config.type === 'single' && isEmptyAnswer(result, execBase.maxOutputTokens)) {
          const next = nextPointExcluding(policy, op.frontier, sh, fallbackStrategyFor(ctx.providerMode, ctx.prices), { toolCapableOnly: body.tools !== undefined || body.response_format !== undefined || body.stop !== undefined, maxOutputTokens: execBase.maxOutputTokens });
          if (next?.config) {
            app.log.warn({ orgId: auth.org.orgId, clusterId, served: strategyModelLabel(op.config), next: strategyModelLabel(next.config) }, 'empty answer under the output budget (stream) — served once more on the next point');
            result = await execute(next.config, messages, sseCtx);
            if (next.config.type === 'single') learnFromAnswer(next.config.model, result, execBase.maxOutputTokens);
            emptyAnswerRetry = true;
            implicitSignals.push('retry_empty_answer');
          }
        }
      } catch (err) {
        // M3 #25: mid-stream provider failure → OpenAI error parity shape.
        // M4 #33: breaker fast-reject → breaker_open alert (edge-deduped).
        notifyBreakerOpen(ctx, auth.org.orgId, err, (m) => app.log.warn(m));
        writeData(openAiError((err as Error).message, 'service_unavailable', 'service_unavailable'));
        reply.raw.write('data: [DONE]\n\n');
        reply.raw.end();
        await logRequest({ ...logBase, status: 'error', latencyMs: elapsed() });
        // G0.3: the quality floor sees failures — a SAMPLED request whose
        // execution failed records a quality-0 'serve-error' sample.
        if (guaranteeCfg && guaranteeSampled) {
          void runGuaranteeErrorSample(
            ctx,
            {
              orgId: auth.org.orgId,
              requestId: id,
              clusterId,
              messages: messages,
              policy,
              policyId,
              served: { hash: sh },
            },
            (msg) => app.log.warn(msg),
          ).catch((e) => app.log.warn(e, 'guarantee error-sample failed — swallowed'));
        }
        return;
      }
      // M3 #25: provider tool_calls stream as tool_calls delta chunks with
      // finish_reason 'tool_calls' (OpenAI chunk format).
      if (result.toolCalls) {
        writeData(sseChunk(base, { tool_calls: toolCallDeltas(result.toolCalls) }));
      }
      writeData(sseChunk(base, {}, result.toolCalls ? 'tool_calls' : (result.finishReason === 'length' ? 'length' : 'stop')));
      // M3 #25: stream_options.include_usage → final usage-only chunk
      // (choices: []) per the OpenAI spec, before [DONE].
      if (includeUsage) {
        writeData(sseUsageChunk(base, openAiUsage(result.usage)));
      }
      reply.raw.write('data: [DONE]\n\n');
      reply.raw.end();
      if (result.finishReason === 'length' && !implicitSignals.includes('finish_length')) implicitSignals.push('finish_length');
      await logRequest({
        ...logBase,
        answerShape: answerShapeOf(result, { jsonRequested: wantsJson(body.response_format), strategyType: op.config.type }),
        status: 'ok',
        usage: result.usage,
        latencyMs: elapsed(),
        // S3: the counterfactual, captured while the frontier that
        // defines it is still in hand. null = comparison undefined.
        baselineCostUsd: baselineCostUsd(op.frontier, sh, result.usage?.costUsd, baseline?.hash ?? null),
      });
      keepSample(result.text, op.config as { type: string; model?: string }, result.usage, clusterId);
      // ---- M3 #21 shadow (m3-shadow) ----
      // Stream fully ended above ([DONE] + end): the shadow run executes
      // strictly AFTER the primary response, fire-and-forget with a
      // catch-all — a shadow failure can never affect the served stream.
      if (shadowCfg && shadowSampled) {
        void runShadow(
          ctx,
          {
            orgId: auth.org.orgId,
            requestId: id,
            clusterId,
            messages: messages,
            primary: { hash: sh, text: result.text },
            shadow: shadowCfg,
            frontier,
            orgProviders,
          },
          (msg) => app.log.warn(msg),
        ).catch((err) => app.log.warn(err, 'shadow run failed (stream) — swallowed'));
      }
      // ---- end M3 #21 shadow ----
      // ---- M3 #22 guarantee (m3-guarantee) ----
      // Stream fully ended above ([DONE] + end): the guarantee sample is
      // scored strictly AFTER the primary response, fire-and-forget with a
      // catch-all — same latency contract as the shadow run.
      if (guaranteeCfg && guaranteeSampled) {
        void runGuaranteeSample(
          ctx,
          {
            orgId: auth.org.orgId,
            requestId: id,
            clusterId,
            messages: messages,
            policy,
            policyId,
            orgProviders,
            served: { hash: sh, text: result.text },
          },
          (msg) => app.log.warn(msg),
        ).catch((err) => app.log.warn(err, 'guarantee sample failed (stream) — swallowed'));
      }
      // ---- end M3 #22 guarantee ----
      return;
    }

    // ---- M3 #23 composite (m3-composite) ----
    // SSE path: stream:true + composite strategy (SPEC §12.6). The composite
    // interpreter makes its keep/upgrade decision BEFORE any client token is
    // emitted (provider confidence resolves at completion; see
    // packages/strategies/src/composite.ts), so token chunks are captured
    // during execute() and flushed afterwards — this lets x-frontier-trace
    // carry the final upgraded=0|1 flag (HTTP headers precede the body) while
    // the client still receives ONE coherent OpenAI-shaped SSE token stream
    // with no meta-commentary at the upgrade boundary. Chunk framing reuses
    // the 'single' plumbing above; tool_calls never occur (composite refuses
    // tools at the 4b gate).
    if (wantStream && op.config.type === 'composite') {
      reply.hijack();
      const base = { id, created, model: body.model };
      const writeData = (obj: unknown): void => {
        reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`);
      };
      const captured: string[] = [];
      let result;
      try {
        result = await execute(op.config, messages, {
          ...execBase,
          stream: (token) => captured.push(token),
        });
      } catch (err) {
        // Mid-execution provider failure → OpenAI error parity shape (same
        // contract as the 'single' SSE path). Headers not yet sent, so the
        // base trace (upgraded unknown → flag omitted) is used.
        reply.raw.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'x-frontier-trace': trace,
          'x-potion-model': strategyModelLabel(op.config as { type: string; model?: string }),
          'x-request-id': req.id,
        });
        writeData(openAiError((err as Error).message, 'service_unavailable', 'service_unavailable'));
        reply.raw.write('data: [DONE]\n\n');
        reply.raw.end();
        await logRequest({ ...logBase, status: 'error', latencyMs: elapsed() });
        // G0.3: the quality floor sees failures — a SAMPLED request whose
        // execution failed records a quality-0 'serve-error' sample.
        if (guaranteeCfg && guaranteeSampled) {
          void runGuaranteeErrorSample(
            ctx,
            {
              orgId: auth.org.orgId,
              requestId: id,
              clusterId,
              messages: messages,
              policy,
              policyId,
              served: { hash: sh },
            },
            (msg) => app.log.warn(msg),
          ).catch((e) => app.log.warn(e, 'guarantee error-sample failed — swallowed'));
        }
        return;
      }
      // upgraded flag → trace header, NOT the stream (SPEC §12.6).
      const upgraded = result.trace.some((t) => t.decision === 'upgraded') ? 1 : 0;
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-frontier-trace': `${trace};upgraded=${upgraded}`,
        // M3 #26 observability: echo the request id (hijacked responses
        // bypass the plugin's onSend hook).
        'x-request-id': req.id,
      });
      writeData(sseChunk(base, { role: 'assistant' }));
      for (const token of captured) writeData(sseChunk(base, { content: token }));
      writeData(sseChunk(base, {}, 'stop'));
      if (includeUsage) {
        writeData(sseUsageChunk(base, openAiUsage(result.usage)));
      }
      reply.raw.write('data: [DONE]\n\n');
      reply.raw.end();
      if (result.finishReason === 'length' && !implicitSignals.includes('finish_length')) implicitSignals.push('finish_length');
      await logRequest({
        ...logBase,
        answerShape: answerShapeOf(result, { jsonRequested: wantsJson(body.response_format), strategyType: op.config.type }),
        status: 'ok',
        usage: result.usage,
        latencyMs: elapsed(),
        // S3: the counterfactual, captured while the frontier that
        // defines it is still in hand. null = comparison undefined.
        baselineCostUsd: baselineCostUsd(op.frontier, sh, result.usage?.costUsd, baseline?.hash ?? null),
      });
      keepSample(result.text, op.config as { type: string; model?: string }, result.usage, clusterId);
      return;
    }
    // ---- end M3 #23 composite (m3-composite) ----

    // ---- 5b. JSON path (non-stream, or stream:true on a non-streamable multi-call strategy) ----
    try {
      let result = await execute(op.config, messages, execBase);
      if (op.config.type === 'single') learnFromAnswer(op.config.model, result, execBase.maxOutputTokens);
      let servedConfig: StrategyConfig = op.config;
      if (op.config.type === 'single' && isEmptyAnswer(result, execBase.maxOutputTokens)) {
        const next = nextPointExcluding(policy, op.frontier, sh, fallbackStrategyFor(ctx.providerMode, ctx.prices), { toolCapableOnly: body.tools !== undefined || body.response_format !== undefined || body.stop !== undefined, maxOutputTokens: execBase.maxOutputTokens });
        if (next?.config) {
          app.log.warn({ orgId: auth.org.orgId, clusterId, served: strategyModelLabel(op.config), next: strategyModelLabel(next.config) }, 'empty answer under the output budget — served once more on the next point');
          result = await execute(next.config, messages, execBase);
          if (next.config.type === 'single') learnFromAnswer(next.config.model, result, execBase.maxOutputTokens);
          servedConfig = next.config;
          emptyAnswerRetry = true;
          implicitSignals.push('retry_empty_answer');
        }
      }
      // JSON mode honored at the edge (routing/json-mode.ts): a fenced object
      // is unwrapped when what is inside parses; nothing else is touched.
      if (wantsJson(body.response_format) && result.text !== '') {
        const unwrapped = unwrapJsonFences(result.text);
        if (unwrapped !== result.text) {
          implicitSignals.push('json_fence_unwrapped');
          result = { ...result, text: unwrapped };
        }
      }
      if (wantStream) {
        // Documented contract: non-streamable multi-call strategies (anything
        // but 'single'/'composite') cannot token-stream.
        void reply.header('x-latency-contract', 'non-streamed');
      }
      // ---- M3 #23 composite (m3-composite) ----
      // Non-stream composite: record the keep/upgrade decision on the trace
      // header too (same upgraded=0|1 contract as the SSE relay above).
      if (op.config.type === 'composite') {
        const upgraded = result.trace.some((t) => t.decision === 'upgraded') ? 1 : 0;
        void reply.header('x-frontier-trace', `${trace};upgraded=${upgraded}`);
      }
      // ---- end M3 #23 composite (m3-composite) ----
      // The point that answered (a single point may have been served once
      // more on the next point after an empty answer — routing/empty answer).
      if (emptyAnswerRetry) void reply.header('x-frontier-trace', `${trace};retry=empty_answer`);
      void reply.header('x-potion-model', strategyModelLabel(servedConfig));
      if (result.finishReason === 'length' && !implicitSignals.includes('finish_length')) implicitSignals.push('finish_length');
      await logRequest({
        ...logBase,
        answerShape: answerShapeOf(result, { jsonRequested: wantsJson(body.response_format), strategyType: op.config.type }),
        status: 'ok',
        usage: result.usage,
        latencyMs: elapsed(),
        // S3: the counterfactual, captured while the frontier that
        // defines it is still in hand. null = comparison undefined.
        baselineCostUsd: baselineCostUsd(op.frontier, sh, result.usage?.costUsd, baseline?.hash ?? null),
      });
      keepSample(result.text, op.config as { type: string; model?: string }, result.usage, clusterId);
      const sent = reply.send({
        id,
        object: 'chat.completion',
        created,
        model: body.model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: result.text,
              // M3 #25: provider tool_calls preserved verbatim.
              ...(result.toolCalls ? { tool_calls: result.toolCalls } : {}),
            },
            finish_reason: result.toolCalls ? 'tool_calls' : (result.finishReason === 'length' ? 'length' : 'stop'),
          },
        ],
        usage: openAiUsage(result.usage),
        // Beta feedback (2026-08-24): the routing decision as a typed object —
        // requested settings vs resolved outcome, no trace parsing required.
        // The trace header stays the source record.
        potion: {
          requested_cluster: hintedClusterId ?? 'auto',
          resolved_cluster: clusterId,
          requested_policy: policyOverrideName,
          policy_source: policyOverrideName !== null ? 'override' : 'key_default',
          resolved_policy_type: policy.type,
          model: strategyModelLabel(servedConfig),
          fallback: op.fallback === 1,
          ...(op.fallbackReason !== undefined ? { fallback_reason: op.fallbackReason } : {}),
          ...(servedInstrument !== null ? { instrument: servedInstrument } : {}),
          ...(emptyAnswerRetry ? { retry: 'empty_answer' } : {}),
          provenance,
        },
      });
      // ---- M3 #21 shadow (m3-shadow) ----
      // Primary response handed to the transport above; shadow candidates
      // execute AFTER, fire-and-forget with a catch-all (see shadow.ts for
      // the spend-discipline + error-swallowing contract).
      if (shadowCfg && shadowSampled) {
        void runShadow(
          ctx,
          {
            orgId: auth.org.orgId,
            requestId: id,
            clusterId,
            messages: messages,
            primary: { hash: sh, text: result.text },
            shadow: shadowCfg,
            frontier,
            orgProviders,
          },
          (msg) => app.log.warn(msg),
        ).catch((err) => app.log.warn(err, 'shadow run failed — swallowed'));
      }
      // ---- end M3 #21 shadow ----
      // ---- M3 #22 guarantee (m3-guarantee) ----
      // Primary response handed to the transport above; the guarantee sample
      // is scored AFTER, fire-and-forget with a catch-all (see guarantee.ts
      // for the scoring/queue/evaluation contract).
      if (guaranteeCfg && guaranteeSampled) {
        void runGuaranteeSample(
          ctx,
          {
            orgId: auth.org.orgId,
            requestId: id,
            clusterId,
            messages: messages,
            policy,
            policyId,
            orgProviders,
            served: { hash: sh, text: result.text },
          },
          (msg) => app.log.warn(msg),
        ).catch((err) => app.log.warn(err, 'guarantee sample failed — swallowed'));
      }
      // ---- end M3 #22 guarantee ----
      return sent;
    } catch (err) {
      await logRequest({ ...logBase, status: 'error', latencyMs: elapsed() });
      // G0.3: the quality floor sees failures — record a quality-0
      // 'serve-error' sample for SAMPLED requests.
      if (guaranteeCfg && guaranteeSampled) {
        void runGuaranteeErrorSample(
          ctx,
          {
            orgId: auth.org.orgId,
            requestId: id,
            clusterId,
            messages: messages,
            policy,
            policyId,
            served: { hash: sh },
          },
          (msg) => app.log.warn(msg),
        ).catch((e) => app.log.warn(e, 'guarantee error-sample failed — swallowed'));
      }
      // M4 #33: breaker fast-reject → breaker_open alert (edge-deduped).
      notifyBreakerOpen(ctx, auth.org.orgId, err, (m) => app.log.warn(m));
      // M3 #25: provider down mid-execution → 503 service_unavailable
      // (OpenAI parity; was 502 upstream_error).
      return reply
        .code(503)
        .send(
          openAiError(
            `strategy execution failed: ${(err as Error).message}`,
            'service_unavailable',
            'service_unavailable',
          ),
        );
    }
  });
}

/**
 * The caller's `max_tokens`, bounded. The ceiling matches the dashboard's
 * own maxOutputTokens bound (8192): large enough for any answer the product
 * serves, small enough that a typo cannot buy a 100k-token completion.
 */
export function resolveMaxOutputTokens(requested: number, ceiling = 8192): number {
  if (!Number.isFinite(requested) || requested < 1) return 1;
  return Math.min(Math.floor(requested), ceiling);
}

function openAiUsage(u: Usage): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
} {
  return {
    prompt_tokens: u.inputTokens,
    completion_tokens: u.outputTokens,
    total_tokens: u.inputTokens + u.outputTokens,
  };
}
