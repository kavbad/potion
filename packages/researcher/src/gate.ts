// Promotion gate (SPEC §15.4): decide — with pinned statistics — whether a
// candidate recipe beats the incumbent operating point on HELDOUT evidence.
//
// Method (pinned by contract):
//   paired bootstrap over per-item heldout quality deltas
//     d_i = candidateQuality_i − incumbentQuality_i   (same items, paired)
//   1000 resamples with replacement, 95% percentile CI on the mean delta,
//   mulberry32 PRNG seeded from the cycle row (every verdict reproducible).
//
// Promote ONLY when the CI LOWER bound clears a threshold:
//   quality path — ciLower ≥ +1.5 pts (0.015 normalized) AND cost ≤ incumbent
//   cost path    — cost cut ≥ 20% AND a DOWNSIDE-HONEST ciLower ≥ −margin
//                  (non-inferiority: quality held to within `costQualityMargin`)
// A CI overlapping its threshold ⇒ the recipe stays 'candidate'. Thresholds
// are parameters (the worker reads env overrides); the pure function is
// provenance-agnostic — the LIVE-ONLY evidence rule is enforced by the
// caller (worker), never delegated here.
import { bootstrapMeanCi } from '@potion/core';

/** One heldout item scored by both recipes (paired by itemId). */
export interface ItemPair {
  itemId: string;
  candidateQuality: number;
  incumbentQuality: number;
}

export interface PromotionThresholds {
  /** Quality-path CI-lower-bound minimum (default 0.015 = +1.5 pts). */
  qualityDeltaMin?: number;
  /** Cost-path minimum fractional cost cut (default 0.20). */
  costCutMin?: number;
  /**
   * Cost-path NON-INFERIORITY MARGIN — how much measured quality a cost cut
   * is allowed to buy (default 0.015 = 1.5 pts, mirroring the quality path's
   * required GAIN).
   *
   * Not a loosening: it is what makes the cost path a test at all. The old
   * rule was `ciLower >= 0`, and a one-sided bound on a candidate whose true
   * delta is exactly 0 sits BELOW zero at every n — so a genuinely
   * quality-holding candidate passed only by luck, and measured power did not
   * rise with evidence (60.5% of cycles at n=30, 5.0% at n=300, 8.0% at
   * n=1000 — noise, not detection). Every non-inferiority test needs a margin;
   * margin 0 has no power at any sample size.
   *
   * The cost of a margin is that a promotion may knowingly accept a
   * regression up to it. Lower it to be stricter — but the evidence needed
   * scales as 1/margin^2: at m=20 comparisons and a realistic item-delta
   * spread, 1.5 pts needs ~2,000 paired items, 3 pts ~500, 0.5 pts ~18,000.
   */
  costQualityMargin?: number;
  /** Bootstrap resamples (SPEC pins 1000). */
  resamples?: number;
  /**
   * P0-4: minimum paired items before a verdict is a verdict. A FLOOR — the
   * platform minimum is applied whatever is passed, so contract-grade callers
   * raise it and nobody lowers it. Same discipline as
   * `GuaranteeConfig.minSamples`.
   */
  minPairs?: number;
}

export interface PromotionVerdict {
  promote: boolean;
  path: 'quality' | 'cost' | null;
  /**
   * P0-4: present when the gate DECLINED TO JUDGE rather than judged and said
   * no. The distinction matters to anything reading verdicts back: "we looked
   * and it was not better" and "we could not look" are different facts, and
   * only the second is fixed by waiting for more evidence.
   */
  refusal?: 'insufficient-evidence';
  /** Paired items compared. */
  n: number;
  /** Observed mean per-item quality delta. */
  meanDelta: number;
  /**
   * Percentile CI on the mean delta at `alpha` — NOT always 95%, which is why
   * it is no longer called ci95. A cycle adjudicating 20 candidates reads its
   * bound at 0.05/20, and a field name that said 95 while holding a 99.75%
   * interval is exactly the caption-vs-provenance failure this repo refuses.
   */
  ci: [number, number];
  /** Two-sided level the interval was read at: 0.05 / comparisons. */
  alpha: number;
  /**
   * The lower bound the COST path actually read — downside-honest, so not
   * always `ci[0]`. See `downsideCharge`.
   */
  costCiLower: number;
  /**
   * What the gate charged for downside the sample never showed, in quality
   * points (0 whenever the sample contained a losing item, which is the
   * ordinary case). A paired sample with NO loss gives a percentile bootstrap
   * no support below zero, so its lower bound is pinned at exactly 0 for
   * every alpha — a floor artifact, not a measurement. See `costLowerBound`.
   */
  downsideCharge: number;
  /** The non-inferiority margin this verdict's cost path was read against. */
  costQualityMargin: number;
  /** Family size the correction was made for. 1 = uncorrected. */
  comparisons: number;
  /** Fractional cost cut vs incumbent ((inc − cand) / inc; 0 when inc is 0 —
   * free-mock evidence can never take the cost path). */
  costCutPct: number;
  seed: number;
  resamples: number;
  reason: string;
}

