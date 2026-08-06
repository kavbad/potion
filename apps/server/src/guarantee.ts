// Quality-guarantee sampler + operating-point override (M3, ROADMAP #22,
// SPEC §12.5).
//
// When the served policy carries a `guarantee` config, a per-request sample
// (sampleRate) of SERVED answers is quality-scored AFTER the response was
// sent — fire-and-forget exactly like the shadow executor (#21): the chat
// route fires `void runGuaranteeSample(...)` with a catch-all; this module
// NEVER throws into the serving path and NEVER blocks a response.
//
//   · SCORING — mock world: the deterministic in-process scorer
//     (serveQualityScore, token-set Jaccard of the answer against its
//     prompt, reusing the shadow scorer contract). Live mode with a job
//     queue on ctx (ROADMAP #28): a `guarantee:evaluate` job is enqueued
//     instead; the worker scores, inserts the sample, and evaluates the
//     breach window (packages/workers).
//   · EVALUATION — the rolling-mean/min-evidence/cooldown/action decision
//     lives in ONE place: evaluateGuarantee in @potion/db (shared with the
//     worker's periodic guarantee:evaluate sweep). A breach increments the
//     potion_guarantee_breaches_total metric via the optional
//     observeGuaranteeBreach meter method.
//   · OVERRIDE — the LATEST UNRESOLVED kind='rollback' incident for
//     (org, cluster) IS the org's operating point for that cluster:
//     resolveGuaranteeOverride maps detail.toStrategy back to a
//     StrategyConfig (serving frontier points first, then strategy_configs)
//     and the chat route serves it. Resolving the incident (POST
//     /api/incidents/:id/resolve) lifts the override → policy routing
//     resumes. An unresolvable target hash is warned + ignored (the
//     policy-resolved point serves — never a hard failure).
import type {
  ChatMessage,
  Frontier,
  GuaranteeConfig,
  Policy,
  StrategyConfig,
} from '@potion/core';
import {
  evaluateGuarantee,
  getStrategyConfigs,
  insertQualitySample,
  latestActiveRollback,
  type GuaranteeEvaluation,
} from '@potion/db';
import type { PotionContext } from './context.js';
import { shadowScore } from './shadow.js';

/** Job name enqueued for queue-backed scoring + evaluation (ROADMAP #28
 * workers consume it). */
export const GUARANTEE_EVALUATE_JOB = 'guarantee:evaluate';

/** Per-request sampling decision (chat route calls this for EVERY request
 * whose policy carries a guarantee config). */
export function shouldSampleGuarantee(
  guarantee: GuaranteeConfig,
  rand: () => number = Math.random,
): boolean {
  return rand() < guarantee.sampleRate;
}

/**
 * Deterministic served-answer quality scorer (mock world, SPEC §12.5):
 * token-set Jaccard of the SERVED answer against its prompt — the same
 * deterministic-scorer contract as the shadow scorer (the serving path has
 * no reference answer; the prompt is the available anchor). 1 = identical
 * token sets, 0 = disjoint. The worker's serveQualityScore reimplements
 * this math for the queued path (packages cannot import apps).
 */
export function serveQualityScore(promptText: string, answerText: string): number {
  return shadowScore(promptText, answerText);
}

/** Queue duck-type (same structural detection as shadow.ts — compiles and
 * behaves correctly whether or not ctx carries a queue). */
interface QueueLike {
  enqueue(name: string, payload: unknown): Promise<unknown> | unknown;
}

function queueOf(ctx: PotionContext): QueueLike | undefined {
  return (ctx as unknown as { queue?: QueueLike }).queue;
}

/** The prompt anchor for scoring: concatenated user contents (all contents
 * when no user role exists) — the same rule the chat route uses for cluster
 * assignment. */
export function promptTextOf(messages: ChatMessage[]): string {
  const user = messages.filter((m) => m.role === 'user').map((m) => m.content);
  return (user.length > 0 ? user : messages.map((m) => m.content)).join('\n');
}

export interface GuaranteeSampleParams {
  orgId: string;
  /** Chat completion id (chatcmpl-…) — the quality_samples.request_id label. */
  requestId: string;
  clusterId: string;
  messages: ChatMessage[];
  /** The governing policy (MUST carry a guarantee config — caller gates). */
  policy: Policy;
  /** The served answer: serving strategy hash + answer text. */
  served: { hash: string; text: string };
}

