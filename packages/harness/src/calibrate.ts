// Judge calibration (SPEC §5 → G0.2): measure whether a judge can be
// TRUSTED by calibrating it against deterministic ground truth.
//
// The corpus is reference-scored items ONLY (exact / field-match /
// code-exec): each item is answered once by a fixed answerer, the answer's
// TRUE quality comes from the deterministic scorer ($0, no model), and each
// judge re-scores the same answer through the hardened llm-judge path. Per
// judge: Pearson(judge, truth) + mean absolute error + flag < 0.8. With ≥2
// judges the pairwise agreement (the original SPEC §5 story) is reported
// too. llm-judge items carry no ground truth and are REJECTED — they cannot
// calibrate anything.
//
// Spend honesty (G0.2): answerer + judge usage is real provider spend on
// live runs — summed into the report and preflight-capped
// (projectCalibrationCostUsd → BudgetCapError) BEFORE any call is made.
// Mock mode stays fully deterministic and $0: the mock judges' base scores
// are corpus-truth-correlated with independent seeded noise, so
// pearsonVsTruth is high by construction — which is exactly the assertion.
import type { Provider } from '@potion/providers';
import type { EvalItem, PriceEntry, PriceTable, ProviderId, ScoringMethod, Usage } from '@potion/core';
import { createMockProvider, loadPrices } from '@potion/providers';
import { createResolver, execute } from '@potion/strategies';
import {
  BudgetCapError,
  estimateCallCostUsd,
  estimateCalls,
  estimateJudgeScoringCall,
} from './estimate.js';
import { scoreAnswer, scoreLlmJudge, type ScorerDeps } from './scorers.js';
import { unrunnableReason } from './runner.js';

export const CALIBRATION_JUDGES = ['mock-judge-a', 'mock-judge-b'] as const;
export const CALIBRATION_ANSWERER = 'mock-cheap';
export const CALIBRATION_FLAG_BELOW = 0.8;
/** GRADED rubric (G1.1 finding): the original "full credit only when
 * completely correct" wording made strict judges (sonnet-class) score
 * all-or-nothing against GRADED deterministic truth (field fractions,
 * test pass-rates) — mAE 0.88, r=0.05. Judges must be told the scale is
 * proportional. */
export const CALIBRATION_RUBRIC =
  'Score proportionally to how much of the request is fulfilled correctly ' +
  '(e.g. the fraction of requested fields extracted correctly, or of test ' +
  'cases a solution would pass). Full marks only when completely correct; ' +
  'zero only when nothing is correct.';
export const CALIBRATION_SCALE: [number, number] = [0, 4];

/** Pearson product-moment correlation; 1 when both vectors are constant-equal, 0 on degenerate input. */
export function pearson(xs: number[], ys: number[]): number {
  if (xs.length !== ys.length || xs.length < 2) return 0;
  const n = xs.length;
  const mx = xs.reduce((a, x) => a + x, 0) / n;
  const my = ys.reduce((a, y) => a + y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  // Degenerate (constant) vectors: equal constants agree perfectly; a
  // constant vs anything else has no measurable correlation. (Live G0.2
  // finding: the old sxy===sxx check reported two DIFFERENT constants as 1.)
  if (sxx === 0 || syy === 0) return sxx === 0 && syy === 0 && mx === my ? 1 : 0;
  return sxy / Math.sqrt(sxx * syy);
}

/** Average-tie ranks (Spearman support). */
function ranksOf(xs: number[]): number[] {
  const idx = xs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k]![1]] = avg;
    i = j + 1;
  }
  return out;
}

/**
 * Spearman rank correlation = Pearson over average-tie ranks. Robust to a
 * judge whose scale is compressed/shifted but MONOTONE with truth — the
 * rank view separates "ranks correctly on a distorted scale" (recoverable
 * via monotone recalibration) from "cannot rank" (untrustworthy).
 */
export function spearman(xs: number[], ys: number[]): number {
  if (xs.length !== ys.length || xs.length < 2) return 0;
  return pearson(ranksOf(xs), ranksOf(ys));
}

export interface CalibrationPair {
  itemId: string;
  /** Deterministic ground-truth quality of the answer (0..1). */
  truth: number;
  /** Normalized judge scores keyed by judge alias. */
  scores: Record<string, number>;
  /** Legacy 2-judge accessors (first/second judge). */
  scoreA: number;
  scoreB: number;
}

