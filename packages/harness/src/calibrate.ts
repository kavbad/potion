// Judge calibration (SPEC §5): two judge variants (mock-judge-a / mock-judge-b
// — INDEPENDENT noise seeds) double-score the same 30 answers; report the
// Pearson agreement on normalized 0..1 scores; flag < 0.8.
//
// The answers being judged come from a fixed weak answerer (mock-cheap single),
// so the double-scored set is a realistic mix of clean (~55%) and corrupted
// (~45%) answers. Both judges derive their base score from corpus ground truth
// and add independent seeded noise (±0.08 of scale), so their agreement
// measures exactly the noise-induced divergence — the calibration story.
import type { Provider } from '@potion/providers';
import type { EvalItem, PriceEntry, PriceTable, ProviderId } from '@potion/core';
import { createMockProvider, loadPrices } from '@potion/providers';
import { createResolver, execute } from '@potion/strategies';
import { scoreLlmJudge, type ScorerDeps } from './scorers.js';

export const CALIBRATION_JUDGES = ['mock-judge-a', 'mock-judge-b'] as const;
export const CALIBRATION_ANSWERER = 'mock-cheap';
export const CALIBRATION_FLAG_BELOW = 0.8;

export interface CalibrationPair {
  itemId: string;
  scoreA: number;
  scoreB: number;
}

export interface CalibrationReport {
  n: number;
  judgeA: string;
  judgeB: string;
  pearson: number;
  flagged: boolean; // pearson < CALIBRATION_FLAG_BELOW
  pairs: CalibrationPair[];
}

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
  if (sxx === 0 || syy === 0) return sxx === syy && sxy === sxx ? 1 : 0;
  return sxy / Math.sqrt(sxx * syy);
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

export interface CalibrationDeps {
  prices?: PriceTable;
  providers?: Record<ProviderId, Provider>;
  answererModel?: string;
}

/**
 * Double-score `items` (pass 30 for the gate report) with both judge variants.
 * Each item is answered once by the weak answerer (deterministic), then judged
 * twice. Deterministic end-to-end: the answerer is seeded by the prompt hash
 * (strategy default), each judge by hash(judgeModel | itemId | answer).
 */
export async function runJudgeCalibration(
  items: EvalItem[],
  deps: CalibrationDeps = {},
): Promise<CalibrationReport> {
  const prices = withCalibrationJudges(deps.prices ?? loadPrices().table);
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
  const answerer = deps.answererModel ?? CALIBRATION_ANSWERER;

  const pairs: CalibrationPair[] = [];
  for (const item of items) {
    const outcome = await execute({ type: 'single', model: answerer }, item.prompt, ctx);
    const answer = outcome.text;
    const scores: number[] = [];
    for (const judge of CALIBRATION_JUDGES) {
      const judged = await scoreLlmJudge(
        item,
        answer,
        {
          kind: 'llm-judge',
          rubric:
            'Score the answer for correctness against the task: full credit only when it is completely correct.',
          judgeModel: judge,
          scale: [0, 4],
        },
        scorerDeps,
      );
      // Calibration reports agreement only; judge-call usage (mock judges, $0)
      // is intentionally not part of the calibration artifact.
      scores.push(judged.quality);
    }
    pairs.push({ itemId: item.id, scoreA: scores[0]!, scoreB: scores[1]! });
  }

  const r = pearson(
    pairs.map((p) => p.scoreA),
    pairs.map((p) => p.scoreB),
  );
  return {
    n: pairs.length,
    judgeA: CALIBRATION_JUDGES[0],
    judgeB: CALIBRATION_JUDGES[1],
    pearson: r,
    flagged: r < CALIBRATION_FLAG_BELOW,
    pairs,
  };
}
