// Aggregation math tests (SPEC §5 StrategyAggregate): hand-computed values.
import { describe, expect, it } from 'vitest';
import type { EvalResult } from '@potion/core';
import { aggregateResults, mean, percentileNearestRank, sampleStd } from './aggregate.js';

function fakeResult(quality: number, costUsd: number, latencyMs: number): EvalResult {
  return {
    runId: 'run-test',
    itemId: 'i',
    clusterId: 'code-gen',
    strategyHash: 'sh',
    strategyConfig: { type: 'single', model: 'mock-cheap' },
    quality,
    scorer: 'code-exec',
    usage: { inputTokens: 10, outputTokens: 10, costUsd, latencyMs },
    latencyMs: { p50: latencyMs, p95: latencyMs, mean: latencyMs },
    modelVersions: {},
    pricesVersion: 'v',
    cacheKey: 'k',
    createdAt: 't',
  };
}

describe('percentileNearestRank', () => {
  it('uses nearest-rank (ceil(p/100·n)) on sorted values', () => {
    const xs = [10, 30, 20, 50, 40, 90, 60, 70, 80, 100];
    expect(percentileNearestRank(xs, 50)).toBe(50); // rank ceil(5) = 5th
    expect(percentileNearestRank(xs, 95)).toBe(100); // rank ceil(9.5) = 10th
    expect(percentileNearestRank(xs, 10)).toBe(10);
    expect(percentileNearestRank([7], 95)).toBe(7);
    expect(percentileNearestRank([], 50)).toBe(0);
  });
});

describe('mean / sampleStd', () => {
  it('computes mean and sample (n−1) standard deviation', () => {
    expect(mean([1, 0, 1, 0])).toBe(0.5);
    expect(sampleStd([1, 0, 1, 0])).toBeCloseTo(Math.sqrt(1 / 3), 10);
    expect(sampleStd([0.7])).toBe(0);
  });
});

describe('aggregateResults', () => {
  it('matches hand-computed qualityMean/CI95/costPer1K/latency percentiles', () => {
    const results = [
      fakeResult(1, 0.001, 300),
      fakeResult(0, 0.003, 600),
      fakeResult(1, 0.002, 300),
      fakeResult(0, 0.004, 1800),
    ];
    const agg = aggregateResults('code-gen', 'sh', { type: 'single', model: 'mock-cheap' }, results, 'v1');
    expect(agg.n).toBe(4);
    expect(agg.qualityMean).toBe(0.5);
    // Jeffreys: s=2, n=4 → Beta(2.5, 2.5), symmetric about 0.5
    expect(agg.qualityCi).toBeDefined();
    expect(agg.qualityCi![0]).toBeCloseTo(0.122754, 5);
    expect(agg.qualityCi![1]).toBeCloseTo(0.877246, 5);
    // half-width = max distance from the mean to either bound
    expect(agg.qualityCi95).toBeCloseTo(0.877246 - 0.5, 5);
    // mean cost 0.0025 × 1000
    expect(agg.costPer1K).toBeCloseTo(2.5, 10);
    // latencies [300,600,300,1800] sorted [300,300,600,1800]: p50 rank 2 → 300, p95 rank 4 → 1800
    expect(agg.latencyP50).toBe(300);
    expect(agg.latencyP95).toBe(1800);
    expect(agg.pricesVersion).toBe('v1');
  });

  it('a single sample is honestly WIDE, never certain (2026-08-25 boundary fix)', () => {
    const agg = aggregateResults('extraction', 'sh', { type: 'single', model: 'mock-mid' }, [fakeResult(0.8, 0, 900)], 'v1');
    expect(agg.qualityMean).toBe(0.8);
    // Jeffreys with n=1, s=0.8 → Beta(1.3, 0.7): one observation proves little
    expect(agg.qualityCi![0]).toBeCloseTo(0.079735, 5);
    expect(agg.qualityCi![1]).toBeCloseTo(0.996153, 5);
    expect(agg.qualityCi95).toBeGreaterThan(0.5);
  });

  it('a perfect 42/42 reports a ≥-bound, not ±0.000 — the finding that forced this change', () => {
    const results = Array.from({ length: 42 }, () => fakeResult(1, 0.001, 300));
    const agg = aggregateResults('code-gen', 'sh', { type: 'single', model: 'mock-cheap' }, results, 'v1');
    expect(agg.qualityMean).toBe(1);
    expect(agg.qualityCi![1]).toBe(1);
    expect(agg.qualityCi![0]).toBeCloseTo(0.9423, 4);
    expect(agg.qualityCi95).toBeCloseTo(1 - 0.9423, 3); // the old code said 0 here
    expect(agg.evidence?.qualityCi).toEqual(agg.qualityCi);
  });

  it('costPer1K includes judge scoring cost (M1b: judge cost lives inside usage.costUsd)', () => {
    // Per item: strategy cost $0.0010 + judge scoring cost $0.0005, summed
    // upstream into usage.costUsd by the runner → $0.0015/item → $1.50/1K.
    // A strategy-only accounting would report $1.00/1K and undercount.
    const results = [fakeResult(1, 0.0015, 300), fakeResult(0, 0.0015, 600)];
    const agg = aggregateResults('code-gen', 'sh', { type: 'single', model: 'mock-cheap' }, results, 'v1');
    expect(agg.costPer1K).toBeCloseTo(1.5, 10);
    expect(agg.costPer1K).toBeGreaterThan(1.0);
  });
});

