// Judge calibration tests (SPEC §5): mock-judge-a vs mock-judge-b double-score
// 30 answers → Pearson agreement ≥ 0.8 (judge noise is independent, base score
// derives from shared corpus ground truth).
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadPrices } from '@potion/providers';
import { pearson, runJudgeCalibration, withCalibrationJudges } from './calibrate.js';
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
