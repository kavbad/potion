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
//   · QUALITY (2026-09-01, shadow:judge implemented) — every candidate is
//     scored IN-PROCESS by the SERVE JUDGE (@potion/harness serve-judge):
//     the same reference-free instrument that scores guarantee samples, so
//     the primary's quality_samples and the candidates' shadow_results are
//     on one scale. Mock world gets the deterministic mock judge, live gets
//     the judge class — one code path, only the alias differs (guarantee.ts
//     precedent). This replaced two things at once: the token-set-Jaccard
//     scorer (anchored on the primary answer — sameness, not quality) and
//     the `shadow:judge` queue leg, whose enqueued payload shipped raw
//     candidate/primary TEXT through the queue — the exact exposure the
//     guarantee's G0.1 content-free rule exists to prevent (and whose
//     worker stub validated a field the enqueuer never sent, so every live
//     job threw). Judge spend is metered per call (SHADOW_JUDGE_LOG_STATUS
//     rows — org-attributable for budgets + invoices, excluded from
//     serving p95 by status). A failed judge call drops the SCORE loudly
//     (quality NULL = unscored), never the row: the execution evidence
//     (cost, latency) is real either way.
import type { ChatMessage, Frontier, ShadowConfig, StrategyConfig, Usage } from '@potion/core';
import { getStrategyConfigs, insertRequestLog, insertShadowResult } from '@potion/db';
import { defaultServeJudgeModel, scoreServedAnswer } from '@potion/harness';
import { execute } from '@potion/strategies';
import type { OrgProviders, PotionContext } from './context.js';
import { programModels } from '@potion/core';

/** Hard cap on candidate executions per sampled request (spend discipline —
 * see the file header for why this replaces a proportional cost cap). */
export const MAX_SHADOW_CANDIDATES = 2;

/** request_logs.status for shadow-judge spend meter rows (the
 * GUARANTEE_JUDGE_LOG_STATUS pattern): org-attributable judge cost, never
 * served traffic — serving p95 counts status 'ok' only. */
export const SHADOW_JUDGE_LOG_STATUS = 'shadow_judge';

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
    case 'program':
      return programModels(config.body).join('+');
  }
}

/** One candidate's outcome, ready to persist. */
export interface ShadowOutcome {
  candidate: ShadowCandidate;
  usage: Usage;
  /** null when the judge call failed — the score is dropped loudly while
   * the execution evidence (cost, latency) still lands. */
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

  const execBase = {
    providers: params.orgProviders.providers,
    prices: ctx.prices,
    resolve: params.orgProviders.resolve,
  };

  const outcomes = await Promise.all(
    candidates.map(async (candidate): Promise<ShadowOutcome | null> => {
      try {
        const result = await execute(candidate.config, params.messages, execBase);
        // Judge-score with the SERVE JUDGE — the same reference-free
        // instrument that scores guarantee samples, on the org's own
        // provider set (BYOK-aware), mock judge under mock. A failed judge
        // call drops the SCORE loudly, never the row (see file header).
        let quality: number | null = null;
        const judgeModel = defaultServeJudgeModel(ctx.providerMode);
        try {
          const score = await scoreServedAnswer(
            {
              requestId: params.requestId,
              clusterId: params.clusterId,
              messages: params.messages,
              answerText: result.text,
              judgeModel,
            },
            { providers: params.orgProviders.providers, prices: ctx.prices },
          );
          quality = score.quality;
          // Judge spend meter row (guarantee.ts precedent): org-attributable
          // cost for budgets + invoices. strategyHash = the CANDIDATE the
          // judge scored; the status keeps it out of serving-grade latency.
          await insertRequestLog(ctx.db.db, {
            orgId: params.orgId,
            clusterId: params.clusterId,
            strategyHash: candidate.hash,
            model: judgeModel,
            usage: score.usage,
            latencyMs: score.usage.latencyMs,
            status: SHADOW_JUDGE_LOG_STATUS,
            completionId: params.requestId,
          });
        } catch (err) {
          warn(
            `shadow: judge failed for candidate ${candidate.hash.slice(0, 8)} on request ` +
              `${params.requestId}: ${(err as Error).message} — quality NULL (execution evidence kept)`,
          );
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
