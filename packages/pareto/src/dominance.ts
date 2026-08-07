// Dominance & Pareto-frontier computation (SPEC §6) — pure functions.
//
// Objective space: quality is MAXIMIZED; costPer1K and latencyP95 are MINIMIZED.
// A point p is dominated when some other point q is at least as good on every
// axis and strictly better on at least one.
//
// Near-ties: all comparisons use DOMINANCE_EPSILON (1e-9). Within the epsilon
// band two coordinates are treated as EQUAL, so a dominator must beat p by
// more than epsilon on at least one axis (and may not be worse by more than
// epsilon on any axis). This keeps float noise (e.g. aggregated cost means)
// from creating or destroying domination relationships.
import type { FrontierPoint, StrategyAggregate } from '@potion/core';

/** Epsilon band for near-tie handling in all dominance comparisons. */
export const DOMINANCE_EPSILON = 1e-9;

/**
 * isDominated(p, others) → the first point in `others` that dominates p, or
 * null when p is non-dominated. Points sharing p's strategyHash are skipped
 * (a strategy never dominates itself / its own duplicates).
 *
 * q dominates p iff (within DOMINANCE_EPSILON):
 *   q.quality   >= p.quality   AND
 *   q.costPer1K <= p.costPer1K AND
 *   q.latencyP95 <= p.latencyP95
 * with at least one comparison strict (q better by more than epsilon).
 */
export function isDominated(p: FrontierPoint, others: FrontierPoint[]): FrontierPoint | null {
  const eps = DOMINANCE_EPSILON;
  for (const q of others) {
    if (q.strategyHash === p.strategyHash) continue;
    const noWorse =
      q.quality >= p.quality - eps &&
      q.costPer1K <= p.costPer1K + eps &&
      q.latencyP95 <= p.latencyP95 + eps;
    if (!noWorse) continue;
    const strictlyBetter =
      q.quality > p.quality + eps ||
      q.costPer1K < p.costPer1K - eps ||
      q.latencyP95 < p.latencyP95 - eps;
    if (strictlyBetter) return q;
  }
  return null;
}

/** Map a StrategyAggregate to frontier objective coordinates (SPEC §6:
 * quality from qualityMean, latency from latencyP95). Provenance (M1a)
 * carries through: a point is only ever 'live' when its aggregate was. */
export function aggregateToPoint(agg: StrategyAggregate): FrontierPoint {
  return {
    clusterId: agg.clusterId,
    strategyHash: agg.strategyHash,
    strategyConfig: agg.strategyConfig,
    quality: agg.qualityMean,
    costPer1K: agg.costPer1K,
    latencyP95: agg.latencyP95,
    ...(agg.providerMode !== undefined ? { providerMode: agg.providerMode } : {}),
    // G1.6: evidence links survive the aggregate→point projection.
    ...(agg.evidence !== undefined ? { evidence: agg.evidence } : {}),
  };
}

/** True when two points occupy the same objective coordinates (within epsilon). */
function sameCoordinates(a: FrontierPoint, b: FrontierPoint): boolean {
  const eps = DOMINANCE_EPSILON;
  return (
    Math.abs(a.quality - b.quality) <= eps &&
    Math.abs(a.costPer1K - b.costPer1K) <= eps &&
    Math.abs(a.latencyP95 - b.latencyP95) <= eps
  );
}

/** Deterministic candidate order: cost asc, then strategyHash asc. */
function byCostThenHash(a: FrontierPoint, b: FrontierPoint): number {
  return a.costPer1K - b.costPer1K || a.strategyHash.localeCompare(b.strategyHash);
}

/**
 * computeFrontier(aggs) → the non-dominated FrontierPoints, sorted by
 * costPer1K ascending (ties: quality desc, then strategyHash asc).
 *
 * Dedupe rules (documented, deterministic):
 *  1. Same strategyHash appearing twice (e.g. duplicate aggregates) keeps ONE
 *     copy — the first in (cost, hash) order.
 *  2. Two DIFFERENT strategies occupying identical objective coordinates
 *     (within DOMINANCE_EPSILON on all three axes) are collapsed to ONE point
 *     (the cheaper-hash one) — neither dominates the other (no axis is
 *     strictly better), but a frontier with two indistinguishable points is
 *     noise for buyers.
 */
export function computeFrontier(aggs: StrategyAggregate[]): FrontierPoint[] {
  const candidates = aggs.map(aggregateToPoint).sort(byCostThenHash);

  const deduped: FrontierPoint[] = [];
  for (const p of candidates) {
    if (deduped.some((k) => k.strategyHash === p.strategyHash)) continue; // rule 1
    if (deduped.some((k) => sameCoordinates(k, p))) continue; // rule 2
    deduped.push(p);
  }

  return deduped
    .filter((p) => isDominated(p, deduped) === null)
    .sort(
      (a, b) =>
        a.costPer1K - b.costPer1K || b.quality - a.quality || a.strategyHash.localeCompare(b.strategyHash),
    );
}
