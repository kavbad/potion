// RELIABILITY (C5, docs/INFERENCE-COMPILER-PLAN.md).
//
// The review asks for a fourth frontier axis — quality x cost x latency x
// reliability — and for the objective to become "cost per SUCCESSFUL task"
// rather than cost per inference. A $0.02 run at 70% success is worse than a
// $0.04 run at 98%, and for agents that is the whole ballgame.
//
// WHY THE FOURTH AXIS IS NOT HERE, AND WHAT IS.
//
// A frontier axis RANKS strategies against each other, so every axis on it has
// to come from a controlled comparison. Quality, cost and latency do: the
// harness runs every strategy over the SAME items. Reliability does not, from
// either of the two places Potion could get it:
//
//   · From measurement — it is not there to get. The harness CONTAINS a
//     failing strategy by dropping it whole ("partial aggregates are biased",
//     runner.ts), so a strategy either completed every item or contributed
//     nothing. There is no per-item failure rate to aggregate, by design.
//   · From served traffic — the Outcome API has exactly the success signal the
//     review wants, and it is OBSERVATIONAL. Routing decided which requests
//     each strategy saw, so cross-strategy comparison is "confounded by
//     construction" (holdout.ts's words). Ranking on it would make the
//     frontier a mixture of causal and observational claims, which is the
//     caption-vs-provenance failure this repo is built to avoid.
//
// So reliability lands as the two things observational evidence CAN honestly
// support, both about a deployed strategy rather than a comparison between
// candidates:
//
//   · costPerSuccess — what the customer actually pays per task that worked.
//     A monitoring number, conservative by construction.
//   · a reliability FLOOR — P(success) >= x on served traffic, with the same
//     "above the line" rigor the quality guarantee already uses, pointed in
//     the breach direction.
//
// What would unblock the axis: per-item outcome recording under the RANDOMIZED
// HOLDOUT, which is the causal instrument (holdout.ts). Two arms compared
// under randomization is a real experiment; the frontier is not.

/**
 * Cost per SUCCESSFUL task — the review's objective, computed conservatively.
 *
 * Uses the success rate's LOWER bound, not its point estimate: this number
 * goes in front of a customer, and the honest form of "what you pay per task
 * that worked" bills against the rate we can prove, not the one we hope for.
 * A lower bound of zero (or no evidence) yields null — dividing by an
 * unmeasured rate produces a number that looks like knowledge and is not.
 */
export function costPerSuccess(costPer1K: number, successLowerBound: number | null): number | null {
  if (successLowerBound === null || successLowerBound <= 0) return null;
  return costPer1K / successLowerBound;
}

export type ReliabilityVerdict = 'ok' | 'breached' | 'not-significant' | 'insufficient';

export interface ReliabilityFloorResult {
  verdict: ReliabilityVerdict;
  /** Observed success rate over the window, or null with no requests. */
  rate: number | null;
  ci: [number, number] | null;
  n: number;
  reason: string;
}

/**
 * Is a deployed strategy meeting its success floor?
 *
 * The rule matches the quality guarantee exactly, because the failure mode is
 * the same: a breach fires only when the whole interval is BELOW the floor.
 * Observed-below with a straddling interval is 'not-significant' — reported,
 * never an incident. Acting on a point estimate would turn ordinary sampling
 * noise into rollbacks, which is how a safety mechanism becomes the outage.
 */
export function evaluateReliabilityFloor(input: {
  successCi: [number, number] | null;
  rate: number | null;
  n: number;
  floor: number;
  minSamples: number;
}): ReliabilityFloorResult {
  const { successCi, rate, n, floor, minSamples } = input;
  const base = { rate, ci: successCi, n };
  if (successCi === null || n < minSamples) {
    return {
      ...base,
      verdict: 'insufficient',
      reason: `${n} outcome-reporting request(s) in the window, below the ${minSamples} needed to judge a floor`,
    };
  }
  const [lo, hi] = successCi;
  if (hi < floor) {
    return {
      ...base,
      verdict: 'breached',
      reason: `success interval [${lo.toFixed(3)}, ${hi.toFixed(3)}] lies entirely below the floor ${floor}`,
    };
  }
  if (lo >= floor) {
    return {
      ...base,
      verdict: 'ok',
      reason: `success lower bound ${lo.toFixed(3)} clears the floor ${floor}`,
    };
  }
  return {
    ...base,
    verdict: 'not-significant',
    reason: `success interval [${lo.toFixed(3)}, ${hi.toFixed(3)}] straddles the floor ${floor} — reported, not an incident`,
  };
}
