// Promotion gate tests (M4b #37, SPEC §15.4): pinned paired bootstrap
// (mulberry32, 1000 resamples, 95% CI), quality/cost paths, CI-overlap hold,
// threshold overrides, free-evidence cost-path impossibility.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RESAMPLES,
  evaluatePromotion,
  pairedBootstrapCi,
  type ItemPair,
} from './gate.js';

function pairs(delta: number | ((i: number) => number), n = 40): ItemPair[] {
  return Array.from({ length: n }, (_, i) => ({
    itemId: `item-${i}`,
    candidateQuality: 0.8,
    incumbentQuality: 0.8 - (typeof delta === 'function' ? delta(i) : delta),
  }));
}

describe('pairedBootstrapCi', () => {
  it('is exactly reproducible for a fixed seed (mulberry32)', () => {
    const deltas = [0.01, -0.02, 0.03, 0.005, 0.02, -0.01, 0.015, 0.0];
    const a = pairedBootstrapCi(deltas, 42);
    const b = pairedBootstrapCi(deltas, 42);
    expect(a).toEqual(b);
    const c = pairedBootstrapCi(deltas, 43);
    expect(c.ci95).not.toEqual(a.ci95); // different seed → different resamples
  });

  it('constant deltas collapse the CI to the constant', () => {
    const { mean, ci95 } = pairedBootstrapCi([0.02, 0.02, 0.02], 1);
    expect(mean).toBeCloseTo(0.02, 12);
    expect(ci95[0]).toBeCloseTo(0.02, 12);
    expect(ci95[1]).toBeCloseTo(0.02, 12);
  });
});

describe('evaluatePromotion — SPEC §15.4', () => {
  it('quality path: CI lower ≥ +1.5pts at ≤ cost → promote', () => {
    const v = evaluatePromotion(pairs(0.02), {
      candidateCostPer1K: 4,
      incumbentCostPer1K: 4,
      seed: 7,
    });
    expect(v.promote).toBe(true);
    expect(v.path).toBe('quality');
    expect(v.ci95[0]).toBeGreaterThanOrEqual(0.015);
    expect(v.resamples).toBe(DEFAULT_RESAMPLES);
    expect(v.seed).toBe(7);
  });

  it('quality path refused when candidate costs MORE than incumbent', () => {
    const v = evaluatePromotion(pairs(0.02), {
      candidateCostPer1K: 5,
      incumbentCostPer1K: 4,
      seed: 7,
    });
    expect(v.promote).toBe(false); // quality gain must come at ≤ cost
    expect(v.path).toBeNull();
  });

  it('cost path: ≥20% cost cut with quality held (CI lower ≥ 0) → promote', () => {
    const v = evaluatePromotion(pairs(0.005), {
      candidateCostPer1K: 3,
      incumbentCostPer1K: 4, // 25% cut
      seed: 7,
    });
    expect(v.promote).toBe(true);
    expect(v.path).toBe('cost');
    expect(v.costCutPct).toBeCloseTo(0.25, 10);
  });

  it('HOLD when the CI overlaps every threshold (noisy small gain)', () => {
    // Mean +1.0pt but noisy (±2pts alternating) → CI lower ≈ +0.4pt < +1.5pt.
    const noisy = pairs((i) => (i % 2 === 0 ? 0.03 : -0.01), 40);
    const v = evaluatePromotion(noisy, {
      candidateCostPer1K: 4,
      incumbentCostPer1K: 4,
      seed: 7,
    });
    expect(v.promote).toBe(false);
    expect(v.ci95[0]).toBeLessThan(0.015);
    expect(v.reason).toContain('hold');
  });

  it('HOLD when quality dips below par even with a big cost cut', () => {
    const v = evaluatePromotion(pairs(-0.01), {
      candidateCostPer1K: 2,
      incumbentCostPer1K: 4, // 50% cut
      seed: 7,
    });
    expect(v.promote).toBe(false); // CI lower −0.01 < 0: quality did not hold
  });

  it('free incumbent (mock economics) can never take the cost path', () => {
    const v = evaluatePromotion(pairs(0.05), {
      candidateCostPer1K: 0,
      incumbentCostPer1K: 0,
      seed: 7,
    });
    expect(v.costCutPct).toBe(0);
    // quality path also blocked? candidate 0 ≤ 0 cost, delta 0.05 → quality path promotes.
    expect(v.path).toBe('quality'); // documents: free-vs-free CAN promote on quality
  });

  it('float-noise equal cost does not block the quality path (IEEE754)', () => {
    // Aggregate arithmetic produced 1.0000000000000002 vs 1 in the wild —
    // "≤ same cost" must tolerate representation error.
    const v = evaluatePromotion(pairs(0.02), {
      candidateCostPer1K: 1.0000000000000002,
      incumbentCostPer1K: 1,
      seed: 7,
    });
    expect(v.promote).toBe(true);
    expect(v.path).toBe('quality');
    expect(v.costCutPct).toBe(0); // noise clamped, not −2e-16
  });

  it('empty pairs → hold, no bootstrap', () => {
    const v = evaluatePromotion([], { candidateCostPer1K: 1, incumbentCostPer1K: 1, seed: 1 });
    expect(v.promote).toBe(false);
    expect(v.n).toBe(0);
    expect(v.reason).toContain('no paired heldout');
  });

  it('thresholds are tunable (env-facing parameters)', () => {
    const v = evaluatePromotion(pairs(0.005), {
      candidateCostPer1K: 4,
      incumbentCostPer1K: 4,
      seed: 7,
      thresholds: { qualityDeltaMin: 0.001 },
    });
    expect(v.promote).toBe(true);
    expect(v.path).toBe('quality');
  });
});
