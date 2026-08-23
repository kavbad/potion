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
export const DEFAULT_AMBIGUITY_MARGIN = 0.03;

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
  /** Measured quality of the point the policy resolves to; null when the
   * cluster has no serving frontier (the resolution is a fallback). */
  quality: number | null;
  costPer1K: number | null;
}

/**
 * Which of two candidates to serve. Measured beats unmeasured; then higher
 * quality; then lower cost; then the original best (stable on a true tie).
 */
export function pickSafer<T extends TiebreakCandidate>(best: T, runnerUp: T): T {
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