/**
 * Score + persist + evaluate one SAMPLED served request. NEVER throws:
 * every failure is caught and warned (a broken guarantee pipeline can never
 * affect a served response). Returns the evaluation when it ran in-process,
 * null when the work was handed to the queue (or nothing was done).
 */
export async function runGuaranteeSample(
  ctx: PotionContext,
  params: GuaranteeSampleParams,
  warn: (msg: string) => void = () => {},
): Promise<GuaranteeEvaluation | null> {
  const guarantee = params.policy.guarantee;
  if (!guarantee) return null;
  try {
    const promptText = promptTextOf(params.messages);
    const queue = queueOf(ctx);
    if (ctx.providerMode === 'live' && queue) {
      // Live + queue present: the worker scores + inserts + evaluates
      // asynchronously (ROADMAP #28).
      await queue.enqueue(GUARANTEE_EVALUATE_JOB, {
        orgId: params.orgId,
        clusterId: params.clusterId,
        strategyHash: params.served.hash,
        policy: params.policy,
        sample: {
          requestId: params.requestId,
          promptText,
          answerText: params.served.text,
        },
      });
      return null;
    }
    // Mock world (or no queue): deterministic in-process scorer.
    const quality = serveQualityScore(promptText, params.served.text);
    await insertQualitySample(ctx.db.db, {
      orgId: params.orgId,
      requestId: params.requestId,
      strategyHash: params.served.hash,
      quality,
    });
    const evaluation = await evaluateGuarantee(ctx.db.db, {
      orgId: params.orgId,
      clusterId: params.clusterId,
      strategyHash: params.served.hash,
      policy: params.policy,
    });
    if (evaluation.breach && evaluation.incidentId !== null && evaluation.action !== null) {
      ctx.observability?.meter.observeGuaranteeBreach?.({
        orgId: params.orgId,
        action: evaluation.action,
      });
      warn(
        `guarantee breach for org ${params.orgId} cluster ${params.clusterId}: rolling quality ` +
          `${(evaluation.rollingQuality ?? 0).toFixed(3)} < ${guarantee.minQuality} over ` +
          `${guarantee.windowMin}min (${evaluation.samples} samples) → ${evaluation.action}` +
          (evaluation.rollback
            ? ` (${evaluation.rollback.fromStrategy.slice(0, 8)}→${evaluation.rollback.toStrategy.slice(0, 8)} ${evaluation.rollback.source})`
            : ''),
      );
    }
    return evaluation;
  } catch (err) {
    warn(
      `guarantee: sample failed for request ${params.requestId}: ${(err as Error).message} — ` +
        'swallowed (served response unaffected)',
    );
    return null;
  }
}

/**
 * The org's operating-point override for a cluster (see header): the latest
 * unresolved rollback incident's detail.toStrategy resolved to a
 * StrategyConfig — serving frontier points first (configs ride the points),
 * then the strategy_configs table. null when there is no active override or
 * the target hash can no longer be resolved (warned — the policy-resolved
 * point serves instead of failing the request).
 */
export async function resolveGuaranteeOverride(
  ctx: PotionContext,
  orgId: string,
  clusterId: string,
  frontier: Frontier | null,
  warn: (msg: string) => void = () => {},
): Promise<StrategyConfig | null> {
  const incident = await latestActiveRollback(ctx.db.db, orgId, clusterId);
  if (!incident) return null;
  const toStrategy = incident.detail.toStrategy;
  if (typeof toStrategy !== 'string' || toStrategy.length === 0) return null;
  const onFrontier = (frontier?.points ?? []).find((p) => p.strategyHash === toStrategy);
  if (onFrontier) return onFrontier.strategyConfig;
  const stored = await getStrategyConfigs(ctx.db.db, [toStrategy]);
  const config = stored[0]?.config;
  if (!config) {
    warn(
      `guarantee: rollback target '${toStrategy.slice(0, 8)}' (incident ${incident.id}) unknown ` +
        'on the current frontier and in strategy_configs — override ignored',
    );
    return null;
  }
  return config;
}
