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
    // σ = sqrt(1/3), CI95 = 1.96·σ/√4
    expect(agg.qualityCi95).toBeCloseTo((1.96 * Math.sqrt(1 / 3)) / 2, 10);
    // mean cost 0.0025 × 1000
    expect(agg.costPer1K).toBeCloseTo(2.5, 10);
    // latencies [300,600,300,1800] sorted [300,300,600,1800]: p50 rank 2 → 300, p95 rank 4 → 1800
    expect(agg.latencyP50).toBe(300);
    expect(agg.latencyP95).toBe(1800);
    expect(agg.pricesVersion).toBe('v1');
  });

  it('CI95 is 0 for a single sample', () => {
    const agg = aggregateResults('extraction', 'sh', { type: 'single', model: 'mock-mid' }, [fakeResult(0.8, 0, 900)], 'v1');
    expect(agg.qualityCi95).toBe(0);
    expect(agg.qualityMean).toBe(0.8);
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
