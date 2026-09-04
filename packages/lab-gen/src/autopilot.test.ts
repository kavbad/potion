// Autopilot: knee selection pinned against a hand-computed frontier, the
// single-strategy partition enforced by construction, every gap typed and
// produced, and the reproduce-through-serving invariant (the emitted
// compound policy re-selects the SAME point via core's own selectPoint).
import { describe, expect, it } from 'vitest';
import { selectPoint, type Frontier, type FrontierPoint } from '@potion/core';
import { fillBrainSlot, kneePoint } from './autopilot.js';

function pt(over: Partial<FrontierPoint> & { strategyHash: string }): FrontierPoint {
  return {
    clusterId: 'summarization',
    strategyConfig: { type: 'single', model: 'm' },
    quality: 0.8,
    costPer1K: 0.01,
    latencyP95: 800,
    providerMode: 'live',
    evidence: { cacheKeys: ['ck'], runIds: ['r'], n: 14, qualityCi95: 0.02, suiteContentHash: 'a'.repeat(64) },
    ...over,
  };
}

// Hand-computed: marginal gains 0.60/0.01=60 (origin), then
// (0.85-0.60)/(0.02-0.01)=25, then (0.95-0.85)/(0.10-0.02)=1.25.
// The knee is the cheapest point (steepest gain from origin).
const P_CHEAP = pt({ strategyHash: 'aa-cheap', quality: 0.6, costPer1K: 0.01, latencyP95: 500 });
const P_MID = pt({ strategyHash: 'bb-mid', quality: 0.85, costPer1K: 0.02, latencyP95: 900 });
const P_STRONG = pt({ strategyHash: 'cc-strong', quality: 0.95, costPer1K: 0.1, latencyP95: 2000 });
const P_CASCADE = pt({
  strategyHash: 'dd-cascade',
  quality: 0.9,
  costPer1K: 0.015,
  latencyP95: 1200,
  strategyConfig: { type: 'cascade', stages: [{ model: 'a' }, { model: 'b' }], confidenceMethod: 'self-report-calibrated' },
});

function frontier(points: FrontierPoint[]): Frontier {
  return {
    id: 'fr-test-1',
    clusterId: 'summarization',
    version: 3,
    parentId: null,
    trigger: 'recompute',
    points,
    pricesVersion: 'pv',
    createdAt: new Date(0).toISOString(),
  };
}

describe('kneePoint — hand-computed', () => {
  it('picks the steepest marginal gain', () => {
    expect(kneePoint([P_CHEAP, P_MID, P_STRONG]).strategyHash).toBe('aa-cheap');
  });
  it('cascade with better gain wins when composites are allowed', () => {
    // (0.9-0.6)/(0.015-0.01)=60 vs origin 60 — tie; higher quality wins.
    expect(kneePoint([P_CHEAP, P_CASCADE, P_STRONG]).strategyHash).toBe('dd-cascade');
  });
});

describe('fillBrainSlot — partition + gaps + reproduce-through-serving', () => {
  it('tool-free keeps the full frontier (composite eligible)', () => {
    const r = fillBrainSlot({ clusterId: 'summarization', frontier: frontier([P_CHEAP, P_CASCADE, P_STRONG]), toolBearing: false });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.choice.basis.strategyHash).toBe('dd-cascade');
      expect(r.choice.partition).toBe('full');
      expect(r.choice.basis.suiteContentHash).toBe('a'.repeat(64));
    }
  });

  it('tool-bearing filters to singles BEFORE selection — a composite is unrepresentable', () => {
    const r = fillBrainSlot({ clusterId: 'summarization', frontier: frontier([P_CHEAP, P_CASCADE, P_STRONG]), toolBearing: true });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.choice.basis.strategyHash).toBe('aa-cheap');
      expect(r.choice.partition).toBe('single-only');
    }
  });

  it('the emitted compound policy re-selects the same point through core selectPoint', () => {
    const f = frontier([P_CHEAP, P_MID, P_STRONG]);
    const r = fillBrainSlot({ clusterId: 'summarization', frontier: f, toolBearing: false });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const reselected = selectPoint(r.policy, f);
      expect(reselected?.strategyHash).toBe(r.choice.basis.strategyHash);
    }
  });

  it('gap: frontier-missing', () => {
    const r = fillBrainSlot({ clusterId: 'summarization', frontier: null, toolBearing: false });
    expect(!r.ok && r.gap.code).toBe('frontier-missing');
  });

  it('gap: frontier-not-live (one SIMULATED point taints the frontier for autopilot)', () => {
    const tainted = frontier([P_CHEAP, pt({ strategyHash: 'ee-mock', providerMode: 'mock' })]);
    const r = fillBrainSlot({ clusterId: 'summarization', frontier: tainted, toolBearing: false });
    expect(!r.ok && r.gap.code).toBe('frontier-not-live');
  });

  it('REGRESSION (review finding): 3-axis Pareto frontier — the policy is the authority, no throw', () => {
    // R cheap/high-quality/slow, M mid-cost/low-quality/fast, K pricier/equal-quality/faster:
    // all mutually non-dominated on (quality, cost, latency). The knee walk
    // proposes K, but the knee-derived policy admits R at lower cost — the
    // recorded choice must be R (what serving will select), never a crash.
    const R = pt({ strategyHash: 'rr', quality: 0.9, costPer1K: 1.0, latencyP95: 1300 });
    const M = pt({ strategyHash: 'mm', quality: 0.3, costPer1K: 1.05, latencyP95: 40 });
    const K = pt({ strategyHash: 'kk', quality: 0.9, costPer1K: 1.15, latencyP95: 900 });
    const f = frontier([R, M, K]);
    const r = fillBrainSlot({ clusterId: 'summarization', frontier: f, toolBearing: false });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.choice.basis.strategyHash).toBe('rr');
      expect(selectPoint(r.policy, f)?.strategyHash).toBe('rr');
    }
  });

  it('gap: no-single-points (tools + composite-only frontier)', () => {
    const r = fillBrainSlot({ clusterId: 'summarization', frontier: frontier([P_CASCADE]), toolBearing: true });
    expect(!r.ok && r.gap.code).toBe('no-single-points');
  });
});
