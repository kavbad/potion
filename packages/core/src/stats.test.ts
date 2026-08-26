// Seeded statistics primitives (G0.3): reproducibility is the contract —
// every CI-based decision (promotion gate, guarantee breach) must be exactly
// re-derivable from (values, seed, resamples).
import { describe, expect, it } from 'vitest';
import {
  BOOTSTRAP_RESAMPLES,
  bootstrapCi,
  bootstrapMeanCi,
  jeffreysCi,
  mulberry32,
  quantileNearestRank,
  regularizedIncompleteBeta,
  seedFromString,
} from './stats.js';

/**
 * The PRE-G2.6 bootstrapMeanCi, reproduced verbatim. G2.6 generalized the
 * resampling loop to bootstrapCi(values, stat, seed) and made bootstrapMeanCi
 * a delegate; G0.3 breach verdicts stored in incidents.detail are re-derivable
 * from (values, seed, resamples), so a refactor that shifted a single float
 * would silently invalidate stored evidence. This function is the reference
 * the delegation is pinned against.
 */
function bootstrapMeanCiPreG26(
  values: number[],
  seed: number,
  resamples: number = BOOTSTRAP_RESAMPLES,
): { mean: number; ci95: [number, number] } {
  const n = values.length;
  const mean = values.reduce((s, d) => s + d, 0) / n;
  const rand = mulberry32(seed);
  const means: number[] = new Array<number>(resamples);
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += values[Math.floor(rand() * n)]!;
    means[r] = sum / n;
  }
  means.sort((a, b) => a - b);
  const lo = means[Math.max(0, Math.floor(0.025 * (resamples - 1)))]!;
  const hi = means[Math.min(resamples - 1, Math.ceil(0.975 * (resamples - 1)))]!;
  return { mean, ci95: [lo, hi] };
}

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

// ---------------------------------------------------------------------------
// G2.6 — the generalized bootstrap and the discrete quantile.
// ---------------------------------------------------------------------------

describe('bootstrapMeanCi bit-identity after the G2.6 generalization', () => {
  it('matches the pre-refactor implementation EXACTLY on fixed vectors', () => {
    // Fixed vectors, fixed seeds — no randomness in the test itself. If this
    // fails, every stored guarantee verdict became unreproducible.
    const cases: Array<{ values: number[]; seed: number; resamples?: number }> = [
      { values: [0.1, 0.5, 0.9, 0.3, 0.7], seed: 7 },
      { values: [0.4, 0.4, 0.4, 0.4, 0.4], seed: 1 },
      { values: Array.from({ length: 50 }, (_, i) => (i % 10) / 10), seed: 123 },
      { values: [0.82, 0.61, 0.77, 0.9, 0.55, 0.68, 0.71], seed: 987654321 },
      { values: [1], seed: 0, resamples: 250 },
      { values: [-3, 0, 3, 9], seed: 42, resamples: 100 },
    ];
    for (const { values, seed, resamples } of cases) {
      const got = bootstrapMeanCi(values, seed, resamples);
      const want = bootstrapMeanCiPreG26(values, seed, resamples);
      // Object.is equality on every float, not toBeCloseTo — the claim is
      // BIT identity, and a "close enough" assertion would pass on a drift
      // that changes a breach verdict at the boundary.
      expect(got.mean).toBe(want.mean);
      expect(got.ci95[0]).toBe(want.ci95[0]);
      expect(got.ci95[1]).toBe(want.ci95[1]);
    }
  });
});

describe('quantileNearestRank', () => {
  it('is the ceil(p/100·n)-th order statistic (discrete, never interpolated)', () => {
    const xs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(quantileNearestRank(xs, 50)).toBe(50); // rank ceil(5) = 5th
    expect(quantileNearestRank(xs, 95)).toBe(100); // rank ceil(9.5) = 10th
    expect(quantileNearestRank(xs, 10)).toBe(10);
    // The distinguishing case: an interpolating estimator (percentile_cont)
    // would return 47.5 here. This one MUST return an element of the input —
    // that is what makes it equal to Postgres percentile_disc.
    expect(quantileNearestRank([10, 20, 30, 40, 50], 95)).toBe(50);
    expect(xs).toContain(quantileNearestRank(xs, 73));
  });

  it('handles the degenerate sizes serving latency actually produces', () => {
    expect(quantileNearestRank([7], 95)).toBe(7);
    expect(quantileNearestRank([], 50)).toBe(0);
    // Below ~20 samples a nearest-rank p95 IS the maximum — the reason
    // SERVING_LATENCY_MIN_SAMPLES exists.
    const nineteen = Array.from({ length: 19 }, (_, i) => i + 1);
    expect(quantileNearestRank(nineteen, 95)).toBe(19);
  });

  it('does not mutate its input', () => {
    const xs = [5, 1, 4, 2, 3];
    quantileNearestRank(xs, 95);
    expect(xs).toEqual([5, 1, 4, 2, 3]);
  });
});

