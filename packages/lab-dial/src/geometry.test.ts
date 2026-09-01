// Dial geometry: ladder construction, the R/M/K 3-axis pins (tolerance
// flips, evidence-sourced relax hint), the one-authority behavioral pin,
// and the partition-under-motion property loop.
import { describe, expect, it } from 'vitest';
import { selectPoint, type Frontier, type FrontierPoint } from '@potion/core';
import { buildDialDomain, dialViews, viewPosition, DEFAULT_TOLERANCE_HEADROOM } from './geometry.js';

function pt(over: Partial<FrontierPoint> & { strategyHash: string }): FrontierPoint {
  return {
    clusterId: 'summarization',
    strategyConfig: { type: 'single', model: 'm' },
    quality: 0.8,
    costPer1K: 0.01,
    latencyP95: 800,
    providerMode: 'live',
    evidence: { cacheKeys: ['ck'], runIds: ['r'], n: 14, qualityCi95: 0.02, suiteContentHash: 'e'.repeat(64) },
    ...over,
  };
}

function frontier(points: FrontierPoint[], id = 'fr-geo-1'): Frontier {
  return {
    id, clusterId: 'summarization', version: 4, parentId: null, trigger: 'recompute',
    points, pricesVersion: 'pv', createdAt: '',
  } as unknown as Frontier;
}

// The Step 6 executed counterexample, now the dial's canonical 3-axis case.
const R = pt({ strategyHash: 'rr', quality: 0.9, costPer1K: 1.0, latencyP95: 1300 });
const M = pt({ strategyHash: 'mm', quality: 0.3, costPer1K: 1.05, latencyP95: 40 });
const K = pt({ strategyHash: 'kk', quality: 0.9, costPer1K: 1.15, latencyP95: 900 });
const CASCADE = pt({
  strategyHash: 'cc',
  quality: 0.95,
  costPer1K: 0.02,
  latencyP95: 1500,
  strategyConfig: { type: 'cascade', stages: [{ model: 'a' }, { model: 'b' }], confidenceMethod: 'self-report-calibrated' },
});

function domainOf(points: FrontierPoint[], toolBearing = false) {
  const r = buildDialDomain({ frontier: frontier(points), clusterId: 'summarization', slot: 'brain', toolBearing });
  if (!r.ok) throw new Error(`unexpected gap ${r.gap.code}`);
  return r.domain;
}

describe('ladder + default tolerance', () => {
  it('distinct exact-float qualities ascending; equal qualities collapse to one rung', () => {
    const d = domainOf([R, M, K]);
    // CI campaign (2026-09-01): rungs are PROVEN bounds — each point's
    // interval lower bound (mean − ci95 here), not its mean. Float dust
    // from the subtraction is exact-float by design.
    expect(d.ladder).toEqual([0.3 - 0.02, 0.9 - 0.02]);
    expect(d.defaultToleranceMs).toBe(Math.ceil(1300 * DEFAULT_TOLERANCE_HEADROOM));
  });
});

describe('the R/M/K 3-axis pins', () => {
  it('default tolerance → R serves the 0.9 rung (min cost)', () => {
    const d = domainOf([R, M, K]);
    const v = viewPosition(d, { qualityIndex: 1 });
    expect(v.feasible && v.strategyHash).toBe('rr');
  });
  it('tolerance 1000 → the SAME rung flips to K (the latency knob exposing the third axis)', () => {
    const d = domainOf([R, M, K]);
    const v = viewPosition(d, { qualityIndex: 1, toleranceMs: 1000 });
    expect(v.feasible && v.strategyHash).toBe('kk');
  });
  it('tolerance 30 → position-infeasible with the EVIDENCE-SOURCED relax hint (K exact p95)', () => {
    const d = domainOf([R, M, K]);
    const v = viewPosition(d, { qualityIndex: 1, toleranceMs: 30 });
    expect(v.feasible).toBe(false);
    if (!v.feasible) {
      expect(v.gap.code).toBe('position-infeasible');
      expect(v.gap.relaxHintMs).toBe(900); // K.latencyP95, a frontier-row value
    }
  });
});

describe('one selection authority (behavioral pin)', () => {
  it('every feasible view field equals the selectPoint result field on the adversarial frontier', () => {
    const d = domainOf([R, M, K]);
    for (const tol of [undefined, 1000, 2000]) {
      for (const v of dialViews(d, tol)) {
        if (!v.feasible) continue;
        const selected = selectPoint(v.policy, frontier([R, M, K]));
        expect(selected).not.toBeNull();
        expect(v.strategyHash).toBe(selected!.strategyHash);
        expect(v.quality).toBe(selected!.quality);
        expect(v.costPer1K).toBe(selected!.costPer1K);
        expect(v.latencyP95).toBe(selected!.latencyP95);
      }
    }
  });
});

describe('partition under motion (property loop)', () => {
  it('tool-bearing domains never yield a composite across full sweeps, any tolerance', () => {
    let seed = 424242;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 200; i++) {
      const points: FrontierPoint[] = [];
      const n = 2 + Math.floor(rnd() * 5);
      for (let j = 0; j < n; j++) {
        const composite = rnd() < 0.4;
        points.push(
          pt({
            strategyHash: `s${i}-${j}`,
            quality: Math.round(rnd() * 100) / 100,
            costPer1K: Math.round(rnd() * 1000) / 1000 + 0.001,
            latencyP95: Math.ceil(rnd() * 3000) + 1,
            ...(composite
              ? { strategyConfig: { type: 'cascade', stages: [{ model: 'a' }, { model: 'b' }], confidenceMethod: 'self-report-calibrated' } }
              : {}),
          }),
        );
      }
      const r = buildDialDomain({ frontier: frontier(points, `fr-prop-${i}`), clusterId: 'summarization', slot: 'tools', toolBearing: true });
      if (!r.ok) {
        expect(r.gap.code).toBe('no-single-points');
        continue;
      }
      for (const tol of [undefined, 50, 500, 5000]) {
        for (const v of dialViews(r.domain, tol)) {
          if (v.feasible) expect(v.strategyType).toBe('single');
        }
      }
    }
  });
});

describe('typed gaps', () => {
  it('frontier-missing / frontier-not-live / no-single-points', () => {
    const missing = buildDialDomain({ frontier: null, clusterId: 'summarization', slot: 'brain', toolBearing: false });
    expect(!missing.ok && missing.gap.code).toBe('frontier-missing');
    const tainted = buildDialDomain({
      frontier: frontier([R, pt({ strategyHash: 'mock1', providerMode: 'mock' })]),
      clusterId: 'summarization', slot: 'brain', toolBearing: false,
    });
    expect(!tainted.ok && tainted.gap.code).toBe('frontier-not-live');
    const compositeOnly = buildDialDomain({
      frontier: frontier([CASCADE]), clusterId: 'summarization', slot: 'tools', toolBearing: true,
    });
    expect(!compositeOnly.ok && compositeOnly.gap.code).toBe('no-single-points');
  });
});