/** Relative epsilon for the "≤ same cost" comparison (IEEE754 noise from
 * mean-of-doubles aggregation must not flip equal-cost verdicts). */
export const COST_COMPARISON_EPS = 1e-9;

/**
 * P0-4 (external review, 2026-09-05): the gate had NO minimum sample size, and
 * the call site guarded only `pairs.length === 0`. Measured before the fix, a
 * single item promoted:
 *
 *   n=1 quality path -> promote, ci95 [0.0999…, 0.0999…]  "lower 0.1000 ≥ 0.015"
 *   n=2 cost path    -> promote, ci95 [0, 0], 50% cost cut
 *
 * A percentile bootstrap over one delta resamples the same value a thousand
 * times: the interval collapses to a point and is then reported as a 95% CI.
 * That is the degenerate-interval class that motivated `jeffreysCi` — the
 * 42/42 champion reported as ±0.000 — and that the G2.8 capstone refused to
 * report as evidence. The gate deciding what reaches the frontier still had it.
 *
 * 5 mirrors GUARANTEE_MIN_SAMPLES and SUITE_VERIFY_MIN_PAIRS: one floor for
 * "enough evidence to say something" across the platform.
 *
 * NOT ALSO A WIDTH TEST. The review asked for degenerate intervals to be
 * refused outright too. A zero-width CI can only arise from identical deltas,
 * so at or above this floor it is a statement about the CANDIDATE — it matched
 * on every item — and refusing it would refuse a correct verdict. The floor
 * subsumes the case the review was actually worried about.
 *
 * That reasoning is about ZERO-WIDTH intervals and still holds. It does NOT
 * cover the neighbouring case found while proving P1-1: a sample with no
 * losing item gives a wide interval whose LOWER bound is pinned at exactly 0
 * for every alpha, which the cost path's `ciLower >= 0` accepts. See the
 * `cost-path non-inferiority` tests in gate.test.ts — open, not fixed here.
 */
export const PROMOTION_MIN_PAIRS = 5;

export const DEFAULT_QUALITY_DELTA_MIN = 0.015;
export const DEFAULT_COST_CUT_MIN = 0.2;
export const DEFAULT_COST_QUALITY_MARGIN = 0.015;
export const DEFAULT_RESAMPLES = 1000;

/** Percentile bootstrap CI on the mean of `deltas` (seeded, reproducible).
 * The math lives in @potion/core bootstrapMeanCi (moved verbatim in G0.3 so
 * the guarantee breach CI shares the pinned primitive) — this wrapper keeps
 * the SPEC §15.4 name and signature; verdicts are bit-identical. */
export function pairedBootstrapCi(
  deltas: number[],
  seed: number,
  resamples: number = DEFAULT_RESAMPLES,
  alpha: number = 0.05,
): { mean: number; ci95: [number, number] } {
  return bootstrapMeanCi(deltas, seed, resamples, alpha);
}

/**
 * The lower bound a NON-INFERIORITY claim may be read from — the fix for the
 * cost-path defect proven under P1-1 (2026-09-05).
 *
 * A percentile bootstrap can only ever resample outcomes the sample CONTAINS.
 * When no item in the paired sample is a loss, every resample mean is >= 0 and
 * the lower bound is pinned at exactly 0 — for alpha 0.05, for alpha 0.0025,
 * for any alpha at all. It is a floor artifact, and `ciLower >= 0` read it as
 * a measurement of held quality. Measured consequences of reading it (200
 * seeded cycles x 20 candidates, n=30, 10x cost cut):
 *
 *   a candidate truly 5pts WORSE          promoted in  14.5% of cycles
 *   a candidate 97% tied, 3% catastrophic promoted in   100% of cycles
 *
 * The second is the one that matters: 0.97^30 = 40% of 30-item samples miss a
 * 3%-rate failure entirely, and the gate then certified "quality held".
 *
 * Zero observed losses is the classic zero-count problem, and the rule of
 * three is its classic answer: with 0 losses in n items the loss rate is only
 * bounded BELOW about 3/n — 10% at n=30 — not shown to be zero. So the gate
 * gives the bootstrap the one outcome the sample could not exclude: a single
 * pseudo-observation at minus the magnitude the sample itself showed. Its
 * weight is 1/(n+1), so it vanishes as evidence accumulates, exactly as the
 * rule of three does.
 *
 * MAGNITUDE. `max |delta|` observed — the sample's own scale, and the honest
 * statement is "differences this size occurred in the candidate's favour; one
 * that size against it is not excluded". When the sample is ALL TIES it shows
 * no scale at all, so the charge falls back to the worst drop the quality
 * scale permits on these items (`max incumbentQuality`). That fallback is
 * what closes the 97%-tie/3%-catastrophe hole: an all-ties sample is not
 * evidence of equality, it is evidence of not having looked hard enough.
 *
 * ONLY the cost path reads this. The quality path claims SUPERIORITY, which
 * needs observed upside and cannot be manufactured by a missing tail. (The
 * same degeneracy does inflate the quality path's apparent POWER at n=30, and
 * that is the mechanism behind P1-1's documented 8.7%-vs-5% residual — a
 * separate, still-open matter, not this one.)
 */
