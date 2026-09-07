// Promotion gate tests (M4b #37, SPEC §15.4): pinned paired bootstrap
// (mulberry32, 1000 resamples, 95% CI), quality/cost paths, CI-overlap hold,
// threshold overrides, free-evidence cost-path impossibility.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RESAMPLES,
  evaluatePromotion,
  PROMOTION_MIN_PAIRS,
  downsideHonestLowerBound,
  pairedBootstrapCi,
  type ItemPair,
} from './gate.js';
import { mulberry32 } from './rng.js';

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
    const v = evaluatePromotion(pairs(0.02), { comparisons: 1,
      candidateCostPer1K: 4,
      incumbentCostPer1K: 4,
      seed: 7,
    });
    expect(v.promote).toBe(true);
    expect(v.path).toBe('quality');
    expect(v.ci[0]).toBeGreaterThanOrEqual(0.015);
    expect(v.resamples).toBe(DEFAULT_RESAMPLES);
    expect(v.seed).toBe(7);
  });

  it('quality path refused when candidate costs MORE than incumbent', () => {
    const v = evaluatePromotion(pairs(0.02), { comparisons: 1,
      candidateCostPer1K: 5,
      incumbentCostPer1K: 4,
      seed: 7,
    });
    expect(v.promote).toBe(false); // quality gain must come at ≤ cost
    expect(v.path).toBeNull();
  });

  it('cost path: ≥20% cost cut with quality held to within the margin → promote', () => {
    const v = evaluatePromotion(pairs(0.005), { comparisons: 1,
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
    const v = evaluatePromotion(noisy, { comparisons: 1,
      candidateCostPer1K: 4,
      incumbentCostPer1K: 4,
      seed: 7,
    });
    expect(v.promote).toBe(false);
    expect(v.ci[0]).toBeLessThan(0.015);
    expect(v.reason).toContain('hold');
  });

  it('HOLD when the dip EXCEEDS the non-inferiority margin, cost cut or not', () => {
    const v = evaluatePromotion(pairs(-0.02), { comparisons: 1,
      candidateCostPer1K: 2,
      incumbentCostPer1K: 4, // 50% cut
      seed: 7,
    });
    expect(v.promote).toBe(false); // bound −0.02 < −0.015
    expect(v.costCiLower).toBeCloseTo(-0.02, 6);
  });

  it('a dip WITHIN the margin promotes on cost — the trade, stated out loud', () => {
    // This is the price of the margin and it must not be hidden: the gate
    // KNOWINGLY accepts a measured 1pt regression to buy a 50% cost cut,
    // because a non-inferiority test with a zero margin has no power at any
    // sample size (see DEFAULT_COST_QUALITY_MARGIN). Lower the margin to be
    // stricter — POTION_RESEARCH_COST_QUALITY_MARGIN — at the cost of needing
    // quadratically more paired items.
    const v = evaluatePromotion(pairs(-0.01), { comparisons: 1,
      candidateCostPer1K: 2,
      incumbentCostPer1K: 4,
      seed: 7,
    });
    expect(v.promote).toBe(true);
    expect(v.path).toBe('cost');
    // The reason SAYS it held to within a margin — never that quality "held".
    expect(v.reason).toContain('within 1.5pts');
    expect(v.reason).not.toMatch(/quality held\)/);
    // ...and a stricter operator gets the hold back.
    const strict = evaluatePromotion(pairs(-0.01), { comparisons: 1,
      candidateCostPer1K: 2,
      incumbentCostPer1K: 4,
      seed: 7,
      thresholds: { costQualityMargin: 0.005 },
    });
    expect(strict.promote).toBe(false);
  });

  it('free incumbent (mock economics) can never take the cost path', () => {
    const v = evaluatePromotion(pairs(0.05), { comparisons: 1,
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
    const v = evaluatePromotion(pairs(0.02), { comparisons: 1,
      candidateCostPer1K: 1.0000000000000002,
      incumbentCostPer1K: 1,
      seed: 7,
    });
    expect(v.promote).toBe(true);
    expect(v.path).toBe('quality');
    expect(v.costCutPct).toBe(0); // noise clamped, not −2e-16
  });

  it('empty pairs → hold, no bootstrap', () => {
    const v = evaluatePromotion([], { comparisons: 1, candidateCostPer1K: 1, incumbentCostPer1K: 1, seed: 1 });
    expect(v.promote).toBe(false);
    expect(v.n).toBe(0);
    expect(v.reason).toContain('no paired heldout');
  });

  it('thresholds are tunable (env-facing parameters)', () => {
    const v = evaluatePromotion(pairs(0.005), { comparisons: 1,
      candidateCostPer1K: 4,
      incumbentCostPer1K: 4,
      seed: 7,
      thresholds: { qualityDeltaMin: 0.001 },
    });
    expect(v.promote).toBe(true);
    expect(v.path).toBe('quality');
  });
});

// ---- P0-4 (external review, 2026-09-05): the gate had no minimum-n ----
//
// A percentile bootstrap over ONE delta resamples the same value a thousand
// times, so the interval collapses to a point and is then reported as a 95%
// CI. Measured before the fix:
//   n=1 quality path -> promote, ci95 [0.0999…, 0.0999…]  "lower 0.1000 ≥ 0.015"
//   n=2 cost path    -> promote, ci95 [0, 0], 50% cost cut
// This is the degenerate-interval class that motivated jeffreysCi (the 42/42
// champion reported as ±0.000) and that the G2.8 capstone refused to report as
// evidence. The gate that decides what reaches the frontier still had it.
describe('P0-4: a verdict needs enough pairs to be a verdict', () => {
  const pair = (id: string, c: number, i: number): ItemPair => ({ itemId: id, candidateQuality: c, incumbentQuality: i });
  const run = (pairs: ItemPair[], cand = 1, inc = 1) =>
    evaluatePromotion(pairs, { comparisons: 1, candidateCostPer1K: cand, incumbentCostPer1K: inc, seed: 7 });

  it('REFUSES a one-item quality verdict instead of promoting on it', () => {
    const v = run([pair('a', 1, 0.9)]);
    expect(v.promote).toBe(false);
    expect(v.refusal).toBe('insufficient-evidence');
    expect(v.reason).toContain(`below the ${PROMOTION_MIN_PAIRS}`);
    expect(v.n).toBe(1);
  });

  it('REFUSES a two-item cost verdict, which the CI cannot see is degenerate', () => {
    const v = run([pair('a', 1, 1), pair('b', 1, 1)], 0.5, 1);
    expect(v.promote).toBe(false);
    expect(v.refusal).toBe('insufficient-evidence');
  });

  it('an empty pair set is the SAME refusal, not a separate special case', () => {
    const v = run([]);
    expect(v.refusal).toBe('insufficient-evidence');
    expect(v.n).toBe(0);
  });

  // THE OVER-BROAD FIX THIS DELIBERATELY DOES NOT MAKE. The review also asked
  // for degenerate intervals to be refused outright. A zero-width CI can only
  // arise from identical deltas — so at or above the floor it is a statement
  // about the CANDIDATE (it matched on every item), not about n. Refusing it
  // would refuse a correct verdict, and the n floor already subsumes the case
  // the review was actually worried about.
  // CORRECTED 2026-09-05 (see downsideHonestLowerBound). This test used to
  // assert that 12 identical pairs PROMOTE on cost, and it was the argument
  // made back to the review that a zero-width interval is legitimate above
  // the floor. The interval-width half of that argument still holds. The
  // conclusion did not: an all-ties sample is not evidence of equality, it is
  // evidence of not having looked hard enough. A candidate that ties 97% of
  // the time and fails catastrophically 3% of the time shows all-ties in 40%
  // of 30-item samples, and the old rule promoted it in 100% of cycles.
  it('all-ties is NOT a cost-path promotion — the sample simply never disagreed', () => {
    const v = run(Array.from({ length: 12 }, (_, i) => pair(`i${i}`, 0.9, 0.9)), 0.12, 1);
    expect(v.ci).toEqual([0, 0]); // the interval is still legitimately a point
    expect(v.refusal).toBeUndefined(); // and this is a JUDGEMENT, not a refusal
    expect(v.promote).toBe(false);
    // It shows no scale of its own, so the charge falls back to the worst drop
    // the quality scale allows on these items (incumbent quality 0.9).
    expect(v.downsideCharge).toBeGreaterThan(0);
    expect(v.costCiLower).toBeLessThan(-0.015);
    expect(v.reason).toContain('no item in it was a loss');
  });

  it('...but ties WITH observed movement still promote — the scale is measured', () => {
    // Same 12 pairs, except the candidate is visibly better on two items. Now
    // the sample HAS a scale (0.02), the charge is that small, and the cost
    // path clears the margin. Nothing here is a blanket ban on loss-free
    // samples; the charge is proportional to what the sample showed.
    const items = Array.from({ length: 12 }, (_, i) =>
      i < 2 ? pair(`i${i}`, 0.92, 0.9) : pair(`i${i}`, 0.9, 0.9),
    );
    const v = run(items, 0.12, 1);
    expect(v.downsideCharge).toBeGreaterThan(0);
    expect(v.downsideCharge).toBeLessThan(0.015);
    expect(v.promote).toBe(true);
    expect(v.path).toBe('cost');
  });

  it('the floor is a floor: it can be raised and never lowered', () => {
    const pairs = [pair('a', 1, 0.9), pair('b', 1, 0.9)];
    expect(evaluatePromotion(pairs, { comparisons: 1, candidateCostPer1K: 1, incumbentCostPer1K: 1, seed: 7, thresholds: { minPairs: 20 } }).refusal)
      .toBe('insufficient-evidence');
    // asking for fewer than the platform floor does not get you fewer
    expect(evaluatePromotion(pairs, { comparisons: 1, candidateCostPer1K: 1, incumbentCostPer1K: 1, seed: 7, thresholds: { minPairs: 1 } }).refusal)
      .toBe('insufficient-evidence');
  });
});

// ---- P1-1 (external review, 2026-09-05): multiple comparisons ----
//
// A cycle adjudicates up to DEFAULT_CANDIDATE_BUDGET (20) candidates against
// the SAME incumbent, each at a 95% bound, with no family-wise correction
// anywhere in the repo. Twenty tests at 2.5% one-sided is not a 5% cycle.
//
// Every number asserted below was MEASURED before it was asserted; the
// simulation is seeded, so they are reproducible, not aspirational.
describe('P1-1: the family-wise error rate of a cycle', () => {
  /** Item-level noise: 80% ties, symmetric misses. TRUE mean delta = 0. */
  function noiseDeltas(rand: () => number, n: number): ItemPair[] {
    return Array.from({ length: n }, (_, i) => {
      const u = rand();
      const delta = u < 0.1 ? 1 : u < 0.2 ? -1 : 0;
      return { itemId: `i${i}`, candidateQuality: 0.5 + delta / 2, incumbentQuality: 0.5 };
    });
  }

  /** One cycle of m pure-noise candidates at EQUAL cost, so only the quality
   *  path is open and every promotion is unambiguously a false one. */
  function cycle(seed: number, m: number, comparisons: number | undefined) {
    const rand = mulberry32(seed);
    let promoted = 0;
    for (let c = 0; c < m; c++) {
      const v = evaluatePromotion(noiseDeltas(rand, 30), {
        candidateCostPer1K: 1,
        incumbentCostPer1K: 1,
        seed: seed * 1000 + c,
        comparisons: comparisons ?? 1,
      });
      if (v.promote) promoted++;
    }
    return promoted;
  }

  // Cached: the corrected sweep is 400 x 20 verdicts at 8000 resamples each.
  const memo = new Map<string, { fwer: number; perTest: number }>();
  function measure(comparisons: number | undefined) {
    const key = String(comparisons);
    const hit = memo.get(key);
    if (hit) return hit;
    let cycles = 0, promos = 0;
    for (let t = 0; t < TRIALS; t++) {
      const p = cycle(t + 1, M, comparisons);
      promos += p;
      if (p > 0) cycles++;
    }
    const out = { fwer: cycles / TRIALS, perTest: promos / (TRIALS * M) };
    memo.set(key, out);
    return out;
  }

  const TRIALS = 400;
  const M = 20;

  it('ONE test at a time the bootstrap is already calibrated', () => {
    // 2.60% measured against a nominal one-sided 2.5%. This is the control:
    // it rules out "the interval is broken" as the explanation for what the
    // next test measures, and pins the correction as the only thing at issue.
    const { perTest } = measure(undefined);
    expect(perTest).toBeGreaterThan(0.02);
    expect(perTest).toBeLessThan(0.035);
  });

  it('UNCORRECTED, a 20-candidate cycle false-promotes 41.5% of the time', () => {
    const { fwer } = measure(undefined);
    // Nowhere near the 5% every reader of a promotion reason assumes.
    expect(fwer).toBeGreaterThan(0.3);
  });

  it('CORRECTED by the candidates adjudicated, the rate drops ~5x', () => {
    const before = measure(undefined);
    const after = measure(M);
    // Measured: FWER 41.5% -> 8.7%, per-test 2.60% -> 0.45%.
    expect(after.fwer).toBeLessThan(before.fwer / 4);
    expect(after.perTest).toBeLessThan(before.perTest / 4);
    // HONEST RESIDUAL: 8.7% is not 5%. Bonferroni's guarantee assumes an exact
    // per-test bound; the percentile bootstrap is anti-conservative in the far
    // tail at n=30 over a distribution that is 80% ties, and no alpha and no
    // resample count closes that (measured flat from 4k to 16k resamples).
    // Closing it needs more heldout items or a BCa interval — recorded, not
    // papered over, and asserted here so a future change has to face it.
    expect(after.fwer).toBeLessThan(0.12);
    expect(after.fwer).toBeGreaterThan(0.05);
  });

  it('the corrected alpha gets the resample tail resolution it asks for', () => {
    // 1000 resamples cannot express a 0.125th percentile: index 1.25 is the
    // minimum of the set. The floor lifts it to index 10.
    const v = evaluatePromotion(pairs(0.05, 40), {
      candidateCostPer1K: 1, incumbentCostPer1K: 1, seed: 3, comparisons: 20,
    });
    expect(v.resamples).toBe(8000);
    expect(v.resamples * (v.alpha / 2)).toBeGreaterThanOrEqual(10);
    // ...and an operator asking for MORE still gets more.
    const big = evaluatePromotion(pairs(0.05, 40), {
      candidateCostPer1K: 1, incumbentCostPer1K: 1, seed: 3,
      comparisons: 20, thresholds: { resamples: 20000 },
    });
    expect(big.resamples).toBe(20000);
  });

  it('the correction is ON the verdict, so a promotion is auditable against it', () => {
    const v = evaluatePromotion(pairs(0.05, 40), {
      candidateCostPer1K: 1, incumbentCostPer1K: 1, seed: 3, comparisons: 20,
    });
    expect(v.comparisons).toBe(20);
    expect(v.alpha).toBeCloseTo(0.05 / 20, 10);
    expect(v.reason).toContain('20 comparison');
    // The interval is NOT a 95% interval any more and must not be called one.
    expect(v.reason).not.toContain('CI95');
    expect(v.reason).toContain('CI99.75%');
  });

  it('one comparison is the old behaviour exactly — unstamped cycles are unchanged', () => {
    const a = evaluatePromotion(pairs(0.05, 40), { comparisons: 1, candidateCostPer1K: 1, incumbentCostPer1K: 1, seed: 3 });
    const b = evaluatePromotion(pairs(0.05, 40), {
      candidateCostPer1K: 1, incumbentCostPer1K: 1, seed: 3, comparisons: 1,
    });
    expect(a.ci).toEqual(b.ci);
    expect(a.alpha).toBe(0.05);
    expect(a.comparisons).toBe(1);
    expect(a.resamples).toBe(DEFAULT_RESAMPLES);
    expect(a.reason).toContain('CI95');
  });
});

// ---- THE COST PATH, FIXED (found while proving P1-1, 2026-09-05) ----
//
// The cost path was `ciLower >= 0` — a bare non-inferiority test read off a
// percentile bootstrap. Two defects, both proven by simulation before either
// was fixed, and both fixed here:
//
//   1. A LOWER BOUND THAT WAS A FLOOR ARTIFACT. A bootstrap resamples only
//      outcomes the sample contains, so a sample with no losing item has
//      every resample mean >= 0 and a lower bound pinned at exactly 0 — for
//      every alpha. Correcting alpha (P1-1) moved a truly-5pts-worse
//      candidate only 16.5% -> 14.5% of cycles, because 0.85^30 = 0.8% of
//      samples miss every loss and 20 candidates a cycle turns that into 14%.
//
//   2. NO POWER AT ANY SAMPLE SIZE. A one-sided bound on a candidate whose
//      true delta is exactly 0 sits BELOW zero however much evidence there
//      is, so `>= 0` was passed only by luck. Measured: a candidate that
//      truly holds quality promoted in 60.5% of cycles at n=30, 5.0% at
//      n=300, 8.0% at n=1000 — flat noise, not detection. Power that does not
//      rise with evidence is the signature of a coin flip, not a test.
//
// Fixed by (1) a downside-honest bound and (2) an explicit non-inferiority
// margin. Measured after, same simulation:
//
//   truly 5pts WORSE, n=30       14.5% -> 0.0%
//   97% ties / 3% catastrophic    100% -> 0.0%
//   all ties, n=30                100% -> 0.0%
//   truly HOLDS quality, n=30    60.5% -> 1.0%
//   truly HOLDS quality, n=300    5.0% -> 56.7%
//   truly HOLDS quality, n=1000   8.0% -> 100%
//
// The last three lines are the point: power now RISES with evidence. The
// price is that the cost path cannot fire on today's 30-item heldout sets —
// which is the truth about 30 items, not a regression.
describe('the cost path is a test, not a coin flip', () => {
  function deltasOf(rand: () => number, n: number, pWin: number, pLoss: number): ItemPair[] {
    return Array.from({ length: n }, (_, i) => {
      const u = rand();
      const d = u < pWin ? 1 : u < pWin + pLoss ? -1 : 0;
      return { itemId: `i${i}`, candidateQuality: 0.5 + d / 2, incumbentQuality: 0.5 };
    });
  }

  /** Fraction of 20-candidate cycles with at least one cost-path promotion. */
  function cycleRate(pWin: number, pLoss: number, n: number, trials: number): number {
    const M = 20;
    let cycles = 0;
    for (let t = 0; t < trials; t++) {
      const rand = mulberry32(t + 1);
      for (let c = 0; c < M; c++) {
        const v = evaluatePromotion(deltasOf(rand, n, pWin, pLoss), {
          candidateCostPer1K: 0.1,
          incumbentCostPer1K: 1,
          seed: t * 1000 + c,
          comparisons: M,
        });
        if (v.promote) { cycles++; break; }
      }
    }
    return cycles / trials;
  }

  it('a candidate that is TRULY 5pts worse is no longer bought with a cost cut', () => {
    // Was 14.5% of cycles. The regression the old gate could not see.
    expect(cycleRate(0.05, 0.15, 30, 120)).toBeLessThan(0.02);
  });

  it('a 97%-tie / 3%-catastrophe candidate is no longer certified', () => {
    // Was 100% of cycles: 0.97^30 = 40% of samples never show the failure at
    // all, and a sample that never shows it used to read as "quality held".
    expect(cycleRate(0.0, 0.03, 30, 120)).toBeLessThan(0.02);
  });

  it('POWER RISES WITH EVIDENCE — the property the old rule did not have', () => {
    // A candidate that genuinely holds quality at a 10x cost cut.
    const small = cycleRate(0.1, 0.1, 30, 100); // measured 0.010
    const large = cycleRate(0.1, 0.1, 300, 40); // measured 0.567
    expect(small).toBeLessThan(0.1);
    expect(large).toBeGreaterThan(0.35);
    expect(large).toBeGreaterThan(small * 5);
    // Under the OLD rule this comparison ran the other way (60.5% at n=30,
    // 5.0% at n=300) — more evidence made promotion LESS likely, which is
    // only possible if the promotions were noise.
  });
});

describe('downsideHonestLowerBound — the mechanism, in isolation', () => {
  const lossFree: ItemPair[] = Array.from({ length: 30 }, (_, i) => ({
    itemId: `i${i}`,
    candidateQuality: i < 2 ? 1 : 0.5,
    incumbentQuality: 0.5,
  }));
  const deltas = lossFree.map((p) => p.candidateQuality - p.incumbentQuality);

  it('the plain bootstrap bound really is pinned at 0 for every alpha', () => {
    // The defect, still demonstrable: this is why no correction could reach it.
    expect(pairedBootstrapCi(deltas, 5, 8000, 0.05).ci95[0]).toBe(0);
    expect(pairedBootstrapCi(deltas, 5, 8000, 0.0025).ci95[0]).toBe(0);
  });

  it('charges the sample its own scale, and the bound moves off the floor', () => {
    const { lower, charge } = downsideHonestLowerBound(lossFree, deltas, 5, 8000, 0.05, 0);
    expect(lower).toBeLessThan(0);
    expect(charge).toBeGreaterThan(0);
    // max |delta| here is 0.5 (the two wins), so the pseudo-loss is −0.5.
    expect(charge).toBeLessThanOrEqual(0.5);
  });

  it('charges NOTHING once the sample contains a loss — the ordinary case', () => {
    const withLoss = [...lossFree.slice(0, 29), { itemId: 'x', candidateQuality: 0, incumbentQuality: 0.5 }];
    const d = withLoss.map((p) => p.candidateQuality - p.incumbentQuality);
    const plain = pairedBootstrapCi(d, 5, 8000, 0.05).ci95[0];
    const { lower, charge } = downsideHonestLowerBound(withLoss, d, 5, 8000, 0.05, plain);
    expect(charge).toBe(0);
    expect(lower).toBe(plain);
  });

  it('vanishes as evidence accumulates — its weight is 1/(n+1)', () => {
    const big: ItemPair[] = Array.from({ length: 600 }, (_, i) => ({
      itemId: `i${i}`,
      candidateQuality: i < 40 ? 1 : 0.5,
      incumbentQuality: 0.5,
    }));
    const bd = big.map((p) => p.candidateQuality - p.incumbentQuality);
    const small = downsideHonestLowerBound(lossFree, deltas, 5, 4000, 0.05, 0).charge;
    const large = downsideHonestLowerBound(big, bd, 5, 4000, 0.05,
      pairedBootstrapCi(bd, 5, 4000, 0.05).ci95[0]).charge;
    expect(large).toBeLessThan(small);
    // 600 loss-free items DO eventually certify non-inferiority, which is
    // exactly what the rule of three says and what the old rule could never
    // distinguish from 30 loss-free items.
    expect(large).toBeLessThan(0.015);
  });
});
