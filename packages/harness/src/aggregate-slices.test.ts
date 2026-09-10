// A BOUNDARY point's quality is the WEAKEST of its parent slices. The union
// mean would let a model strong on one half and weak on the other clear the
// floor for both — ling at ~0.96 on reasoning and ~0.81 on extraction averages
// ~0.89 — which is precisely the failure the boundary frontier exists to stop.
import { describe, expect, it } from 'vitest';
import type { EvalResult } from '@potion/core';
import { aggregateResults } from './aggregate.js';

const cell = (itemId: string, quality: number): EvalResult => ({
  cacheKey: `k-${itemId}`, runId: 'r', itemId, clusterId: 'a+b', strategyHash: 's', strategyConfig: { type: 'single', model: 'm' },
  quality, scorer: 'exact', usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.001, latencyMs: 100 }, modelVersions: {}, pricesVersion: 'p', createdAt: 't',
});
const cells = [
  ...Array.from({ length: 10 }, (_, i) => cell(`a-${i}`, 1)),        // slice a: perfect
  ...Array.from({ length: 10 }, (_, i) => cell(`b-${i}`, i < 6 ? 1 : 0)), // slice b: 0.6
];
const sliceOf = (id: string) => (id.startsWith('a-') ? 'a' : 'b');

describe('aggregateResults with slices', () => {
  it('reports the weakest slice as the point quality, and every slice in evidence', () => {
    const agg = aggregateResults('a+b', 's', { type: 'single', model: 'm' }, cells, 'p', 'live', sliceOf);
    expect(agg.qualityMean).toBeCloseTo(0.6, 6);            // not the union mean 0.8
    expect(agg.n).toBe(20);
    expect(agg.evidence?.slices).toBeDefined();
    expect(agg.evidence?.slices?.a).toMatchObject({ n: 10, quality: 1 });
    expect(agg.evidence?.slices?.b).toMatchObject({ n: 10, quality: 0.6 });
    // the interval is the weak slice's interval, not the union's tighter one
    expect(agg.qualityCi95).toBeGreaterThan(aggregateResults('a+b', 's', { type: 'single', model: 'm' }, cells, 'p', 'live').qualityCi95);
  });
  it('without slices (or with one), behaviour is byte-for-byte the union mean', () => {
    const plain = aggregateResults('a+b', 's', { type: 'single', model: 'm' }, cells, 'p', 'live');
    expect(plain.qualityMean).toBeCloseTo(0.8, 6);
    expect(plain.evidence?.slices).toBeUndefined();
    const one = aggregateResults('a', 's', { type: 'single', model: 'm' }, cells, 'p', 'live', () => 'a');
    expect(one.qualityMean).toBeCloseTo(0.8, 6);
    expect(one.evidence?.slices).toBeUndefined();
  });
});
