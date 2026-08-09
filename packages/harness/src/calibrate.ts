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
import { BOOTSTRAP_RESAMPLES, bootstrapCi, mulberry32, seedFromString, sha256 } from '@potion/core';
import { createMockProvider, loadPrices } from '@potion/providers';
import { createResolver, execute } from '@potion/strategies';
import {
  BudgetCapError,
  estimateCallCostUsd,
  estimateCalls,
  estimateJudgeScoringCall,
} from './estimate.js';
import { scoreAnswer, scoreLlmJudge, type ScorerDeps } from './scorers.js';
import {
  MockAliasInLiveRunError, unrunnableReason } from './runner.js';

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

/**
 * Seeded bootstrap CI95 on a CORRELATION (G2.8) — closing a follow-up this
 * repo recorded against itself and then had to live with for six items.
 *
 * THE PROBLEM, in the project's own numbers: judge-class (sonnet) scored
 * pearson-vs-truth 0.544 on one live n=50 run and 0.637 on an identical
 * re-run. The recorded conclusion was "single-run correlations carry
 * ±0.1-scale error" — and the trust gate is a HARD comparison against 0.8.
 * A point estimate with ±0.1 error tested against a fixed line produces a
 * verdict that flips on resampling noise, which is not a verdict.
 *
 * Resamples PAIRS (not the two vectors independently — that would destroy the
 * pairing the correlation is about), reusing the platform's one pinned
 * bootstrap (G2.6 generalized `bootstrapCi` to an arbitrary statistic for
 * exactly this kind of use). Seeded from the data so the interval is
 * re-derivable from the stored `pairs` on the calibration row.
 *
 * Returns null below 4 pairs: a bootstrap over 3 points resamples the same
 * handful of values and reports a confidently wrong interval.
 */
export function correlationCi(
  xs: number[],
  ys: number[],
  kind: 'pearson' | 'spearman',
  seed: number,
  resamples: number = BOOTSTRAP_RESAMPLES,
): { estimate: number; ci95: [number, number] } | null {
  if (xs.length !== ys.length || xs.length < CORRELATION_CI_MIN_PAIRS) return null;
  const n = xs.length;
  const stat = kind === 'pearson' ? pearson : spearman;
  // bootstrapCi resamples a single value array; index-resampling preserves
  // the (x,y) pairing while reusing the pinned resampling loop verbatim.
  const indices = Array.from({ length: n }, (_, i) => i);
  const res = bootstrapCi(
    indices,
    (drawn) => stat(drawn.map((i) => xs[i]!), drawn.map((i) => ys[i]!)),
    seed,
    resamples,
  );
  return { estimate: stat(xs, ys), ci95: res.ci95 };
}

