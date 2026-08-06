// Shadow-mode executor (M3, ROADMAP #21, SPEC §12.4).
//
// After the PRIMARY response has been sent (never before, never blocking
// it), a sampled request re-executes up to MAX_SHADOW_CANDIDATES candidate
// strategies through the org's own provider set and records each outcome in
// shadow_results (migration 0007) for the savings report.
//
// Contracts honored here:
//   · PRIMARY PATH UNCHANGED — the chat route fires `void runShadow(...)`
//     with a catch-all after the response is on the wire; no await, no
//     shared state, no latency SLO impact.
//   · ALL shadow errors are swallowed (pino warn + the observeShadow metric
//     is emitted at sampling time by the caller) — a shadow failure can
//     never affect a served response.
//   · SPEND DISCIPLINE — the SPEC offers "cost capped at 20% of primary
//     request cost × candidates" OR something simpler. Candidate cost is
//     unknowable pre-execution (token counts arrive WITH the response), so
//     a proportional cap cannot be enforced up front. The documented
//     simpler choice: a HARD CAP of 2 candidates per sampled request
//     (MAX_SHADOW_CANDIDATES), with per-request sampling (sampleRate) as
//     the volume knob. Shadow executions use the org's provider set, which
//     the provider factory already wraps with `resilient` defaults
//     (SPEC §12.1) — no double-wrapping here.
//   · QUALITY — mock world: the deterministic in-process scorer
//     (shadowScore, token-set Jaccard against the primary answer, reusing
//     the harness normalizeText contract). Live mode with a job queue on
//     ctx (ROADMAP #28): a `shadow:judge` job is enqueued instead and the
//     row is written with quality NULL until the worker scores it.
import type { ChatMessage, Frontier, ShadowConfig, StrategyConfig, Usage } from '@potion/core';
import { getStrategyConfigs, insertShadowResult } from '@potion/db';
import { normalizeText } from '@potion/harness';
import { execute } from '@potion/strategies';
import type { OrgProviders, PotionContext } from './context.js';

/** Hard cap on candidate executions per sampled request (spend discipline —
 * see the file header for why this replaces a proportional cost cap). */
export const MAX_SHADOW_CANDIDATES = 2;

/** Job name enqueued for live-mode quality judging when a queue is present
 * (ROADMAP #28 queue-workers consumes it). */
export const SHADOW_JUDGE_JOB = 'shadow:judge';

/** One resolved candidate: a strategy config + its content hash. */
export interface ShadowCandidate {
  hash: string;
  config: StrategyConfig;
}

export interface ShadowRunParams {
  orgId: string;
  /** Chat completion id (chatcmpl-…) — the shadow_results.request_id label. */
  requestId: string;
  clusterId: string;
  messages: ChatMessage[];
  /** The served primary: strategy hash + the answer text (scorer anchor). */
  primary: { hash: string; text: string };
  shadow: ShadowConfig;
  /** The serving frontier AFTER the provenance guard (candidate source for
   * candidates:'frontier' and the first lookup for explicit hashes). */
  frontier: Frontier | null;
  /** The request's per-org provider set (resilient from the factory in live
   * mode — see header). */
  orgProviders: OrgProviders;
}

/** Queue duck-type (ROADMAP #28 lands ctx.queue; structurally detected so
 * this branch compiles and behaves correctly both before and after it). */
interface QueueLike {
  enqueue(name: string, payload: unknown): Promise<unknown> | unknown;
}

function queueOf(ctx: PotionContext): QueueLike | undefined {
  return (ctx as unknown as { queue?: QueueLike }).queue;
}

/**
 * Per-request sampling decision (chat route calls this for EVERY request
 * whose policy carries a shadow config, sampled or not, so the
 * observeShadow metric sees both outcomes).
 */
export function shouldSample(shadow: ShadowConfig, rand: () => number = Math.random): boolean {
  return rand() < shadow.sampleRate;
}

/**
 * Resolve the candidate set for a sampled request, capped at
 * MAX_SHADOW_CANDIDATES and excluding the primary hash (a candidate equal
 * to the primary measures nothing).
 *   'frontier' — the OTHER points on the cluster's current frontier, in
 *                frontier order.
 *   string[]   — explicit strategyHashes; configs resolve from the serving
 *                frontier's points first, then the strategy_configs table.
 *                Unknown hashes are skipped (warned) — never an error.
 */
