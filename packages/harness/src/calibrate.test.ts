// Judge calibration tests (SPEC §5 → G0.2): judges calibrated against
// DETERMINISTIC ground truth (+ the original pairwise-agreement story).
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadPrices } from '@potion/providers';
import { BudgetCapError } from './estimate.js';
import {
  pearson,
  projectCalibrationCostUsd,
  runJudgeCalibration,
  withCalibrationJudges,
} from './calibrate.js';
import { loadSuite, SIMULATED_SUITES_DIR } from './suites.js';

const PRICES_PATH = fileURLToPath(new URL('../../../prices.json', import.meta.url));

describe('pearson', () => {
  it('hand-computed on known vectors', () => {
    expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 10);
    expect(pearson([1, 2, 3], [6, 4, 2])).toBeCloseTo(-1, 10);
    expect(pearson([1, 1, 1], [1, 1, 1])).toBe(1); // constant-equal degenerate
    expect(pearson([1], [2])).toBe(0); // too few points
  });
});

describe('runJudgeCalibration', () => {
  it('two judge variants agree ≥ 0.8 on 30 double-scored answers', { timeout: 60_000 }, async () => {
    // code-gen.jsonl moved to suites/simulated/ (M1a mock-corpus quarantine);
    // calibration on it is a CI simulation by design.
    const items = loadSuite('code-gen', SIMULATED_SUITES_DIR).slice(0, 30);
    expect(items).toHaveLength(30);
    const report = await runJudgeCalibration(items, {
      prices: loadPrices(PRICES_PATH).table,
    });
    expect(report.n).toBe(30);
    expect(report.judgeA).toBe('mock-judge-a');
    expect(report.judgeB).toBe('mock-judge-b');
    // Independent noise: the two judges' scores are NOT identical…
    const differ = report.pairs.some((p) => p.scoreA !== p.scoreB);
    expect(differ).toBe(true);
    // …but they agree strongly because both derive from ground truth.
    expect(report.pearson).toBeGreaterThanOrEqual(0.8);
    expect(report.flagged).toBe(false);
    // G0.2: judge-vs-TRUTH stats — mock judges derive from corpus truth, so
    // each correlates strongly with the deterministic score.
    expect(report.truth).toHaveLength(2);
    for (const t of report.truth) {
      expect(t.pearsonVsTruth).toBeGreaterThanOrEqual(0.8);
      expect(t.flagged).toBe(false);
      expect(t.resolvedModel).toBe(`${t.judgeModel}-v1`);
      expect(t.meanAbsErr).toBeGreaterThanOrEqual(0);
    }
    expect(report.spendUsd).toBe(0); // mock — but RECORDED, not omitted
    expect(report.pairs.every((p) => typeof p.truth === 'number')).toBe(true);
    expect(report.skipped).toHaveLength(0);
  });

  it('rejects llm-judge items — no ground truth, nothing to calibrate against', async () => {
    const items = loadSuite('code-gen', SIMULATED_SUITES_DIR).slice(0, 2);
    const poisoned = [
      ...items,
      {
        ...items[0]!,
        id: 'no-truth-01',
        scoring: { kind: 'llm-judge' as const, rubric: 'r', judgeModel: 'mock-judge', scale: [0, 4] as [number, number] },
      },
    ];
    await expect(runJudgeCalibration(poisoned, { prices: loadPrices(PRICES_PATH).table })).rejects.toThrow(
      /DETERMINISTIC ground truth/,
    );
  });

  it('preflight-caps PRICED calibrations before any call (BudgetCapError)', async () => {
    const base = loadPrices(PRICES_PATH).table;
    // A judge priced like the real judge-class: projection > $0 cap → refuse.
    const items = loadSuite('extraction', SIMULATED_SUITES_DIR).slice(0, 5);
    const projected = projectCalibrationCostUsd(items, ['judge-class'], 'mock-cheap', base);
    expect(projected).toBeGreaterThan(0);
    await expect(
      runJudgeCalibration(items, { prices: base, judgeModels: ['judge-class'] }),
    ).rejects.toThrow(BudgetCapError);
    // With a covering cap the same call would proceed (proven by the mock
    // suite above; live judges are exercised in the capped live run).
  });

  it('single-judge calibration: agreement degenerates to 0, truth stats stand alone', async () => {
    const items = loadSuite('extraction', SIMULATED_SUITES_DIR).slice(0, 10);
    const report = await runJudgeCalibration(items, {
      prices: loadPrices(PRICES_PATH).table,
      judgeModels: ['mock-judge-a'],
    });
    expect(report.judges).toEqual(['mock-judge-a']);
    expect(report.pearson).toBe(0);
    expect(report.truth).toHaveLength(1);
    expect(report.truth[0]!.pearsonVsTruth).toBeGreaterThanOrEqual(0.8);
  });

  it('withCalibrationJudges adds both variants idempotently', () => {
    const base = loadPrices(PRICES_PATH).table;
    const once = withCalibrationJudges(base);
    const twice = withCalibrationJudges(once);
    expect(once.entries).toHaveLength(base.entries.length + 2);
    expect(twice.entries).toHaveLength(once.entries.length);
    expect(once.entries.find((e) => e.alias === 'mock-judge-a')?.provider).toBe('mock');
  });
});
