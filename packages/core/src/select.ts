import type { Frontier, FrontierPoint, Policy } from './types.js';

/**
 * Policy evaluation against a frontier. Returns null when no point is feasible
 * (the serving layer then falls back to the highest-quality point).
 *
 * - max_quality: feasible = costPer1K <= ceiling; pick max quality, tie -> lower cost.
 * - min_cost:    feasible = quality >= floor;   pick min cost,   tie -> higher quality.
 * - latency_bound: feasible = latencyP95 <= p95Ms; pick max quality, tie -> lower cost.
 * - compound: feasible = quality >= floor AND latencyP95 <= p95Ms (a HARD
 *   intersect — the bound excludes, it never trades off); pick min cost,
 *   tie -> higher quality. Both constraints are stated by the customer, so
 *   cost is the only remaining objective; the comparator is min_cost's.
 *
 * The selector is PURE over FrontierPoint coordinates. Serving-grade latency
 * (G2.6) is substituted into the points BEFORE this call, never read inside
 * it — that keeps policy evaluation a function of its inputs and keeps the
 * "which latency did we bind against" question answerable at one seam.
 */
/**
 * THE QUALITY LOWER BOUND (2026-09-01, external core-API review P0 —
 * "statistically good enough, not point-estimate good enough", the
 * shadow-evidence doctrine promoted into the selector itself).
 *
 * A quality FLOOR is a promise to the customer, so FEASIBILITY tests it
 * against the evidence interval's lower bound: a point whose mean clears
 * the floor but whose interval does not has not PROVEN the floor.
 * RANKINGS (max_quality picks, tie-breaks, highestQualityPoint, dominance
 * construction) stay mean-based — ordering among qualifiers is
 * optimization, not a promise.
 *
 * Fallbacks mirror the latency axis's provisional discipline
 * (SERVING_LATENCY_MIN_SAMPLES): a point with no usable interval — legacy
 * rows, or the degenerate qualityCi95=0 of pre-Jeffreys perfection — is
 * judged by its mean, exactly as before. Only evidence-bearing points
 * near floors change behavior, which is precisely the honest set.
 */
export function qualityLowerBound(p: FrontierPoint): number {
  const ci = p.evidence?.qualityCi;
  if (ci !== undefined && ci.length === 2 && ci[0] >= 0) return ci[0];
  const half = p.evidence?.qualityCi95;
  if (half !== undefined && half > 0) return p.quality - half;
  return p.quality;
}

export function selectPoint(policy: Policy, frontier: Frontier): FrontierPoint | null {
  const pts = frontier.points;
  if (pts.length === 0) return null;

  switch (policy.type) {
    case 'max_quality': {
      const feasible = pts.filter((p) => p.costPer1K <= policy.costCeilingPer1K);
      return pickBest(feasible, (a, b) => b.quality - a.quality || a.costPer1K - b.costPer1K);
    }
    case 'min_cost': {
      const feasible = pts.filter((p) => qualityLowerBound(p) >= policy.qualityFloor);
      return pickBest(feasible, (a, b) => a.costPer1K - b.costPer1K || b.quality - a.quality);
    }
    case 'latency_bound': {
      const feasible = pts.filter((p) => p.latencyP95 <= policy.p95Ms);
      return pickBest(feasible, (a, b) => b.quality - a.quality || a.costPer1K - b.costPer1K);
    }
    case 'compound': {
      const feasible = pts.filter(
        (p) => qualityLowerBound(p) >= policy.qualityFloor && p.latencyP95 <= policy.p95Ms,
      );
      return pickBest(feasible, (a, b) => a.costPer1K - b.costPer1K || b.quality - a.quality);
    }
  }
}

/**
 * The QUALITY-only survivors of a compound policy — the fallback set for the
 * latency-infeasible case (G2.6). When no point clears the latency bound, the
 * serving layer serves the FASTEST point that still meets the quality floor
 * and labels the violation: violate the customer-observable dimension
 * (latency), never the customer-invisible one (quality) — detecting quality
 * degradation is the product itself.
 *
 * Ties on latency break to lower cost, then higher quality, so the choice is
 * total and reproducible.
 */
export function fastestQualityQualifyingPoint(
  points: FrontierPoint[],
  qualityFloor: number,
): FrontierPoint | null {
  const qualifying = points.filter((p) => qualityLowerBound(p) >= qualityFloor);
  return pickBest(
    qualifying,
    (a, b) => a.latencyP95 - b.latencyP95 || a.costPer1K - b.costPer1K || b.quality - a.quality,
  );
}

function pickBest(
  pts: FrontierPoint[],
  cmp: (a: FrontierPoint, b: FrontierPoint) => number,
): FrontierPoint | null {
  if (pts.length === 0) return null;
  return [...pts].sort(cmp)[0] ?? null;
}

/** Policy-free incumbent: the max-quality point (ties → cheaper). Used as
 * the serving fallback when selectPoint returns null (§8) AND as the
 * promotion gate's incumbent operating point (SPEC §15.4). */
export function highestQualityPoint(points: FrontierPoint[]): FrontierPoint | null {
  if (points.length === 0) return null;
  return [...points].sort((a, b) => b.quality - a.quality || a.costPer1K - b.costPer1K)[0] ?? null;
}