export interface JudgeTruthStats {
  judgeModel: string;
  /** Prices-resolved provider-native id — the eval cache key's judgeVersion
   * resolution, so calibration records stale in lockstep with eval rows. */
  resolvedModel: string;
  /** null when the truth vector is CONSTANT (live G0.2 finding: an answerer
   * that aces the corpus produces no correlation signal) — indeterminate,
   * not measurable. */
  pearsonVsTruth: number | null;
  /** Rank correlation vs truth (same nullability). A large spearman-pearson
   * gap means the judge RANKS correctly on a distorted scale — monotone
   * recalibration territory, not untrustworthiness. */
  spearmanVsTruth: number | null;
  meanAbsErr: number;
  /** No truth variance → the corpus cannot calibrate this judge; pick a
   * harder suite or a weaker answerer. Conservatively still flagged. */
  indeterminate: boolean;
  flagged: boolean; // pearsonVsTruth < CALIBRATION_FLAG_BELOW, or indeterminate
}

export interface CalibrationReport {
  n: number;
  judges: string[];
  /** Legacy 2-judge fields (first two judges). */
  judgeA: string;
  judgeB: string;
  /** Pairwise judge agreement (first two judges); NaN-free: 0 when <2. */
  pearson: number;
  /** True when ANY judge's pearsonVsTruth is below the flag line (or, with
   * ≥2 judges, when their agreement is). */
  flagged: boolean;
  pairs: CalibrationPair[];
  /** Per-judge trust stats vs deterministic ground truth (G0.2). */
  truth: JudgeTruthStats[];
  /** Real provider spend: answerer + all judge calls. */
  spendUsd: number;
  pricesVersion: string;
  answererModel: string;
  /** Items skipped (python code-exec etc.), with reasons. */
  skipped: Array<{ itemId: string; reason: string }>;
}

/** Judge-variant price entries (runtime extension of the table; mock judges, $0). */
export function withCalibrationJudges(prices: PriceTable): PriceTable {
  const additions: PriceEntry[] = CALIBRATION_JUDGES.map((alias) => ({
    alias,
    provider: 'mock' as const,
    model: `${alias}-v1`,
    inputPer1M: 0,
    outputPer1M: 0,
  }));
  const existing = new Set(prices.entries.map((e) => e.alias));
  return {
    ...prices,
    entries: [...prices.entries, ...additions.filter((e) => !existing.has(e.alias))],
  };
}

/** The synthetic llm-judge scoring view of a deterministic item — the judge
 * re-scores the answer through the REAL judge prompt builder. */
function judgeViewScoring(judgeModel: string): Extract<ScoringMethod, { kind: 'llm-judge' }> {
  return { kind: 'llm-judge', rubric: CALIBRATION_RUBRIC, judgeModel, scale: CALIBRATION_SCALE };
}

/**
 * Worst-case calibration projection: one answerer call per item + one judge
 * call per (item × judge), each at its enforced output ceiling. Uses the
 * synthetic llm-judge view so estimateJudgeScoringCall measures the REAL
 * prompt scaffolding.
 */
export function projectCalibrationCostUsd(
  items: EvalItem[],
  judgeModels: string[],
  answererModel: string,
  prices: PriceTable,
  judgeMaxTokens?: number,
): number {
  let total = 0;
  for (const item of items) {
    for (const call of estimateCalls({ type: 'single', model: answererModel }, inputTokensOfItem(item))) {
      total += estimateCallCostUsd(call, prices);
    }
    for (const judge of judgeModels) {
      const view: EvalItem = { ...item, scoring: judgeViewScoring(judge) };
      const call = estimateJudgeScoringCall(view);
      if (call) {
        // The projection binds to the configured judge budget (never assume).
        if (judgeMaxTokens !== undefined) call.outputTokens = judgeMaxTokens;
        total += estimateCallCostUsd(call, prices);
      }
    }
  }
  return total;
}

function inputTokensOfItem(item: EvalItem): number {
  const chars = item.prompt.reduce((a, m) => a + m.role.length + 1 + m.content.length, 0);
  return Math.ceil(chars / 4);
}

export interface CalibrationDeps {
  prices?: PriceTable;
  providers?: Record<ProviderId, Provider>;
  answererModel?: string;
  /** Judge aliases to calibrate. Default: the deterministic mock pair. */
  judgeModels?: string[];
  /** Preflight cap (USD): projection above this throws BudgetCapError
   * BEFORE any provider call. Default 0 — free (mock) calibrations pass,
   * anything priced refuses until a cap is set deliberately. */
  budgetCapUsd?: number;
  /** Judge completion budget (default PROTOCOL_MAX_TOKENS). Verbose judges
   * (sonnet-class) truncate mid-analysis at the default cap; raising it
   * here also raises the projection — the bound follows the config
   * (G0.5 truncation lesson, second instance). */
  judgeMaxTokens?: number;
}

function resolvedModelOf(prices: PriceTable, alias: string): string {
  return prices.entries.find((e) => e.alias === alias || e.model === alias)?.model ?? alias;
}

function addUsage(total: { spendUsd: number }, usage: Usage | undefined): void {
  if (usage) total.spendUsd += usage.costUsd;
}

