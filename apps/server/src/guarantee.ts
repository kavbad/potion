// Quality-guarantee sampler + operating-point override (M3 #22 → G0.1,
// SPEC §12.5).
//
// When the served policy carries a `guarantee` config, a per-request sample
// (sampleRate) of SERVED answers is quality-scored AFTER the response was
// sent — fire-and-forget exactly like the shadow executor (#21): the chat
// route fires `void runGuaranteeSample(...)` with a catch-all; this module
// NEVER throws into the serving path and NEVER blocks a response.
//
//   · SCORING (G0.1) — a REAL llm-judge call, in-process, mock AND live:
//     scoreServedAnswer (@potion/harness serve-judge) reuses the hardened
//     scoreLlmJudge path (UNTRUSTED_DATA framing, PROTOCOL_MAX_TOKENS cap,
//     strict last-line SCORE parse). Judge model: guarantee.judgeModel or
//     the platform default (judge-class live / mock-judge mock — the mock
//     judge fixture is deterministic and labeled; the old Jaccard-vs-prompt
//     stub is retired). Judge spend is REAL org-attributable cost: recorded
//     on the quality_samples evidence row AND metered as a
//     status='guarantee_judge' request_logs row (the usage rollup counts it
//     toward org cost — budgets/invoices see it — never toward served
//     request/token counts).
//   · EVALUATION — the rolling-mean/min-evidence/cooldown/action decision
//     lives in ONE place: evaluateGuarantee in @potion/db. With a queue on
//     ctx the server enqueues a CONTENT-FREE per-target guarantee:evaluate
//     job (org/cluster/strategy/policy only — raw prompts and answers never
//     transit the queue; G0.1) and the worker evaluates + emits alerts.
//     Queue-less deployments evaluate in-process (metric via
//     observeGuaranteeBreach).
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
  insertRequestLog,
  latestActiveRollback,
  type GuaranteeEvaluation,
} from '@potion/db';
import { defaultServeJudgeModel, scoreServedAnswer } from '@potion/harness';
import type { OrgProviders, PotionContext } from './context.js';

/** Job name enqueued for queue-backed window evaluation (ROADMAP #28
 * workers consume it; G0.1: per-target mode only — never carries content). */
export const GUARANTEE_EVALUATE_JOB = 'guarantee:evaluate';

/** request_logs.status for judge-scoring spend rows (G0.1): counted toward
 * org COST by the usage rollup, never toward served request/token counts. */
export const GUARANTEE_JUDGE_LOG_STATUS = 'guarantee_judge';

/** quality_samples.scorer for error-path samples (G0.3): the request's
 * strategy execution failed — quality 0 by definition, no judge involved. */
export const SERVE_ERROR_SCORER = 'serve-error';

/** Per-request sampling decision (chat route calls this for EVERY request
 * whose policy carries a guarantee config). */
export function shouldSampleGuarantee(
  guarantee: GuaranteeConfig,
  rand: () => number = Math.random,
): boolean {
  return rand() < guarantee.sampleRate;
}

/** Queue duck-type (same structural detection as shadow.ts — compiles and
 * behaves correctly whether or not ctx carries a queue). */
interface QueueLike {
  enqueue(name: string, payload: unknown): Promise<unknown> | unknown;
}

function queueOf(ctx: PotionContext): QueueLike | undefined {
  return (ctx as unknown as { queue?: QueueLike }).queue;
}

export interface GuaranteeSampleParams {
  orgId: string;
  /** Chat completion id (chatcmpl-…) — the quality_samples.request_id label
   * AND the judge's deterministic seed component. */
  requestId: string;
  clusterId: string;
  messages: ChatMessage[];
  /** The governing policy (MUST carry a guarantee config — caller gates). */
  policy: Policy;
  /** The policy ROW id that served the request (request_logs correlation). */
  policyId: string | null;
  /** The request's resolved provider set (BYOK-aware, resilient, metered) —
   * the judge call runs on the same providers that served the org. */
  orgProviders: OrgProviders;
  /** The served answer: serving strategy hash + answer text. */
  served: { hash: string; text: string };
}

/**
 * Judge-score + persist + evaluate one SAMPLED served request. NEVER
 * throws: every failure is caught and warned (a broken guarantee pipeline
 * can never affect a served response; a failed judge call drops the sample
 * LOUDLY rather than recording a fake score). Returns the evaluation when
 * it ran in-process, null when evaluation was handed to the queue (or the
 * sample was dropped).
 */