describe('bootstrapCi over an arbitrary statistic', () => {
  it('is reproducible per (values, stat, seed) and brackets the estimate', () => {
    const values = Array.from({ length: 60 }, (_, i) => 100 + (i % 12) * 25);
    const p95 = (xs: number[]): number => quantileNearestRank(xs, 95);
    const a = bootstrapCi(values, p95, 4242);
    const b = bootstrapCi(values, p95, 4242);
    expect(a).toEqual(b);
    expect(a.estimate).toBe(quantileNearestRank(values, 95));
    expect(a.ci95[0]).toBeLessThanOrEqual(a.estimate);
    expect(a.ci95[1]).toBeGreaterThanOrEqual(a.estimate);
  });

  it('the CI on a p95 is ASYMMETRIC — why the evidence stores [lo,hi], not a half-width', () => {
    // Right-skewed latencies: a handful of slow tails. Resampling moves the
    // upper endpoint much further than the lower, so collapsing this to a
    // single ± number would assert a symmetry that is not there.
    const values = [...Array.from({ length: 50 }, () => 100), 900, 1200, 2400];
    const { estimate, ci95 } = bootstrapCi(values, (xs) => quantileNearestRank(xs, 95), 11);
    const below = estimate - ci95[0];
    const above = ci95[1] - estimate;
    expect(Math.abs(above - below)).toBeGreaterThan(1); // not a ± half-width
  });

  it('a stat that sorts its argument does not corrupt the resample buffer', () => {
    // bootstrapCi reuses one buffer across resamples; quantileNearestRank
    // copies before sorting. A stat that sorted IN PLACE would still be
    // correct here, but a stat that RETAINED the buffer would not — pin that
    // the returned CI is unaffected by the statistic's internal handling.
    const values = [3, 1, 4, 1, 5, 9, 2, 6];
    const viaCopy = bootstrapCi(values, (xs) => quantileNearestRank(xs, 95), 5);
    const viaSortInPlace = bootstrapCi(values, (xs) => [...xs].sort((a, b) => a - b).at(-1)!, 5);
    expect(viaCopy.ci95[1]).toBeLessThanOrEqual(viaSortInPlace.ci95[1]);
    expect(values).toEqual([3, 1, 4, 1, 5, 9, 2, 6]); // input untouched
  });
});

describe('jeffreysCi (boundary-honest quality intervals, 2026-08-25)', () => {
  // Reference values verified against TWO independent implementations
  // (continued-fraction here; Simpson integration of the Beta pdf with a
  // singularity-removing substitution in the review's verification pass).
  // 10/10 also matches the published Jeffreys binomial interval (~0.783).
  it('42/42 is a ≥-bound, not certainty — the finding that motivated this', () => {
    const [lo, hi] = jeffreysCi(Array<number>(42).fill(1));
    expect(hi).toBe(1);
    expect(lo).toBeCloseTo(0.9423, 4);
  });
  it('matches published Jeffreys at 10/10', () => {
    const [lo, hi] = jeffreysCi(Array<number>(10).fill(1));
    expect(hi).toBe(1);
    expect(lo).toBeCloseTo(0.7828, 4);
  });
  it('0/25 pins lo=0 with honest upper width', () => {
    const [lo, hi] = jeffreysCi(Array<number>(25).fill(0));
    expect(lo).toBe(0);
    expect(hi).toBeCloseTo(0.0947, 4);
  });
  it('mid-range 35/50 both sides', () => {
    const [lo, hi] = jeffreysCi([...Array<number>(35).fill(1), ...Array<number>(15).fill(0)]);
    expect(lo).toBeCloseTo(0.5645, 4);
    expect(hi).toBeCloseTo(0.8131, 4);
  });
  it('fractional scores ride as partial successes', () => {
    const [lo, hi] = jeffreysCi([0.5, 0.5, 0.5, 0.5]); // s=2 of n=4
    const [blo, bhi] = jeffreysCi([1, 1, 0, 0]);
    expect(lo).toBeCloseTo(blo, 12);
    expect(hi).toBeCloseTo(bhi, 12);
  });
  it('n=1 is wide, n=0 is vacuous [0,1], and the interval always brackets the mean', () => {
    const [lo1, hi1] = jeffreysCi([1]);
    expect(hi1).toBe(1);
    expect(lo1).toBeLessThan(0.6); // a single success proves very little
    expect(jeffreysCi([])).toEqual([0, 1]);
    for (const scores of [[1, 1, 0.25], [0.9, 0.8], [0, 0, 1]]) {
      const m = scores.reduce((a, b) => a + b, 0) / scores.length;
      const [lo, hi] = jeffreysCi(scores);
      expect(lo).toBeLessThanOrEqual(m);
      expect(hi).toBeGreaterThanOrEqual(m);
    }
  });
  it('regularizedIncompleteBeta hits exact closed forms', () => {
    expect(regularizedIncompleteBeta(0.25, 1, 1)).toBeCloseTo(0.25, 12); // uniform
    expect(regularizedIncompleteBeta(0.5, 2, 2)).toBeCloseTo(0.5, 12); // symmetric
  });
});
