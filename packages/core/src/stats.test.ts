// Seeded statistics primitives (G0.3): reproducibility is the contract —
// every CI-based decision (promotion gate, guarantee breach) must be exactly
// re-derivable from (values, seed, resamples).
import { describe, expect, it } from 'vitest';
import { BOOTSTRAP_RESAMPLES, bootstrapMeanCi, mulberry32, seedFromString } from './stats.js';

describe('mulberry32', () => {
  it('is deterministic per seed and uniform-ish in [0,1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = Array.from({ length: 5 }, () => a());
    const seqB = Array.from({ length: 5 }, () => b());
    expect(seqA).toEqual(seqB);
    for (const v of seqA) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    expect(new Set(seqA).size).toBe(5); // not constant
  });
});

describe('bootstrapMeanCi', () => {
  it('is reproducible per (values, seed); the mean is seed-independent', () => {
    const values = [0.1, 0.5, 0.9, 0.3, 0.7];
    const a = bootstrapMeanCi(values, 7);
    const b = bootstrapMeanCi(values, 7);
    expect(a).toEqual(b); // bit-identical re-derivation — the audit contract
    const c = bootstrapMeanCi(values, 8);
    expect(c.mean).toBe(a.mean);
    // NOTE: with tiny n the percentile endpoints are quantized and different
    // seeds can coincide — seed-sensitivity is asserted on the PRNG itself.
  });

  it('constant values → degenerate CI at the value', () => {
    const { mean, ci95 } = bootstrapMeanCi([0.4, 0.4, 0.4, 0.4, 0.4], 1);
    expect(mean).toBeCloseTo(0.4, 12);
    expect(ci95[0]).toBeCloseTo(0.4, 12);
    expect(ci95[1]).toBeCloseTo(0.4, 12);
  });

  it('CI brackets the mean and orders correctly', () => {
    const values = Array.from({ length: 50 }, (_, i) => (i % 10) / 10);
    const { mean, ci95 } = bootstrapMeanCi(values, 123, BOOTSTRAP_RESAMPLES);
    expect(ci95[0]).toBeLessThanOrEqual(mean);
    expect(ci95[1]).toBeGreaterThanOrEqual(mean);
    expect(ci95[0]).toBeLessThan(ci95[1]); // non-degenerate for varied data
  });
});

describe('seedFromString', () => {
  it('is a deterministic uint32, sensitive to the input', () => {
    const a = seedFromString('org|pol|cluster|hash|5|abc');
    expect(a).toBe(seedFromString('org|pol|cluster|hash|5|abc'));
    expect(Number.isInteger(a)).toBe(true);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThanOrEqual(0xffffffff);
    expect(seedFromString('org|pol|cluster|hash|6|abc')).not.toBe(a);
  });
});
