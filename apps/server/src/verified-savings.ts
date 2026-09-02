// G1 VERIFIED SAVINGS (0086) — the randomized-holdout economics, one
// implementation for BOTH surfaces that speak money: the Savings report and
// the INVOICE. "Verified" means what the org's own randomized traffic
// proves; the billable number is the conservative LOWER bound, never the
// estimate.
import { BOOTSTRAP_RESAMPLES, bootstrapMeanCi, seedFromString, sha256 } from '@potion/core';
import type { HoldoutWindowStats } from '@potion/db';

/** Minimum holdout requests before a savings number may say "verified". */
export const MIN_HOLDOUT_REQUESTS = 30;

/**
 * G1 VERIFIED SAVINGS (0086) — the randomized-holdout economics block.
 *
 * The claim covers ROUTED traffic only: withoutPotion = the holdout's mean
 * measured incumbent cost × routed request count; actual = routed measured
 * spend. Holdout requests sit on neither side — they cost incumbent price
 * and bought the baseline, and folding them in would add zero savings by
 * construction while blurring the claim. The billable number is the LOWER
 * bound: a seeded bootstrap CI over the holdout's per-request costs, so
 * "verified" means what the org's own randomized traffic proves, never the
 * point estimate (the savings-baseline critique, closed).
 */
export interface VerifiedSavings {
  status: 'off' | 'no-incumbent' | 'insufficient' | 'verified';
  /** The consented slice — shown wherever this block renders. */
  holdoutRate: number | null;
  incumbentModel: string | null;
  holdoutRequests: number;
  minHoldoutRequests: number;
  routedRequests: number;
  routedSpendUsd: number;
  meanIncumbentCostUsd: number | null;
  meanCi95: [number, number] | null;
  withoutPotionUsd: number | null;
  verifiedSavingsUsd: number | null;
  /** The conservative, billable bound: ci95[0] × routed − actual. */
  verifiedSavingsLowerUsd: number | null;
}

/** Pure builder (unit-tested): config + window stats → the block. */
export function buildVerifiedSavings(
  cfg: { consent: boolean; rate: number; incumbentModel: string | null },
  stats: HoldoutWindowStats,
  seedKey: string,
): VerifiedSavings {
  const base: VerifiedSavings = {
    status: 'off',
    holdoutRate: cfg.consent ? cfg.rate : null,
    incumbentModel: cfg.incumbentModel,
    holdoutRequests: stats.holdout.requests,
    minHoldoutRequests: MIN_HOLDOUT_REQUESTS,
    routedRequests: stats.routed.requests,
    routedSpendUsd: stats.routed.spendUsd,
    meanIncumbentCostUsd: null,
    meanCi95: null,
    withoutPotionUsd: null,
    verifiedSavingsUsd: null,
    verifiedSavingsLowerUsd: null,
  };
  if (!cfg.consent) return base;
  if (cfg.incumbentModel === null) return { ...base, status: 'no-incumbent' };
  if (stats.holdout.costs.length < MIN_HOLDOUT_REQUESTS) return { ...base, status: 'insufficient' };
  // Seed from the pair CONTENT (the computeRetention discipline): the same
  // window and the same costs always report the same interval.
  const costs = [...stats.holdout.costs].sort((a, b) => a - b);
  const seed = seedFromString(`${seedKey}|${costs.length}|${sha256(costs.map((c) => c.toFixed(10)).join(','))}`);
  const { mean, ci95 } = bootstrapMeanCi(costs, seed, BOOTSTRAP_RESAMPLES);
  const withoutPotionUsd = mean * stats.routed.requests;
  const lowerWithout = ci95[0] * stats.routed.requests;
  return {
    ...base,
    status: 'verified',
    meanIncumbentCostUsd: mean,
    meanCi95: [ci95[0], ci95[1]],
    withoutPotionUsd,
    verifiedSavingsUsd: withoutPotionUsd - stats.routed.spendUsd,
    verifiedSavingsLowerUsd: lowerWithout - stats.routed.spendUsd,
  };
}

/** The absent block — holdout off (also the unit-test default). */
export const VERIFIED_OFF: VerifiedSavings = {
  status: 'off',
  holdoutRate: null,
  incumbentModel: null,
  holdoutRequests: 0,
  minHoldoutRequests: MIN_HOLDOUT_REQUESTS,
  routedRequests: 0,
  routedSpendUsd: 0,
  meanIncumbentCostUsd: null,
  meanCi95: null,
  withoutPotionUsd: null,
  verifiedSavingsUsd: null,
  verifiedSavingsLowerUsd: null,
};