/** Below this, a bootstrap CI on a correlation is theatre. */
export const CORRELATION_CI_MIN_PAIRS = 4;

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
  /**
   * G2.8 — seeded bootstrap CI95 on each correlation. Null when the corpus is
   * too small (< CORRELATION_CI_MIN_PAIRS) or truth is constant.
   *
   * Read these, not the point estimate, when deciding trust: this project
   * measured the same judge at r=0.544 and r=0.637 on identical live runs, so
   * a point estimate compared against the hard 0.8 line flips on resampling
   * noise. `pearsonCi95[0] >= CALIBRATION_FLAG_BELOW` is the defensible
   * "clears the bar" claim; `pearsonCi95[1] < CALIBRATION_FLAG_BELOW` is the
   * defensible "fails it". An interval straddling 0.8 means the run did not
   * answer the question — which is itself the honest finding.
   */
  pearsonCi95: [number, number] | null;
  spearmanCi95: [number, number] | null;
  /** Seed behind both intervals — re-derivable from the stored pairs. */
  correlationSeed: number | null;
  /** True when the Pearson CI STRADDLES the flag line: the run is not
   * powered to render a verdict either way. */
  trustIndeterminateAtN: boolean;
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
  referenceAnchored = false,
): number {
  let total = 0;
  for (const item of items) {
    for (const call of estimateCalls({ type: 'single', model: answererModel }, inputTokensOfItem(item))) {
      total += estimateCallCostUsd(call, prices);
    }
    for (const judge of judgeModels) {
      const view: EvalItem = { ...item, scoring: judgeViewScoring(judge) };
      if (!referenceAnchored) delete view.reference;
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
  /** G2.4: the provider mode this calibration is RECORDED as. In 'live'
   * mode every resolved alias — judges AND the answerer — must be non-mock,
   * or the run refuses (MockAliasInLiveRunError). Pre-G2.4 `--provider live`
   * without an explicit answerer silently used mock-cheap and stamped the
   * resulting record provider_mode='live'. */
  providerMode?: 'mock' | 'live';
  /** G1.4: keep item references in the judge view (REFERENCE-ANCHORED
   * calibration — the replay-judging configuration). Default false:
   * reference-FREE, serve-parity, comparable with all recorded r/ρ/mAE. */
  referenceAnchored?: boolean;
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
  // G2.4 (false-live class): a LIVE-recorded calibration may not resolve ANY
  // mock alias — not the judges, and not the answerer whose default is
  // mock-cheap. Refuse before any provider call, the runner's convention.
  if (deps.providerMode === 'live') {
    const mockAliases = new Set(
      prices.entries.filter((e) => e.provider === 'mock').map((e) => e.alias),
    );
    const offending = [...judges, answerer].filter((a) => mockAliases.has(a));
    if (offending.length > 0) throw new MockAliasInLiveRunError([...new Set(offending)]);
  }

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
  const anchored = deps.referenceAnchored ?? false;
  const projected = projectCalibrationCostUsd(
    runnable,
    judges,
    answerer,
    prices,
    deps.judgeMaxTokens,
    anchored,
  );
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
      // G1.4: reference-free by default (serve parity, comparable records);
      // anchored mode keeps the item's reference in the judge prompt.
      const judgeItem: EvalItem = anchored ? item : { ...item, reference: undefined };
      if (!anchored) delete judgeItem.reference;
      const judged = await scoreLlmJudge(
        judgeItem,
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

  return assembleReport(pairs, judges, prices, totals.spendUsd, answerer, skipped);
}

// ─────────────────────────────────────────────────────────────────────────────
// Rubric-probe calibration (G1.5)
//
// llm-judge items have no deterministic truth, so a CANDIDATE rubric on a
// replay suite is calibrated against CONSTRUCTED truth built from the G1.4
// references: the reference verbatim (truth 1.0), the reference truncated at
// ~50% on a word boundary (truth 0.5), and a DIFFERENT item's reference via
// seeded rotation-derangement (truth 0.0). Probes ARE the answers — no
// answerer calls, 3n judge calls — and judging is reference-anchored by
// construction (the replay-judging configuration). The 0.5 label is a
// constructed approximation, so meanAbsErr is ADVISORY here; trust decisions
// hang on pearson/spearman (the existing 0.8 flag line): can the judge under
// this rubric separate perfect / partial / wrong on the cluster's own data?
// Records persist with answererModel 'synthetic-perturbation' so they can
// never be mistaken for G0.2 deterministic-truth evidence.
// ─────────────────────────────────────────────────────────────────────────────

export const RUBRIC_PROBE_MIN_REFERENCED = 3;
export const RUBRIC_PROBE_ANSWERER = 'synthetic-perturbation';

export class RubricProbeInsufficientError extends Error {
  constructor(readonly referencedCount: number) {
    super(
      `rubric probe calibration requires ≥ ${RUBRIC_PROBE_MIN_REFERENCED} referenced items ` +
        `(got ${referencedCount}) — the mismatch derangement and 3-level truth degenerate below that`,
    );
    this.name = 'RubricProbeInsufficientError';
  }
}

export type RubricProbeKind = 'reference' | 'truncated' | 'mismatch';

export interface RubricProbe {
  /** The replay item, reference KEPT (probes judge reference-anchored). */
  item: EvalItem;
  kind: RubricProbeKind;
  /** The probe answer the judge scores. */
  answer: string;
  /** Constructed truth: 1.0 / 0.5 (approximate) / 0.0. */
  truth: number;
}

/** Same stringification rule as the judge prompt builder: strings verbatim,
 * everything else JSON. */
function referenceTextOf(item: EvalItem): string {
  return typeof item.reference === 'string' ? item.reference : JSON.stringify(item.reference);
}

/** Cut at ~`fraction` of the text on a word boundary (hard cut when the
 * nearest boundary is degenerate). Deterministic. */
export function truncateAtWordBoundary(text: string, fraction = 0.5): string {
  const cut = Math.max(1, Math.floor(text.length * fraction));
  const boundary = text.lastIndexOf(' ', cut);
  return text.slice(0, boundary > cut * 0.5 ? boundary : cut);
}

/**
 * Build the probe set: 3 probes per referenced item. The mismatch answer is
 * another item's reference chosen by seeded ROTATION (offset k ∈ [1, n-1]) —
 * a derangement by construction, so no item is ever "mismatched" with its
 * own reference. Deterministic under `seed`.
 */
export function buildRubricProbes(items: EvalItem[], seed: number): RubricProbe[] {
  const referenced = items.filter((i) => i.reference !== undefined);
  if (referenced.length < RUBRIC_PROBE_MIN_REFERENCED) {
    throw new RubricProbeInsufficientError(referenced.length);
  }
  const rng = mulberry32(seed);
  const k = 1 + Math.floor(rng() * (referenced.length - 1));
  const probes: RubricProbe[] = [];
  for (let i = 0; i < referenced.length; i++) {
    const item = referenced[i]!;
    const ref = referenceTextOf(item);
    const other = referenceTextOf(referenced[(i + k) % referenced.length]!);
    probes.push(
      { item, kind: 'reference', answer: ref, truth: 1 },
      { item, kind: 'truncated', answer: truncateAtWordBoundary(ref), truth: 0.5 },
      { item, kind: 'mismatch', answer: other, truth: 0 },
    );
  }
  return probes;
}

/** The candidate-rubric scoring view of a probe: the item's own judge config
 * (scale, judge default) with the rubric under test swapped in. */
function probeScoring(
  probe: RubricProbe,
  rubricText: string,
  judgeModel: string,
): Extract<ScoringMethod, { kind: 'llm-judge' }> {
  const scale: [number, number] =
    probe.item.scoring.kind === 'llm-judge' ? probe.item.scoring.scale : [0, 1];
  return { kind: 'llm-judge', rubric: rubricText, judgeModel, scale };
}

/**
 * Worst-case probe-calibration projection: one judge call per (probe ×
 * judge) — no answerer leg (probes are the answers). The embedded answer is
 * the probe's actual text, so the bound is measured, not assumed.
 */
export function projectProbeCalibrationCostUsd(
  probes: RubricProbe[],
  rubricText: string,
  judgeModels: string[],
  prices: PriceTable,
  judgeMaxTokens?: number,
): number {
  let total = 0;
  for (const probe of probes) {
    for (const judge of judgeModels) {
      const view: EvalItem = { ...probe.item, scoring: probeScoring(probe, rubricText, judge) };
      const call = estimateJudgeScoringCall(view, Math.ceil(probe.answer.length / 4));
      if (call) {
        if (judgeMaxTokens !== undefined) call.outputTokens = judgeMaxTokens;
        total += estimateCallCostUsd(call, prices);
      }
    }
  }
  return total;
}

export interface RubricProbeCalibrationDeps extends Omit<CalibrationDeps, 'answererModel' | 'referenceAnchored'> {
  /** Probe-construction seed (derangement offset). Default 1. */
  seed?: number;
}

/**
 * Calibrate a CANDIDATE rubric on a replay suite via perturbation probes.
 * Reference-anchored by construction; preflight-capped like every priced
 * path. Pair ids are `<itemId>#<probeKind>`.
 */
export async function runRubricProbeCalibration(
  items: EvalItem[],
  rubricText: string,
  deps: RubricProbeCalibrationDeps = {},
): Promise<CalibrationReport> {
  const prices = withCalibrationJudges(deps.prices ?? loadPrices().table);
  const judges = deps.judgeModels ?? [...CALIBRATION_JUDGES];
  if (judges.length === 0) throw new Error('probe calibration requires at least one judge model');
  const probes = buildRubricProbes(items, deps.seed ?? 1);

  const cap = deps.budgetCapUsd ?? 0;
  const projected = projectProbeCalibrationCostUsd(
    probes,
    rubricText,
    judges,
    prices,
    deps.judgeMaxTokens,
  );
  if (projected > cap) throw new BudgetCapError(projected, cap);

  const mock = createMockProvider(prices);
  const providers: Record<ProviderId, Provider> = deps.providers ?? {
    anthropic: mock,
    openai: mock,
    google: mock,
    openrouter: mock,
    mock,
  };
  const scorerDeps: ScorerDeps = { providers, prices };
  const totals = { spendUsd: 0 };

  const pairs: CalibrationPair[] = [];
  for (const probe of probes) {
    const scores: Record<string, number> = {};
    for (const judge of judges) {
      const judged = await scoreLlmJudge(
        probe.item,
        probe.answer,
        probeScoring(probe, rubricText, judge),
        scorerDeps,
        deps.judgeMaxTokens,
      );
      addUsage(totals, judged.usage);
      scores[judge] = judged.quality;
    }
    pairs.push({
      itemId: `${probe.item.id}#${probe.kind}`,
      truth: probe.truth,
      scores,
      scoreA: scores[judges[0]!]!,
      scoreB: judges.length > 1 ? scores[judges[1]!]! : scores[judges[0]!]!,
    });
  }

  return assembleReport(pairs, judges, prices, totals.spendUsd, RUBRIC_PROBE_ANSWERER, []);
}

/** Shared report assembly: per-judge truth stats (INDETERMINATE on constant
 * truth), pairwise agreement, flag aggregation. Used by both deterministic
 * (G0.2) and rubric-probe (G1.5) calibrations. */
function assembleReport(
  pairs: CalibrationPair[],
  judges: string[],
  prices: PriceTable,
  spendUsd: number,
  answererModel: string,
  skipped: CalibrationReport['skipped'],
): CalibrationReport {
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
        pearsonCi95: null,
        spearmanCi95: null,
        correlationSeed: null,
        trustIndeterminateAtN: false,
        indeterminate: true,
        flagged: true,
      };
    }
    const r = pearson(judgeScores, truths);
    const rho = spearman(judgeScores, truths);
    // Seeded from the evidence itself so the interval is reproducible from
    // the persisted `pairs` — same discipline as every other verdict here.
    const corrSeed = seedFromString(
      `corr|${judge}|${pairs.length}|${sha256(JSON.stringify([judgeScores, truths]))}`,
    );
    const pCi = correlationCi(judgeScores, truths, 'pearson', corrSeed);
    const sCi = correlationCi(judgeScores, truths, 'spearman', corrSeed);
    return {
      judgeModel: judge,
      resolvedModel: resolvedModelOf(prices, judge),
      pearsonVsTruth: r,
      spearmanVsTruth: rho,
      meanAbsErr,
      pearsonCi95: pCi?.ci95 ?? null,
      spearmanCi95: sCi?.ci95 ?? null,
      correlationSeed: pCi === null ? null : corrSeed,
      // The interval spans the bar → this run cannot answer the trust
      // question at this n. Reported, never silently rounded to a verdict.
      trustIndeterminateAtN:
        pCi !== null && pCi.ci95[0] < CALIBRATION_FLAG_BELOW && pCi.ci95[1] >= CALIBRATION_FLAG_BELOW,
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
    spendUsd,
    pricesVersion: prices.version,
    answererModel,
    skipped,
  };
}
