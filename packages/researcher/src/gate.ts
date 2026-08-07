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
//   cost path    — cost cut ≥ 20% AND ciLower ≥ 0 (≥ same quality)
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
  /** Bootstrap resamples (SPEC pins 1000). */
  resamples?: number;
}

export interface PromotionVerdict {
  promote: boolean;
  path: 'quality' | 'cost' | null;
  /** Paired items compared. */
  n: number;
  /** Observed mean per-item quality delta. */
  meanDelta: number;
  /** 95% percentile CI on the mean delta. */
  ci95: [number, number];
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

export const DEFAULT_QUALITY_DELTA_MIN = 0.015;
export const DEFAULT_COST_CUT_MIN = 0.2;
export const DEFAULT_RESAMPLES = 1000;

/** Percentile bootstrap CI on the mean of `deltas` (seeded, reproducible).
 * The math lives in @potion/core bootstrapMeanCi (moved verbatim in G0.3 so
 * the guarantee breach CI shares the pinned primitive) — this wrapper keeps
 * the SPEC §15.4 name and signature; verdicts are bit-identical. */
export function pairedBootstrapCi(
  deltas: number[],
  seed: number,
  resamples: number = DEFAULT_RESAMPLES,
): { mean: number; ci95: [number, number] } {
  return bootstrapMeanCi(deltas, seed, resamples);
}

export function evaluatePromotion(
  pairs: ItemPair[],
  opts: {
    candidateCostPer1K: number;
    incumbentCostPer1K: number;
    seed: number;
    thresholds?: PromotionThresholds;
  },
): PromotionVerdict {
  const qualityDeltaMin = opts.thresholds?.qualityDeltaMin ?? DEFAULT_QUALITY_DELTA_MIN;
  const costCutMin = opts.thresholds?.costCutMin ?? DEFAULT_COST_CUT_MIN;
  const resamples = opts.thresholds?.resamples ?? DEFAULT_RESAMPLES;
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

  const base = {
    path: null,
    n: pairs.length,
    costCutPct,
    seed: opts.seed,
    resamples,
  } as const;

  if (pairs.length === 0) {
    return {
      ...base,
      promote: false,
      meanDelta: 0,
      ci95: [0, 0],
      reason: 'no paired heldout items — nothing to bootstrap',
    };
  }

  const deltas = pairs.map((p) => p.candidateQuality - p.incumbentQuality);
  const { mean, ci95 } = pairedBootstrapCi(deltas, opts.seed, resamples);
  const [ciLower] = ci95;

  // Quality path: CI clears +1.5pts at ≤ incumbent cost (epsilon-tolerant).
  if (ciLower >= qualityDeltaMin && costAtMostIncumbent) {
    return {
      ...base,
      promote: true,
      path: 'quality',
      meanDelta: mean,
      ci95,
      reason:
        `quality path: CI95 lower ${ciLower.toFixed(4)} ≥ ${qualityDeltaMin} ` +
        `at cost ${opts.candidateCostPer1K} ≤ ${opts.incumbentCostPer1K}`,
    };
  }

  // Cost path: ≥20% cost cut at ≥ same quality (CI lower ≥ 0).
  if (costCutPct >= costCutMin && ciLower >= 0) {
    return {
      ...base,
      promote: true,
      path: 'cost',
      meanDelta: mean,
      ci95,
      reason:
        `cost path: cost cut ${(costCutPct * 100).toFixed(1)}% ≥ ${costCutMin * 100}% ` +
        `with CI95 lower ${ciLower.toFixed(4)} ≥ 0 (quality held)`,
    };
  }

  return {
    ...base,
    promote: false,
    meanDelta: mean,
    ci95,
    reason:
      `hold: CI95 [${ci95[0].toFixed(4)}, ${ci95[1].toFixed(4)}] lower bound clears neither ` +
      `+${qualityDeltaMin} quality @ ≤cost nor ${costCutMin * 100}% cost cut @ ≥quality`,
  };
}
