// THE LOWER-BOUND LAW (CI campaign, 2026-09-01): a quality FLOOR is a
// promise to the customer, so FEASIBILITY tests the bound the evidence can
// PROVE — qualityCi[0] when the pair exists, mean − qualityCi95 as the
// conservative fallback, the bare mean only for legacy points that carry no
// interval at all. RANKINGS stay mean-based: among qualifying points the
// best estimate still picks, so intervals never invert an ordering — they
// only gate what may qualify. Found by the 2026-08-31 external review
// ("point-estimate quality decisions"); the template is shadow-evidence.ts
// ("statistically good enough, not point-estimate good enough").
import { describe, expect, it } from 'vitest';
import type { Frontier, FrontierPoint } from './types.js';
import { qualityLowerBound, selectPoint } from './select.js';

function pt(hash: string, quality: number, costPer1K: number, over: Partial<FrontierPoint> = {}): FrontierPoint {
  return {
    clusterId: 'code-gen',
    strategyHash: hash,
    strategyConfig: { type: 'single', model: hash },
    quality,
    costPer1K,
    latencyP95: 800,
    ...over,
  };
}

function evidenceOf(
  over: Partial<NonNullable<FrontierPoint['evidence']>>,
): NonNullable<FrontierPoint['evidence']> {
  return {
    cacheKeys: ['ck-lb'],
    runIds: ['run-lb'],
    n: 40,
    qualityCi95: 0,
    suiteContentHash: 'e'.repeat(64),
    ...over,
  };
}

function frontierOf(points: FrontierPoint[]): Frontier {
  return {
    id: 'f-lb',
    clusterId: 'code-gen',
    version: 1,
    parentId: null,
    trigger: 'manual',
    pricesVersion: 'test',
    createdAt: new Date(0).toISOString(),
    points,
  };
}

describe('qualityLowerBound', () => {
  it('prefers the qualityCi pair, falls back to mean − qualityCi95, then the bare mean', () => {
    expect(qualityLowerBound(pt('a', 0.96, 1, { evidence: evidenceOf({ qualityCi: [0.93, 0.99], qualityCi95: 0.05 }) }))).toBe(0.93);
    expect(qualityLowerBound(pt('b', 0.96, 1, { evidence: evidenceOf({ qualityCi95: 0.03 }) }))).toBeCloseTo(0.93, 10);
    expect(qualityLowerBound(pt('c', 0.96, 1))).toBe(0.96);
  });
});

describe('feasibility tests the PROVEN bound', () => {
  it('an evidence-bearing point whose mean clears the floor but whose lower bound does not is INFEASIBLE', () => {
    // mean 0.96 reads above the 0.95 floor, but the interval only proves
    // 0.93 — serving may not promise a bar the evidence cannot hold.
    const uncertain = pt('uncertain', 0.96, 1, { evidence: evidenceOf({ qualityCi: [0.93, 0.99] }) });
    expect(selectPoint({ type: 'min_cost', qualityFloor: 0.95 }, frontierOf([uncertain]))).toBeNull();
    // The same point qualifies against a floor its bound actually clears.
    expect(selectPoint({ type: 'min_cost', qualityFloor: 0.9 }, frontierOf([uncertain]))?.strategyHash).toBe('uncertain');
  });

  it('a legacy point with no interval qualifies on its mean (no retroactive refusal)', () => {
    const legacy = pt('legacy', 0.96, 1);
    expect(selectPoint({ type: 'min_cost', qualityFloor: 0.95 }, frontierOf([legacy]))?.strategyHash).toBe('legacy');
  });

  it('the proven point wins over a cheaper unproven-at-the-floor point', () => {
    const cheapUncertain = pt('cheap', 0.96, 1, { evidence: evidenceOf({ qualityCi: [0.93, 0.99] }) });
    const provenPricier = pt('proven', 0.96, 4, { evidence: evidenceOf({ qualityCi: [0.955, 0.97] }) });
    expect(selectPoint({ type: 'min_cost', qualityFloor: 0.95 }, frontierOf([cheapUncertain, provenPricier]))?.strategyHash).toBe('proven');
  });

  it('compound gates on the bound too', () => {
    const uncertain = pt('uncertain', 0.96, 1, { evidence: evidenceOf({ qualityCi: [0.93, 0.99] }), latencyP95: 400 });
    expect(selectPoint({ type: 'compound', qualityFloor: 0.95, p95Ms: 1000 }, frontierOf([uncertain]))).toBeNull();
    expect(selectPoint({ type: 'compound', qualityFloor: 0.9, p95Ms: 1000 }, frontierOf([uncertain]))?.strategyHash).toBe('uncertain');
  });
});

describe('rankings stay mean-based', () => {
  it('max_quality picks the higher MEAN even when its lower bound is worse', () => {
    // Both qualify (no floor in play); the best estimate still ranks.
    const wideHighMean = pt('wide', 0.97, 5, { evidence: evidenceOf({ qualityCi: [0.9, 0.995] }) });
    const tightLowerMean = pt('tight', 0.94, 5, { evidence: evidenceOf({ qualityCi: [0.93, 0.95] }) });
    expect(selectPoint({ type: 'max_quality', costCeilingPer1K: 10 }, frontierOf([wideHighMean, tightLowerMean]))?.strategyHash).toBe('wide');
  });
});