/**
 * Calibrate judges against deterministic ground truth (G0.2). Items with
 * llm-judge scoring throw (no truth exists); unrunnable items (python
 * code-exec) are skipped with reasons. Deterministic end-to-end in mock
 * mode: answerer seeded by prompt hash, judges by
 * hash(judgeModel | itemId | answer).
 */
export async function runJudgeCalibration(
  items: EvalItem[],
  deps: CalibrationDeps = {},
): Promise<CalibrationReport> {
  const prices = withCalibrationJudges(deps.prices ?? loadPrices().table);
  const judges = deps.judgeModels ?? [...CALIBRATION_JUDGES];
  if (judges.length === 0) throw new Error('calibration requires at least one judge model');
  const answerer = deps.answererModel ?? CALIBRATION_ANSWERER;

  const disqualified = items.filter((i) => i.scoring.kind === 'llm-judge');
  if (disqualified.length > 0) {
    throw new Error(
      `calibration requires DETERMINISTIC ground truth — ${disqualified.length} llm-judge ` +
        `item(s) (e.g. '${disqualified[0]!.id}') carry no reference and cannot calibrate a judge`,
    );
  }
  const skipped: CalibrationReport['skipped'] = [];
  const runnable = items.filter((i) => {
    const reason = unrunnableReason(i);
    if (reason) skipped.push({ itemId: i.id, reason });
    return !reason;
  });

  // Preflight: refuse over-budget calibrations BEFORE any provider call.
  const cap = deps.budgetCapUsd ?? 0;
  const projected = projectCalibrationCostUsd(runnable, judges, answerer, prices, deps.judgeMaxTokens);
  if (projected > cap) throw new BudgetCapError(projected, cap);

  const mock = createMockProvider(prices);
  const providers: Record<ProviderId, Provider> = deps.providers ?? {
    anthropic: mock,
    openai: mock,
    google: mock,
    openrouter: mock,
    mock,
  };
  const ctx = { providers, prices, resolve: createResolver(providers, prices) };
  const scorerDeps: ScorerDeps = { providers, prices };
  const totals = { spendUsd: 0 };

  const pairs: CalibrationPair[] = [];
  for (const item of runnable) {
    const outcome = await execute({ type: 'single', model: answerer }, item.prompt, ctx);
    totals.spendUsd += outcome.usage.costUsd;
    const answer = outcome.text;
    const truthOutcome = await scoreAnswer(item, answer, scorerDeps);
    const scores: Record<string, number> = {};
    for (const judge of judges) {
      const judged = await scoreLlmJudge(
        item,
        answer,
        judgeViewScoring(judge),
        scorerDeps,
        deps.judgeMaxTokens,
      );
      addUsage(totals, judged.usage);
      scores[judge] = judged.quality;
    }
    pairs.push({
      itemId: item.id,
      truth: truthOutcome.quality,
      scores,
      scoreA: scores[judges[0]!]!,
      scoreB: judges.length > 1 ? scores[judges[1]!]! : scores[judges[0]!]!,
    });
  }

  const truths = pairs.map((p) => p.truth);
  const truthIsConstant = truths.length > 0 && truths.every((t) => t === truths[0]);
  const truth: JudgeTruthStats[] = judges.map((judge) => {
    const judgeScores = pairs.map((p) => p.scores[judge]!);
    const meanAbsErr =
      pairs.length > 0
        ? pairs.reduce((a, p) => a + Math.abs(p.scores[judge]! - p.truth), 0) / pairs.length
        : 0;
    if (truthIsConstant) {
      // No variance in ground truth → correlation is undefined; the corpus
      // cannot calibrate this judge (harder suite / weaker answerer needed).
      return {
        judgeModel: judge,
        resolvedModel: resolvedModelOf(prices, judge),
        pearsonVsTruth: null,
        spearmanVsTruth: null,
        meanAbsErr,
        indeterminate: true,
        flagged: true,
      };
    }
    const r = pearson(judgeScores, truths);
    const rho = spearman(judgeScores, truths);
    return {
      judgeModel: judge,
      resolvedModel: resolvedModelOf(prices, judge),
      pearsonVsTruth: r,
      spearmanVsTruth: rho,
      meanAbsErr,
      indeterminate: false,
      flagged: r < CALIBRATION_FLAG_BELOW,
    };
  });

  const agreement =
    judges.length > 1
      ? pearson(
          pairs.map((p) => p.scores[judges[0]!]!),
          pairs.map((p) => p.scores[judges[1]!]!),
        )
      : 0;

  return {
    n: pairs.length,
    judges,
    judgeA: judges[0]!,
    judgeB: judges[1] ?? judges[0]!,
    pearson: agreement,
    flagged:
      truth.some((t) => t.flagged) || (judges.length > 1 && agreement < CALIBRATION_FLAG_BELOW),
    pairs,
    truth,
    spendUsd: totals.spendUsd,
    pricesVersion: prices.version,
    answererModel: answerer,
    skipped,
  };
}
