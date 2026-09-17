// Cluster ambiguity and the quality-safe tiebreak (2026-08-22).
//
// Production runs the OpenAI embedder with POTION_CLUSTER_THRESHOLD=0.2; the
// 0.62 default was tuned for the mock embedder. Measured on the first 41
// classified production requests: mean centroid cosine 0.39–0.54 in EVERY
// length bucket, mean margin between the best and runner-up cluster 0.025–
// 0.069, 29 of 41 under 0.05. Nearest-centroid is close to a coin flip
// between two clusters for most real traffic, and each cluster has its own
// frontier, so the flip can silently buy a cheaper, worse model.
//
// The rule: when the top two clusters are within the ambiguity margin, serve
// under whichever of the two resolves (under the org's policy) to the higher
// measured quality. Ambiguity never buys a cheaper model. The tiebreak is
// recorded on the request row so its rate is measurable.
import type { RankedAssignment } from '@potion/cluster';

/** Cosine gap under which the best and runner-up are treated as a pair. */
// 0.05, up from 0.03 (2026-09-17). In the head-to-head the costliest item
// of the whole run — 30% of Potion's bill — was an agentic-tool-use item
// classified summarization at confidence 0.406 with a 0.047 margin: a coin
// flip the tiebreak never saw. On the same 182 items, 28 fell inside 0.03
// and 44 inside 0.05; on real traffic 34% sit below 0.55 confidence.
export const DEFAULT_AMBIGUITY_MARGIN = 0.05;

/** POTION_CLUSTER_AMBIGUITY overrides the margin; 0 disables the tiebreak. */
export function ambiguityMargin(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.POTION_CLUSTER_AMBIGUITY;
  if (raw === undefined || raw === '') return DEFAULT_AMBIGUITY_MARGIN;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n >= 1) {
    throw new Error(`POTION_CLUSTER_AMBIGUITY must be a number in [0,1), got '${raw}'`);
  }
  return n;
}

/**
 * The runner-up cluster when the decision is ambiguous, else null. A decision
 * that fell back to 'general' is not a near-miss between two measured
 * clusters and is left alone.
 */
export function ambiguousRunnerUp(ranked: RankedAssignment, margin: number): string | null {
  if (margin <= 0 || ranked.fellBack) return null;
  const best = ranked.assignment;
  const runnerUp = ranked.ranking.find((r) => r.clusterId !== best.clusterId);
  if (!runnerUp) return null;
  return best.confidence - runnerUp.confidence < margin ? runnerUp.clusterId : null;
}

export interface TiebreakCandidate {
  clusterId: string;
  /** 0 when the policy selected a measured point (the floor was cleared),
   * 1 when a fallback served. Absent = unknown (legacy callers). */
  fallback?: 0 | 1;
  /** Measured quality of the point the policy resolves to; null when the
   * cluster has no serving frontier (the resolution is a fallback). */
  quality: number | null;
  costPer1K: number | null;
}

/**
 * Which of two candidates to serve. Measured beats unmeasured; then higher
 * quality; then lower cost; then the original best (stable on a true tie).
 */
export function pickSafer<T extends TiebreakCandidate>(best: T, runnerUp: T, objective: 'quality' | 'cost' = 'quality'): T {
  // DON'T PAY FOR THE DOUBT (2026-09-17). When the classifier cannot tell
  // two kinds of work apart and BOTH candidate points cleared their floor,
  // the floor is the quality contract and the policy's objective decides:
  // under min_cost, the cheaper point. Quality-first remains the rule when
  // either side is a fallback (its floor was NOT met) or under a
  // quality-objective policy.
  if (objective === 'cost' && best.fallback === 0 && runnerUp.fallback === 0 && best.costPer1K !== null && runnerUp.costPer1K !== null) {
    return runnerUp.costPer1K < best.costPer1K ? runnerUp : best;
  }
  if (best.quality === null && runnerUp.quality === null) return best;
  if (best.quality === null) return runnerUp;
  if (runnerUp.quality === null) return best;
  if (runnerUp.quality > best.quality) return runnerUp;
  if (runnerUp.quality < best.quality) return best;
  if (runnerUp.costPer1K !== null && best.costPer1K !== null && runnerUp.costPer1K < best.costPer1K) {
    return runnerUp;
  }
  return best;
}

/**
 * THE BOUNDARY FRONTIER (2026-09-08).
 *
 * `pickSafer` compares each cluster's point on ITS OWN suite — a lower bound
 * measured on reasoning word problems against one measured on invoices — and
 * calls the higher number "safer". Measured on the benchmark's boundary items
 * (order-inversion tasks two independent labellers split on) that sent every
 * tie to multi-step-reasoning, whose cheapest point inverts the order wrong or
 * runs out of budget on a third of them, while extraction's point answers them
 * in nine tokens. No rule over those two numbers can fix that: neither was
 * measured on the items in question.
 *
 * So the boundary between two clusters is its own workload. A suite that is
 * the union of both parents' items is swept like any cluster, under the id
 * below; a point earns a place on that frontier only by clearing the floor on
 * BOTH kinds of item. When the classifier cannot place a request, the serve
 * path resolves the policy against THAT frontier first, and falls back to the
 * tiebreak only when no measured boundary point exists. The receipt names the
 * boundary cluster, so the decision is visible rather than laundered into one
 * parent or the other.
 */
export const BOUNDARY_SEPARATOR = '+';

/** Stable id for the boundary between two clusters, whichever order they arrive in. */
export function boundaryClusterId(a: string, b: string): string {
  return [a, b].sort().join(BOUNDARY_SEPARATOR);
}

/** TRUE when a resolution came from a MEASURED point — not a fallback, not
 *  an empty frontier — and can therefore stand in for the tiebreak. */
export function boundaryServes<T extends { op: { fallback: 0 | 1; config: unknown } }>(
  boundary: T | null | undefined,
): boundary is T {
  return boundary !== null && boundary !== undefined && boundary.op.fallback !== 1 && boundary.op.config !== null;
}