export function downsideHonestLowerBound(
  pairs: ItemPair[],
  deltas: number[],
  seed: number,
  resamples: number,
  alpha: number,
  plainCiLower: number,
): { lower: number; charge: number } {
  if (deltas.some((d) => d < 0)) return { lower: plainCiLower, charge: 0 };
  const spread = Math.max(...deltas.map((d) => Math.abs(d)));
  const magnitude = spread > 0 ? spread : Math.max(...pairs.map((p) => p.incumbentQuality));
  if (magnitude <= 0) return { lower: plainCiLower, charge: 0 };
  const { ci95 } = pairedBootstrapCi([...deltas, -magnitude], seed, resamples, alpha);
  return { lower: ci95[0], charge: plainCiLower - ci95[0] };
}

export function evaluatePromotion(
  pairs: ItemPair[],
  opts: {
    candidateCostPer1K: number;
    incumbentCostPer1K: number;
    seed: number;
    /**
     * P1-1: how many candidates this cycle adjudicates against the SAME
     * incumbent — the comparison family this verdict is one member of.
     *
     * REQUIRED, and deliberately not defaulted. A gate that does not know how
     * many tests it is one of IS the defect P1-1 names: twenty candidates at
     * a 95% bound each false-promote 41.5% of cycles on pure noise. Making
     * every caller state its family size means the wiring cannot silently
     * regress — dropping it is a compile error, not a quieter gate.
     *
     * Pass 1 for a single-candidate adjudication; that is bit-identical to
     * every verdict recorded before this correction existed.
     */
    comparisons: number;
    thresholds?: PromotionThresholds;
  },
): PromotionVerdict {
  const qualityDeltaMin = opts.thresholds?.qualityDeltaMin ?? DEFAULT_QUALITY_DELTA_MIN;
  const costCutMin = opts.thresholds?.costCutMin ?? DEFAULT_COST_CUT_MIN;
  const costQualityMargin = Math.max(0, opts.thresholds?.costQualityMargin ?? DEFAULT_COST_QUALITY_MARGIN);
  const requestedResamples = opts.thresholds?.resamples ?? DEFAULT_RESAMPLES;
  const rawCutPct =
    opts.incumbentCostPer1K > 0
      ? (opts.incumbentCostPer1K - opts.candidateCostPer1K) / opts.incumbentCostPer1K
      : 0;
  // IEEE754 hygiene: mean-of-doubles arithmetic leaves representation noise
  // at the 1e-16 scale; clamp it so "equal cost" reports as 0, not −2e-16.
  const costCutPct = Math.abs(rawCutPct) < 1e-12 ? 0 : rawCutPct;
  // "≤ same cost" must not fail on float representation error: same-cost
  // candidates arrive as incumbent + 2e-16 after mean×1000. Relative epsilon.
  const costAtMostIncumbent =
    opts.candidateCostPer1K <= opts.incumbentCostPer1K * (1 + COST_COMPARISON_EPS) + 1e-12;

  // P1-1 BONFERRONI. A cycle tests every candidate against the SAME incumbent,
  // so the tests are a family and each one's 95% bound is not the cycle's.
  //
  // Measured (gate.test.ts, 400 seeded cycles x 20 pure-noise candidates,
  // true delta 0, equal cost so only the quality path is open):
  //   uncorrected  per-test 2.60%  (the nominal one-sided 2.5% — the bootstrap
  //                                 is well calibrated ONE test at a time)
  //                FWER 41.5%, 0.52 false promotions per cycle
  //   m=20         per-test 0.45%,  FWER 8.7%
  // So the inflation was never a broken interval; it was twenty of them.
  //
  // Bonferroni rather than FDR deliberately: it needs no second pass over the
  // family, it is exact rather than asymptotic, and this repo's discipline is
  // to promote only on proof. Being conservative here costs a delayed
  // promotion; being liberal costs a frontier built on noise.
  const comparisons = Math.max(1, Math.floor(opts.comparisons));
  const alpha = 0.05 / comparisons;

  // A corrected alpha asks for a percentile the resample set may not contain.
  // At m=20 the quality path reads the 0.125th percentile; 1000 resamples put
  // that at index 1.25 — the minimum of the set, an estimator with no tail
  // resolution at all. Floor the resamples so the wanted index is at least 10.
  // At m=1 this is 400, below DEFAULT_RESAMPLES, so every verdict recorded
  // before this correction existed reproduces bit-for-bit.
  const resamples = Math.max(requestedResamples, Math.ceil(10 / (alpha / 2)));
  const base = {
    path: null,
    n: pairs.length,
    costCutPct,
    seed: opts.seed,
    resamples,
    alpha,
    comparisons,
    costQualityMargin,
  } as const;

  // A floor: raise it, never lower it.
  const minPairs = Math.max(PROMOTION_MIN_PAIRS, opts.thresholds?.minPairs ?? 0);
  if (pairs.length < minPairs) {
    return {
      ...base,
      promote: false,
      refusal: 'insufficient-evidence',
      meanDelta: 0,
      ci: [0, 0],
      costCiLower: 0,
      downsideCharge: 0,
      reason:
        pairs.length === 0
          ? `no paired heldout items — nothing to bootstrap (a verdict needs ${minPairs})`
          : `${pairs.length} paired heldout item(s), below the ${minPairs} a verdict needs — ` +
            `refused, not judged: a bootstrap over this few resamples the same values and reports ` +
            `a point as an interval`,
    };
  }

  // What the interval is actually called once alpha moves off 0.05. Reasons are
  // read by operators and stored in the ledger; calling a 99.75% interval "CI95"
  // is exactly the honest-numbers bug class this repo keeps finding.
  const ciLabel =
    comparisons > 1
      ? `CI${(100 * (1 - alpha)).toFixed(2).replace(/\.?0+$/, '')}% (Bonferroni over ${comparisons} comparisons)`
      : 'CI95';

  const deltas = pairs.map((p) => p.candidateQuality - p.incumbentQuality);
  const { mean, ci95 } = pairedBootstrapCi(deltas, opts.seed, resamples, alpha);
  const [ciLower] = ci95;
  const { lower: costCiLower, charge: downsideCharge } = downsideHonestLowerBound(
    pairs,
    deltas,
    opts.seed,
    resamples,
    alpha,
    ciLower,
  );
  const bounds = { costCiLower, downsideCharge };

  // Quality path: CI clears +1.5pts at ≤ incumbent cost (epsilon-tolerant).
  if (ciLower >= qualityDeltaMin && costAtMostIncumbent) {
    return {
      ...base,
      promote: true,
      path: 'quality',
      meanDelta: mean,
      ci: ci95,
      ...bounds,
      reason:
        `quality path: ${ciLabel} lower ${ciLower.toFixed(4)} ≥ ${qualityDeltaMin} ` +
        `at cost ${opts.candidateCostPer1K} ≤ ${opts.incumbentCostPer1K}`,
    };
  }

  // Cost path: ≥20% cost cut with quality held to within the non-inferiority
  // margin, read from the DOWNSIDE-HONEST bound (see
  // downsideHonestLowerBound — `ciLower >= 0` on a loss-free sample was a
  // floor artifact that certified 97%-tie/3%-catastrophe candidates).
  if (costCutPct >= costCutMin && costCiLower >= -costQualityMargin) {
    return {
      ...base,
      promote: true,
      path: 'cost',
      meanDelta: mean,
      ci: ci95,
      ...bounds,
      reason:
        `cost path: cost cut ${(costCutPct * 100).toFixed(1)}% ≥ ${costCutMin * 100}% ` +
        `with ${ciLabel} lower ${costCiLower.toFixed(4)} ≥ −${costQualityMargin} ` +
        `(quality held to within ${(costQualityMargin * 100).toFixed(1)}pts` +
        `${downsideCharge > 0 ? `, incl. ${(downsideCharge * 100).toFixed(2)}pts charged for downside the sample never showed` : ''})`,
    };
  }

  return {
    ...base,
    promote: false,
    meanDelta: mean,
    ci: ci95,
    ...bounds,
    reason:
      `hold: ${ciLabel} [${ci95[0].toFixed(4)}, ${ci95[1].toFixed(4)}] lower bound clears neither ` +
      `+${qualityDeltaMin} quality @ ≤cost nor ${costCutMin * 100}% cost cut at ` +
      `≥ −${costQualityMargin} quality` +
      (downsideCharge > 0
        ? ` (cost bound ${costCiLower.toFixed(4)} after charging ` +
          `${(downsideCharge * 100).toFixed(2)}pts for downside the sample never showed — ` +
          `no item in it was a loss, so the bootstrap could not place one)`
        : ''),
  };
}