export async function runGuaranteeSample(
  ctx: PotionContext,
  params: GuaranteeSampleParams,
  warn: (msg: string) => void = () => {},
): Promise<GuaranteeEvaluation | null> {
  const guarantee = params.policy.guarantee;
  if (!guarantee) return null;
  try {
    const judgeModel = guarantee.judgeModel ?? defaultServeJudgeModel(ctx.providerMode);
    const score = await scoreServedAnswer(
      {
        requestId: params.requestId,
        clusterId: params.clusterId,
        messages: params.messages,
        answerText: params.served.text,
        judgeModel,
      },
      { providers: params.orgProviders.providers, prices: ctx.prices },
    );
    await insertQualitySample(ctx.db.db, {
      orgId: params.orgId,
      requestId: params.requestId,
      strategyHash: params.served.hash,
      // G0.3 evidence keys — breach windows are strictly (org, policy,
      // cluster, strategy).
      clusterId: params.clusterId,
      policyId: params.policyId,
      quality: score.quality,
      scorer: score.scorer,
      judgeModel,
      judgeCostUsd: score.usage.costUsd,
    });
    // Judge spend meter row (G0.1): org-attributable cost for budgets +
    // invoices. strategyHash = the SERVED strategy the sample evaluates.
    await insertRequestLog(ctx.db.db, {
      orgId: params.orgId,
      clusterId: params.clusterId,
      strategyHash: params.served.hash,
      policyType: params.policy.type,
      policyId: params.policyId,
      model: judgeModel,
      usage: score.usage,
      latencyMs: score.usage.latencyMs,
      status: GUARANTEE_JUDGE_LOG_STATUS,
    });

    return evaluateOrEnqueue(ctx, params, guarantee, warn);
  } catch (err) {
    warn(
      `guarantee: sample failed for request ${params.requestId}: ${(err as Error).message} — ` +
        'swallowed, sample DROPPED (served response unaffected; a failed judge call never ' +
        'records a fake score)',
    );
    return null;
  }
}

/**
 * Error-path sample (G0.3): a SAMPLED request whose strategy execution
 * FAILED records quality 0 with scorer 'serve-error' — no judge call, no
 * spend, judge evidence columns NULL. The quality floor must see outages:
 * a failing strategy drags its keyed rolling mean toward 0. Same
 * fire-and-forget / never-throws contract as runGuaranteeSample.
 */
export async function runGuaranteeErrorSample(
  ctx: PotionContext,
  params: Omit<GuaranteeSampleParams, 'orgProviders' | 'served'> & {
    served: { hash: string };
  },
  warn: (msg: string) => void = () => {},
): Promise<GuaranteeEvaluation | null> {
  const guarantee = params.policy.guarantee;
  if (!guarantee) return null;
  try {
    await insertQualitySample(ctx.db.db, {
      orgId: params.orgId,
      requestId: params.requestId,
      strategyHash: params.served.hash,
      clusterId: params.clusterId,
      policyId: params.policyId,
      quality: 0,
      scorer: SERVE_ERROR_SCORER,
    });
    return evaluateOrEnqueue(ctx, params, guarantee, warn);
  } catch (err) {
    warn(
      `guarantee: error-path sample failed for request ${params.requestId}: ` +
        `${(err as Error).message} — swallowed, sample DROPPED`,
    );
    return null;
  }
}

/** Shared post-insert step: hand evaluation to the worker (content-free
 * per-target job — alerts ride the worker path) or evaluate in-process. */
async function evaluateOrEnqueue(
  ctx: PotionContext,
  params: Pick<GuaranteeSampleParams, 'orgId' | 'clusterId' | 'policyId' | 'policy'> & {
    served: { hash: string };
  },
  guarantee: GuaranteeConfig,
  warn: (msg: string) => void,
): Promise<GuaranteeEvaluation | null> {
  {
    const queue = queueOf(ctx);
    if (queue) {
      await queue.enqueue(GUARANTEE_EVALUATE_JOB, {
        orgId: params.orgId,
        policyId: params.policyId,
        clusterId: params.clusterId,
        strategyHash: params.served.hash,
        policy: params.policy,
      });
      return null;
    }
    if (params.policyId === null) {
      warn('guarantee: no policy id on the request — window evaluation skipped (unkeyed)');
      return null;
    }
    const evaluation = await evaluateGuarantee(ctx.db.db, {
      orgId: params.orgId,
      policyId: params.policyId,
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
        `guarantee breach for org ${params.orgId} policy ${params.policyId} cluster ` +
          `${params.clusterId}: rolling quality ${(evaluation.rollingQuality ?? 0).toFixed(3)} ` +
          `< ${guarantee.minQuality} (ci95 upper ${(evaluation.ci95?.[1] ?? 0).toFixed(3)}) over ` +
          `${guarantee.windowMin}min (${evaluation.samples} samples) → ${evaluation.action}` +
          (evaluation.rollback
            ? ` (${evaluation.rollback.fromStrategy.slice(0, 8)}→${evaluation.rollback.toStrategy.slice(0, 8)} ${evaluation.rollback.source})`
            : ''),
      );
    }
    return evaluation;
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
