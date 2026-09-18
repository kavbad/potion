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

// THE DECISION, PINNED. A future contributor reading the review will reach for
// a fourth dominance axis; this test is here to make them read the reason
// first. Reliability is not on the frontier because the frontier RANKS, and
// the only reliability evidence Potion has is observational — routing decided
// which requests each strategy saw. Delete this test only alongside a causal
// source (per-item outcomes under the randomized holdout).
describe('reliability is deliberately NOT a dominance axis', () => {
  const pt = (hash: string, quality: number, cost: number, lat: number): FrontierPoint => ({
    clusterId: 'code-gen', strategyHash: hash, strategyConfig: { type: 'single', model: hash },
    quality, costPer1K: cost, latencyP95: lat,
  });

  it('dominance still reads exactly three objectives', () => {
    const worse = pt('a', 0.8, 2, 1000);
    const better = pt('b', 0.9, 1, 900);
    expect(isDominated(worse, [better])).toBe(better);
    // An unreliable-but-otherwise-better point still dominates, because the
    // frontier has no honest way to know it is unreliable. That is a stated
    // limit, not an oversight — costPerSuccess is where reliability shows up.
    const flaky = { ...pt('c', 0.95, 0.5, 800) };
    expect(isDominated(worse, [flaky])).toBe(flaky);
  });
});

describe('provability is an objective (2026-09-18)', () => {
  const withEvidence = (p: FrontierPoint, n: number, half: number): FrontierPoint => ({ ...p, evidence: { cacheKeys: [], runIds: [], n, qualityCi95: half } });
  it('a cheaper point with a higher MEAN but a lower LOWER BOUND does not dominate the provable one', () => {
    const sonnet = withEvidence(point('h-sonnet', 0.906, 3.651, 6010), 32, 0.044); // lower 0.862
    const luna = withEvidence(point('h-luna', 0.911, 0.252, 5000), 28, 0.146); // lower 0.765
    expect(isDominated(sonnet, [luna])).toBeNull();
    expect(isDominated(luna, [sonnet])).toBeNull(); // a genuine trade-off: cheaper vs provable
  });
  it('a cheaper point that is ALSO at least as provable still dominates', () => {
    const pricey = withEvidence(point('h-pricey', 0.90, 3.0, 5000), 30, 0.05); // lower 0.85
    const cheap = withEvidence(point('h-cheap', 0.91, 0.3, 4000), 30, 0.05); // lower 0.86
    expect(isDominated(pricey, [cheap])?.strategyHash).toBe('h-cheap');
  });
  it('computeFrontier keeps the provable anchor beside the cheaper wide-interval point', () => {
    const aggs = [
      { ...agg('h-sonnet', 0.906, 3.651, 6010), qualityCi95: 0.044, evidence: { cacheKeys: [], runIds: [], n: 32, qualityCi95: 0.044 } },
      { ...agg('h-luna', 0.911, 0.252, 5000), qualityCi95: 0.146, evidence: { cacheKeys: [], runIds: [], n: 28, qualityCi95: 0.146 } },
    ] as StrategyAggregate[];
    expect(computeFrontier(aggs).map((p) => p.strategyHash)).toEqual(['h-luna', 'h-sonnet']);
  });
});