// ---------------------------------------------------------------------------
// G2.6 — latency provenance parity (owner requirement 2): a latency-driven
// selection must carry the same evidence a quality-driven one does.
// ---------------------------------------------------------------------------

describe('aggregateResults — latency provenance (G2.6)', () => {
  const CFG = { type: 'single', model: 'mock-cheap' } as const;
  const results = (latencies: number[]): EvalResult[] =>
    latencies.map((ms) => fakeResult(0.8, 0.001, ms));

  it('records latencyN, a bootstrap CI and the seed alongside the p95', () => {
    const agg = aggregateResults('code-gen', 'h1', CFG, results([100, 120, 140, 160, 900]), 'pv');
    expect(agg.evidence!.latencyN).toBe(5);
    expect(agg.evidence!.latencySeed).toBeGreaterThan(0);
    const [lo, hi] = agg.evidence!.latencyP95Ci95!;
    expect(lo).toBeLessThanOrEqual(hi);
  });

  it('the CI brackets the reported p95', () => {
    const agg = aggregateResults(
      'code-gen',
      'h1',
      CFG,
      results([100, 110, 120, 130, 140, 150, 160, 170, 180, 900]),
      'pv',
    );
    const [lo, hi] = agg.evidence!.latencyP95Ci95!;
    expect(lo).toBeLessThanOrEqual(agg.latencyP95);
    expect(hi).toBeGreaterThanOrEqual(agg.latencyP95);
  });

  it('is exactly reproducible — same rows → same interval and seed', () => {
    const rows = results([210, 190, 250, 300, 205, 260, 220]);
    const a = aggregateResults('code-gen', 'h1', CFG, rows, 'pv');
    const b = aggregateResults('code-gen', 'h1', CFG, rows, 'pv');
    expect(a.evidence!.latencyP95Ci95).toEqual(b.evidence!.latencyP95Ci95);
    expect(a.evidence!.latencySeed).toBe(b.evidence!.latencySeed);
  });

  it('the seed is derived from the EVIDENCE, so different latencies reseed', () => {
    const a = aggregateResults('code-gen', 'h1', CFG, results([100, 200, 300]), 'pv');
    const b = aggregateResults('code-gen', 'h1', CFG, results([100, 200, 301]), 'pv');
    expect(a.evidence!.latencySeed).not.toBe(b.evidence!.latencySeed);
  });

  it('no rows → no evidence block at all (nothing to attest)', () => {
    const agg = aggregateResults('code-gen', 'h1', CFG, [], 'pv');
    expect(agg.evidence).toBeUndefined();
  });
});

describe('evidence.toolsMeasured derivation (MIXING M3, instrument-keyed 2026-09-01)', () => {
  const withMeta = (over: Partial<EvalResult>): EvalResult => ({ ...fakeResult(1, 0.001, 300), ...over });

  it('a tools-instrument run with MIXED scorers (tool-call + field-contains) still marks toolsMeasured', () => {
    const agg = aggregateResults('agentic-tool-use', 'sh', { type: 'single', model: 'mock-cheap' }, [
      withMeta({ scorer: 'tool-call', instrument: 'tools' }),
      withMeta({ scorer: 'field-contains', instrument: 'tools' }),
    ], 'v1');
    expect(agg.evidence?.toolsMeasured).toBe(true);
  });

  it('legacy rows without an instrument keep the scorer derivation: all tool-call ⇒ tools', () => {
    const agg = aggregateResults('agentic-tool-use', 'sh', { type: 'single', model: 'mock-cheap' }, [
      withMeta({ scorer: 'tool-call' }),
      withMeta({ scorer: 'tool-call' }),
    ], 'v1');
    expect(agg.evidence?.toolsMeasured).toBe(true);
  });

  it('a default-instrument cell in the mix withholds the mark — evidence from another instrument never buys tool capability', () => {
    const agg = aggregateResults('agentic-tool-use', 'sh', { type: 'single', model: 'mock-cheap' }, [
      withMeta({ scorer: 'tool-call', instrument: 'tools' }),
      withMeta({ scorer: 'field-contains' }), // no instrument, non-tool scorer ⇒ default
    ], 'v1');
    expect(agg.evidence?.toolsMeasured).toBeUndefined();
  });
});
