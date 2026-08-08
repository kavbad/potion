// The latency cost premium (G2.6).
//
// WHY THIS EXISTS. A latency bound is a hard constraint, so it PRUNES — and
// what it prunes first are exactly the serial compositions (cascade,
// draft-verify) that make the cost frontier valuable. The M1b result is the
// case in point: a cascade reaches near-frontier quality at roughly a third of
// the cost, but its latency profile is two calls whenever it escalates. Bound
// the p95 tightly enough and that point disappears, and the customer silently
// pays more for a constraint they may not need.
//
// So the pruning must be VISIBLE: "at your latency bound the cheapest
// qualifying strategy is X; relaxing to Y ms unlocks Z% savings." That is not
// a footnote — it is how a batch-tolerant customer discovers they should relax
// the bound. Same computation serves the per-request developer DTO and the
// per-month guarantee report.
import { SELECTION_EPSILON } from './latency.js';
import type { FrontierPoint, Policy } from './types.js';

/** Which constraint is actually costing money. */
export type PremiumBinding =
  /** The latency bound pruned a cheaper qualifying point. Relaxing pays. */
  | 'latency'
  /** No point clears the quality floor — the latency bound is not the
   * problem, and must never be blamed for one. */
  | 'quality'
  /** The cheapest quality-qualifying point already meets the bound. */
  | 'none';

export interface LatencyPremium {
  binding: PremiumBinding;
  /** Cheapest point meeting BOTH constraints. Null when none does. */
  selected: FrontierPoint | null;
  /** Cheapest point meeting the QUALITY floor, ignoring latency. */
  unbounded: FrontierPoint | null;
  /** selected.cost − unbounded.cost, per 1K requests. 0 unless binding. */
  deltaCostPer1K: number;
  /** Fraction of spend the bound is costing, 0..1. 0 unless binding. */
  savingsPct: number;
  /**
   * The p95 the bound would have to relax to for `unbounded` to qualify.
   * Null unless binding==='latency'. Carries the epsilon so the returned
   * value provably ADMITS the point it came from — a bare copy of
   * unbounded.latencyP95 can fail its own `<=` test after float arithmetic.
   */
  relaxLatencyToMs: number | null;
  /**
   * The other direction (owner refinement: surface relaxations BOTH ways).
   * The quality floor that would make the current bound feasible — i.e. the
   * best quality available among points that DO meet the latency bound. Null
   * when the bound admits nothing at all, or when it is not binding.
   */
  relaxQualityToFloor: number | null;
}

const EMPTY: LatencyPremium = {
  binding: 'none',
  selected: null,
  unbounded: null,
  deltaCostPer1K: 0,
  savingsPct: 0,
  relaxLatencyToMs: null,
  relaxQualityToFloor: null,
};

/** Cheapest first; ties → higher quality. The comparator selectPoint's
 * 'compound' case uses, so `selected` here EQUALS selectPoint's result (a
 * test asserts that rather than the two implementations being trusted to
 * agree). */
function cheapest(pts: FrontierPoint[]): FrontierPoint | null {
  if (pts.length === 0) return null;
  return [...pts].sort((a, b) => a.costPer1K - b.costPer1K || b.quality - a.quality)[0] ?? null;
}

/**
 * Compute the premium a compound policy's latency bound is costing.
 *
 * `points` must already carry the latency the policy is being evaluated
 * against (serving-grade where available — see resolveLatency). Passing raw
 * harness points computes a premium against a benchmark number, which is
 * exactly the substitution G2.6 exists to prevent; callers resolve first.
 */
export function latencyPremium(policy: Policy, points: FrontierPoint[]): LatencyPremium {
  if (policy.type !== 'compound' || points.length === 0) return EMPTY;

  const qualifying = points.filter((p) => p.quality >= policy.qualityFloor);
  // Quality-side infeasibility short-circuits: with nothing clearing the
  // floor there is no premium to attribute, and blaming the latency bound for
  // a quality problem would send the customer to relax the wrong knob.
  if (qualifying.length === 0) return { ...EMPTY, binding: 'quality' };

  const unbounded = cheapest(qualifying);
  const selected = cheapest(qualifying.filter((p) => p.latencyP95 <= policy.p95Ms));

  // The bound admits nothing among the quality-qualifying points. The premium
  // is undefined (there is no bounded price to compare), but the relaxation
  // target is exactly what the caller needs to surface.
  if (selected === null) {
    return {
      ...EMPTY,
      binding: 'latency',
      selected: null,
      unbounded,
      relaxLatencyToMs: unbounded === null ? null : unbounded.latencyP95 + SELECTION_EPSILON,
      relaxQualityToFloor: bestQualityUnderBound(points, policy.p95Ms),
    };
  }

  if (unbounded === null || selected.strategyHash === unbounded.strategyHash) {
    return { ...EMPTY, binding: 'none', selected, unbounded };
  }

  const delta = selected.costPer1K - unbounded.costPer1K;
  // Defensive: `unbounded` is the cheapest of a superset, so delta >= 0. A
  // negative would mean the comparators disagree — report no premium rather
  // than a nonsense negative saving.
  if (delta <= SELECTION_EPSILON) {
    return { ...EMPTY, binding: 'none', selected, unbounded };
  }

  return {
    binding: 'latency',
    selected,
    unbounded,
    deltaCostPer1K: delta,
    savingsPct: selected.costPer1K > 0 ? delta / selected.costPer1K : 0,
    relaxLatencyToMs: unbounded.latencyP95 + SELECTION_EPSILON,
    relaxQualityToFloor: bestQualityUnderBound(points, policy.p95Ms),
  };
}

/** Best quality reachable WITHOUT relaxing the latency bound — the other
 * direction of the owner's both-ways relaxation. Null when the bound admits
 * no point at all (relaxing quality cannot help). */
function bestQualityUnderBound(points: FrontierPoint[], p95Ms: number): number | null {
  const underBound = points.filter((p) => p.latencyP95 <= p95Ms);
  if (underBound.length === 0) return null;
  return Math.max(...underBound.map((p) => p.quality));
}
