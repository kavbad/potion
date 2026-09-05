// G2 rung 4c — WHAT THE CANARY PROVED, and whether it may be promoted.
//
// The gate this implements is deliberately narrow, and the narrowness is
// the design:
//
//   REFUSE ONLY WHAT THE EVIDENCE CONDEMNS. A promotion is blocked when the
//   org's own traffic says the candidate is CONFIDENTLY worse — intervals
//   that do not overlap, not means that happen to differ. Thin evidence, or
//   evidence that merely fails to prove an improvement, does not block:
//   promoting a never-canaried generation is already an ordinary operator
//   act, so blocking a lightly-canaried one would punish the operator for
//   gathering evidence at all. The gate exists to catch the mistake nobody
//   would make on purpose, not to referee routing decisions.
//
// Both comparisons are measured-vs-measured on the SAME traffic over the
// SAME window (the canary slice against the concurrent control), which is
// the property that makes this better evidence than any suite. Costs are
// real spend; quality is the serve-judge instrument on both sides — never
// mixed with suite scores, per the house instrument rule.
import { BOOTSTRAP_RESAMPLES, bootstrapMeanCi, seedFromString } from '@potion/core';
import type { GenerationEvidence, GenerationSideSamples } from '@potion/db';

/** Below this on either side, an interval is noise wearing a number. */
export const MIN_CANARY_REQUESTS = 30;

export interface SideStat {
  n: number;
  mean: number;
  ci: [number, number];
}

export interface GenerationVerdict {
  /** Enough requests on BOTH sides for the intervals to mean anything. */
  sufficient: boolean;
  /** The org's own traffic says this candidate is worse. Blocks promotion. */
  adverse: boolean;
  /** Plain sentences — what the operator is told, verbatim. */
  reasons: string[];
  canaryRequests: number;
  controlRequests: number;
  cost: { canary: SideStat; control: SideStat } | null;
  quality: { canary: SideStat; control: SideStat } | null;
  since: string | null;
}

function stat(values: number[], seedKey: string): SideStat | null {
  if (values.length === 0) return null;
  const { mean, ci95 } = bootstrapMeanCi(values, seedFromString(seedKey), BOOTSTRAP_RESAMPLES);
  return { n: values.length, mean, ci: ci95 };
}

const enough = (s: GenerationSideSamples): boolean => s.requests >= MIN_CANARY_REQUESTS;

/**
 * Pure over the evidence, so the promotion rule is asserted in tests rather
 * than discovered when someone promotes something.
 */
export function generationVerdict(ev: GenerationEvidence, generationId: string): GenerationVerdict {
  const cost = {
    canary: stat(ev.canary.costs, `gen-cost-canary|${generationId}`),
    control: stat(ev.control.costs, `gen-cost-control|${generationId}`),
  };
  const quality = {
    canary: stat(ev.canary.qualities, `gen-q-canary|${generationId}`),
    control: stat(ev.control.qualities, `gen-q-control|${generationId}`),
  };
  const sufficient = enough(ev.canary) && enough(ev.control);
  const reasons: string[] = [];
  let adverse = false;

  if (!sufficient) {
    reasons.push(
      `not enough traffic to judge yet — ${ev.canary.requests} canary and ` +
        `${ev.control.requests} control requests, ${MIN_CANARY_REQUESTS} needed on each. ` +
        'Promoting is still allowed; this is a statement about the evidence, not a refusal.',
    );
  }

  // CONFIDENTLY more expensive: the canary's cost interval sits entirely
  // above the control's. Overlapping intervals are not a finding.
  if (sufficient && cost.canary !== null && cost.control !== null && cost.canary.ci[0] > cost.control.ci[1]) {
    adverse = true;
    reasons.push(
      `costs more on your own traffic: $${cost.canary.mean.toFixed(6)} per request ` +
        `[${cost.canary.ci[0].toFixed(6)}–${cost.canary.ci[1].toFixed(6)}] against ` +
        `$${cost.control.mean.toFixed(6)} [${cost.control.ci[0].toFixed(6)}–${cost.control.ci[1].toFixed(6)}] — ` +
        'the intervals do not overlap.',
    );
  }

  // CONFIDENTLY worse quality, on the serve-judge instrument for both sides.
  if (
    sufficient &&
    quality.canary !== null &&
    quality.control !== null &&
    quality.canary.n >= MIN_CANARY_REQUESTS &&
    quality.control.n >= MIN_CANARY_REQUESTS &&
    quality.canary.ci[1] < quality.control.ci[0]
  ) {
    adverse = true;
    reasons.push(
      `scores worse on your own traffic: ${quality.canary.mean.toFixed(3)} ` +
        `[${quality.canary.ci[0].toFixed(3)}–${quality.canary.ci[1].toFixed(3)}] against ` +
        `${quality.control.mean.toFixed(3)} [${quality.control.ci[0].toFixed(3)}–${quality.control.ci[1].toFixed(3)}] — ` +
        'the intervals do not overlap.',
    );
  }

  if (sufficient && !adverse) {
    reasons.push('nothing in your traffic says this routing is worse.');
  }

  return {
    sufficient,
    adverse,
    reasons,
    canaryRequests: ev.canary.requests,
    controlRequests: ev.control.requests,
    cost: cost.canary !== null && cost.control !== null ? { canary: cost.canary, control: cost.control } : null,
    quality:
      quality.canary !== null && quality.control !== null ? { canary: quality.canary, control: quality.control } : null,
    since: ev.since,
  };
}
