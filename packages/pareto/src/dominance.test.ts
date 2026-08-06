// Dominance & computeFrontier unit tests — hand-computed sets (SPEC §6):
// obvious domination, tie handling, no-domination, single point, epsilon.
import { describe, expect, it } from 'vitest';
import type { FrontierPoint, StrategyAggregate, StrategyConfig } from '@potion/core';
import { DOMINANCE_EPSILON, aggregateToPoint, computeFrontier, isDominated } from './dominance.js';

const SINGLE_FRONTIER: StrategyConfig = { type: 'single', model: 'mock-frontier' };
const SINGLE_MID: StrategyConfig = { type: 'single', model: 'mock-mid' };
const SINGLE_CHEAP: StrategyConfig = { type: 'single', model: 'mock-cheap' };

function point(
  hash: string,
  quality: number,
  costPer1K: number,
  latencyP95: number,
  cfg: StrategyConfig = SINGLE_MID,
): FrontierPoint {
  return { clusterId: 'code-gen', strategyHash: hash, strategyConfig: cfg, quality, costPer1K, latencyP95 };
}

function agg(
  hash: string,
  qualityMean: number,
  costPer1K: number,
  latencyP95: number,
  cfg: StrategyConfig = SINGLE_MID,
): StrategyAggregate {
  return {
    clusterId: 'code-gen',
    strategyHash: hash,
    strategyConfig: cfg,
    qualityMean,
    qualityCi95: 0.01,
    n: 30,
    costPer1K,
    latencyP50: latencyP95 / 2,
    latencyP95,
    pricesVersion: 'test-v1',
  };
}

describe('isDominated', () => {
  it('obvious domination: q better on every axis → returns q', () => {
    const p = point('p', 0.7, 2.0, 1000);
    const q = point('q', 0.9, 1.0, 500);
    expect(isDominated(p, [q])).toBe(q);
  });

  it('domination with two equal axes and one strict', () => {
    const p = point('p', 0.8, 1.0, 900);
    const q = point('q', 0.8, 0.5, 900); // same quality+latency, strictly cheaper
    expect(isDominated(p, [q])).toBe(q);
  });

  it('trade-off is NOT domination (q cheaper but lower quality)', () => {
    const p = point('p', 0.8, 1.0, 900);
    const q = point('q', 0.7, 0.5, 900);
    expect(isDominated(p, [q])).toBeNull();
  });

  it('a point never dominates itself; same-hash duplicates are skipped', () => {
    const p = point('dup', 0.8, 1.0, 900);
    const sameHashBetter = point('dup', 0.99, 0.01, 1);
    expect(isDominated(p, [p])).toBeNull();
    expect(isDominated(p, [sameHashBetter])).toBeNull();
  });

  it('near-ties within epsilon count as equal (no strict axis → not dominated)', () => {
    const eps = DOMINANCE_EPSILON;
    const p = point('p', 0.8, 1.0, 900);
    // q is better on every axis but by less than epsilon on each → no strict axis.
    const q = point('q', 0.8 + eps / 2, 1.0 - eps / 2, 900 - eps / 2);
    expect(isDominated(p, [q])).toBeNull();
  });

  it('near-tie with one axis strict beyond epsilon → dominated', () => {
    const eps = DOMINANCE_EPSILON;
    const p = point('p', 0.8, 1.0, 900);
    const q = point('q', 0.8 + eps / 2, 1.0 - 10 * eps, 900);
    expect(isDominated(p, [q])).toBe(q);
  });

  it('returns the FIRST dominator in `others` order', () => {
    const p = point('p', 0.5, 5, 5000);
    const q1 = point('q1', 0.6, 4, 4000);
    const q2 = point('q2', 0.9, 1, 1000);
    expect(isDominated(p, [q1, q2])).toBe(q1);
    expect(isDominated(p, [q2, q1])).toBe(q2);
  });
});

describe('computeFrontier', () => {
  it('obvious domination: dominated point excluded, dominators kept, sorted by cost asc', () => {
    const cheap = agg('cheap', 0.5, 0.1, 300, SINGLE_CHEAP);
    const dominated = agg('dominated', 0.6, 5.0, 2000, SINGLE_MID); // worse than 'mid' on all axes
    const mid = agg('mid', 0.75, 0.6, 900, SINGLE_MID);
    const frontier = agg('frontier', 0.95, 6.0, 1800, SINGLE_FRONTIER);
    const result = computeFrontier([dominated, frontier, cheap, mid]);
    expect(result.map((p) => p.strategyHash)).toEqual(['cheap', 'mid', 'frontier']);
  });

  it('no domination: all points kept (quality/cost trade-off curve)', () => {
    const a = agg('a', 0.5, 0.1, 300);
    const b = agg('b', 0.7, 0.6, 900);
    const c = agg('c', 0.9, 3.0, 1800);
    const result = computeFrontier([c, a, b]);
    expect(result.map((p) => p.strategyHash)).toEqual(['a', 'b', 'c']);
  });

  it('single point → frontier of one', () => {
    const result = computeFrontier([agg('only', 0.66, 1.2, 700)]);
    expect(result).toHaveLength(1);
    expect(result[0]!.strategyHash).toBe('only');
    expect(result[0]!.quality).toBeCloseTo(0.66);
  });

  it('tie handling: same strategyHash twice → ONE copy kept', () => {
    const a1 = agg('same', 0.7, 1.0, 900);
    const a2 = agg('same', 0.7, 1.0, 900);
    const result = computeFrontier([a1, a2]);
    expect(result).toHaveLength(1);
  });

  it('tie handling: different strategies, identical coordinates → ONE kept', () => {
    const a = agg('aaa', 0.7, 1.0, 900, SINGLE_CHEAP);
    const b = agg('bbb', 0.7, 1.0, 900, SINGLE_FRONTIER);
    const result = computeFrontier([a, b]);
    expect(result).toHaveLength(1);
    expect(result[0]!.strategyHash).toBe('aaa'); // deterministic: hash asc
  });

  it('quality comes from qualityMean, latency from latencyP95 (mapping contract)', () => {
    const a = aggregateToPoint(agg('x', 0.42, 3.3, 1234));
    expect(a.quality).toBe(0.42);
    expect(a.latencyP95).toBe(1234);
    expect(a.costPer1K).toBe(3.3);
  });

  it('latency dominates too: equal quality+cost, slower point excluded', () => {
    const fast = agg('fast', 0.7, 1.0, 300);
    const slow = agg('slow', 0.7, 1.0, 2500);
    const result = computeFrontier([fast, slow]);
    expect(result.map((p) => p.strategyHash)).toEqual(['fast']);
  });

  it('empty input → empty frontier', () => {
    expect(computeFrontier([])).toEqual([]);
  });
});
