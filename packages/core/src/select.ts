import type { Frontier, FrontierPoint, Policy } from './types.js';

/**
 * Policy evaluation against a frontier. Returns null when no point is feasible
 * (the serving layer then falls back to the highest-quality point).
 *
 * - max_quality: feasible = costPer1K <= ceiling; pick max quality, tie -> lower cost.
 * - min_cost:    feasible = quality >= floor;   pick min cost,   tie -> higher quality.
 * - latency_bound: feasible = latencyP95 <= p95Ms; pick max quality, tie -> lower cost.
 */
export function selectPoint(policy: Policy, frontier: Frontier): FrontierPoint | null {
  const pts = frontier.points;
  if (pts.length === 0) return null;

  switch (policy.type) {
    case 'max_quality': {
      const feasible = pts.filter((p) => p.costPer1K <= policy.costCeilingPer1K);
      return pickBest(feasible, (a, b) => b.quality - a.quality || a.costPer1K - b.costPer1K);
    }
    case 'min_cost': {
      const feasible = pts.filter((p) => p.quality >= policy.qualityFloor);
      return pickBest(feasible, (a, b) => a.costPer1K - b.costPer1K || b.quality - a.quality);
    }
    case 'latency_bound': {
      const feasible = pts.filter((p) => p.latencyP95 <= policy.p95Ms);
      return pickBest(feasible, (a, b) => b.quality - a.quality || a.costPer1K - b.costPer1K);
    }
  }
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