export async function resolveShadowCandidates(
  ctx: PotionContext,
  params: Pick<ShadowRunParams, 'shadow' | 'frontier' | 'primary'>,
  warn: (msg: string) => void = () => {},
): Promise<ShadowCandidate[]> {
  const { shadow, frontier, primary } = params;
  const out: ShadowCandidate[] = [];
  const seen = new Set<string>([primary.hash]);

  if (shadow.candidates === 'frontier') {
    for (const p of frontier?.points ?? []) {
      if (out.length >= MAX_SHADOW_CANDIDATES) break;
      if (seen.has(p.strategyHash)) continue;
      seen.add(p.strategyHash);
      out.push({ hash: p.strategyHash, config: p.strategyConfig });
    }
    return out;
  }

  // Explicit hashes: frontier points first (configs ride the points), then
  // the strategy_configs table for anything the frontier doesn't know.
  const fromFrontier = new Map(
    (frontier?.points ?? []).map((p) => [p.strategyHash, p.strategyConfig] as const),
  );
  const wanted = shadow.candidates.filter((h) => {
    if (seen.has(h)) return false; // dedupe + never shadow the primary
    seen.add(h);
    return true;
  });
  const missing = wanted.filter((h) => !fromFrontier.has(h));
  const stored = new Map(
    (await getStrategyConfigs(ctx.db.db, missing)).map((r) => [r.hash, r.config] as const),
  );
  for (const h of wanted) {
    if (out.length >= MAX_SHADOW_CANDIDATES) break;
    const config = fromFrontier.get(h) ?? stored.get(h);
    if (!config) {
      warn(`shadow: candidate hash '${h}' unknown (not on the frontier, not in strategy_configs) — skipped`);
      continue;
    }
    out.push({ hash: h, config });
  }
  return out;
}

/** Display model for a candidate config (shadow_results.candidate_model). */
export function candidateModelOf(config: StrategyConfig): string {
  switch (config.type) {
    case 'single':
      return config.model;
    case 'cascade':
      return config.stages.map((s) => s.model).join('→');
    case 'best-of-n':
      return `${config.model}×${config.n}`;
    case 'draft-verify':
      return `${config.draftModel}→${config.verifierModel}`;
    case 'ensemble':
      return config.models.join('+');
    case 'decompose':
      return config.decomposerModel;
    case 'composite':
      return `${config.startModel}→${config.upgradeModel}`;
  }
}

/**
 * Deterministic in-process shadow quality scorer (mock world; SPEC §12.4):
 * token-set Jaccard similarity between the candidate answer and the PRIMARY
 * answer (the serving path has no reference answer — the primary is the
 * best available anchor). Reuses the harness normalizeText contract (trim,
 * collapse whitespace, lowercase). 1 = identical token sets, 0 = disjoint.
 */
export function shadowScore(primaryText: string, candidateText: string): number {
  const tokens = (s: string): Set<string> => new Set(normalizeText(s).split(' ').filter(Boolean));
  const a = tokens(primaryText);
  const b = tokens(candidateText);
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** One candidate's outcome, ready to persist. */
export interface ShadowOutcome {
  candidate: ShadowCandidate;
  usage: Usage;
  /** null when a shadow:judge job was enqueued (score pending). */
  quality: number | null;
}

/**
 * Execute + score + persist the shadow candidates for one SAMPLED request.
 * NEVER throws: every candidate failure is caught and warned (a broken
 * candidate is just a missing row); any unexpected outer failure is caught
 * by the caller's catch-all too.
 */
export async function runShadow(
  ctx: PotionContext,
  params: ShadowRunParams,
  warn: (msg: string) => void = () => {},
): Promise<ShadowOutcome[]> {
  const candidates = await resolveShadowCandidates(ctx, params, warn);
  if (candidates.length === 0) return [];

  const live = ctx.providerMode === 'live';
  const queue = queueOf(ctx);
  const execBase = {
    providers: params.orgProviders.providers,
    prices: ctx.prices,
    resolve: params.orgProviders.resolve,
  };

  const outcomes = await Promise.all(
    candidates.map(async (candidate): Promise<ShadowOutcome | null> => {
      try {
        const result = await execute(candidate.config, params.messages, execBase);
        let quality: number | null = null;
        if (live && queue) {
          // Live + queue present: the judge worker scores asynchronously
          // (ROADMAP #28); the row is written with quality NULL until then.
          await queue.enqueue(SHADOW_JUDGE_JOB, {
            orgId: params.orgId,
            requestId: params.requestId,
            clusterId: params.clusterId,
            candidateHash: candidate.hash,
            candidateText: result.text,
            primaryText: params.primary.text,
          });
        } else {
          quality = shadowScore(params.primary.text, result.text);
        }
        const outcome: ShadowOutcome = { candidate, usage: result.usage, quality };
        await insertShadowResult(ctx.db.db, {
          orgId: params.orgId,
          requestId: params.requestId,
          clusterId: params.clusterId,
          primaryHash: params.primary.hash,
          candidateHash: candidate.hash,
          candidateModel: candidateModelOf(candidate.config),
          quality: outcome.quality,
          costUsd: result.usage.costUsd,
          latencyMs: Math.round(result.usage.latencyMs),
        });
        return outcome;
      } catch (err) {
        warn(
          `shadow: candidate ${candidate.hash.slice(0, 8)} failed for request ${params.requestId}: ` +
            `${(err as Error).message} — swallowed (primary unaffected)`,
        );
        return null;
      }
    }),
  );
  return outcomes.filter((o): o is ShadowOutcome => o !== null);
}
