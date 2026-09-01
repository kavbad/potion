// OUTCOME → ORG EVIDENCE (2026-09-01, G1). The customer's own application
// judged the answer — validator results, human accept/edit/reject, labels,
// scores. This is GROUND TRUTH where every other quality number is a
// judge's opinion, and it gets the same treatment as the other instruments:
//
//   · ITS OWN SCALE. instrument: 'customer-outcomes' — never blended with
//     serve-judge scores or suite-measured frontier quality. Three
//     instruments, three labeled blocks.
//   · LATEST SIGNAL WINS, per request and per signal kind. Outcomes are
//     append-only (a correction is one more POST); a request's verdict is
//     its newest non-null success / score / human signal, so a retried POST
//     or a later human review can never double-count.
//   · INTERVALS, not point estimates. Success rates carry the exact
//     Jeffreys binomial interval; scores the generalized one.
//   · OBSERVATIONAL, and labeled as such. Outcomes describe the routes that
//     actually served — routing itself decided which requests each strategy
//     saw, so cross-strategy comparison here is monitoring, not causal
//     proof (the randomized holdout is the causal instrument; see
//     ROADMAP §G1). Other strategies' signals are COUNTED, never ranked.
import { jeffreysCi } from '@potion/core';
import { listOutcomesSince, type PotionDb } from '@potion/db';

/** Evidence window (UTC days) — same default as the shadow evidence. */
export const OUTCOME_EVIDENCE_WINDOW_DAYS = 30;

/** The outcomes columns the aggregation reads (structural — the db row
 * type satisfies it). */
export interface OutcomeRowLike {
  requestId: string;
  clusterId: string | null;
  strategyHash: string | null;
  success: boolean | null;
  score: number | null;
  human: string | null;
  createdAt: Date;
}

export interface OutcomeSignalBlock {
  n: number;
  rate: number;
  ci: [number, number];
}

export interface ClusterOutcomeEvidence {
  instrument: 'customer-outcomes';
  windowDays: number;
  /** Distinct requests with ≥1 signal for the SERVING strategy. */
  requests: number;
  /** Exact Jeffreys binomial over each request's latest success verdict. */
  success: OutcomeSignalBlock | null;
  /** Generalized Jeffreys over each request's latest score. */
  score: { n: number; mean: number; ci: [number, number] } | null;
  /** Each request's latest human signal, counted. */
  human: { accepted: number; edited: number; rejected: number; regenerated: number } | null;
  /** Signals attached to OTHER strategies on this cluster in the window
   * (rotated-out routes) — counted so nothing is hidden, never ranked. */
  otherStrategyRequests: number;
}

/** One windowed read per org; per-cluster slicing is pure. */
export async function orgOutcomeRows(
  db: PotionDb,
  orgId: string,
  now: Date = new Date(),
): Promise<OutcomeRowLike[]> {
  const since = new Date(now.getTime() - OUTCOME_EVIDENCE_WINDOW_DAYS * 24 * 3600 * 1000);
  return listOutcomesSince(db, orgId, since);
}

/** rows are in insertion order (the repo read guarantees it), so a plain
 * overwrite implements latest-wins per (request, signal kind). */
function latestSignals(rows: OutcomeRowLike[]): Map<
  string,
  { success: boolean | null; score: number | null; human: string | null }
> {
  const byRequest = new Map<string, { success: boolean | null; score: number | null; human: string | null }>();
  for (const r of rows) {
    const cur = byRequest.get(r.requestId) ?? { success: null, score: null, human: null };
    if (r.success !== null) cur.success = r.success;
    if (r.score !== null) cur.score = r.score;
    if (r.human !== null) cur.human = r.human;
    byRequest.set(r.requestId, cur);
  }
  return byRequest;
}

/**
 * The per-cluster outcome evidence for the SERVING strategy, or null when
 * the window holds no signals for this cluster at all — an absent block
 * renders as absent, never as zeros.
 */
export function clusterOutcomeEvidence(
  rows: OutcomeRowLike[],
  args: { clusterId: string; servingHash: string },
): ClusterOutcomeEvidence | null {
  const inCluster = rows.filter((r) => r.clusterId === args.clusterId);
  if (inCluster.length === 0) return null;

  const servingRows = inCluster.filter((r) => r.strategyHash === args.servingHash);
  const otherStrategyRequests = new Set(
    inCluster.filter((r) => r.strategyHash !== args.servingHash).map((r) => r.requestId),
  ).size;

  const byRequest = latestSignals(servingRows);
  const successes = [...byRequest.values()].map((v) => v.success).filter((v): v is boolean => v !== null);
  const scores = [...byRequest.values()].map((v) => v.score).filter((v): v is number => v !== null);
  const humans = [...byRequest.values()].map((v) => v.human).filter((v): v is string => v !== null);

  const successBits = successes.map((s) => (s ? 1 : 0));
  return {
    instrument: 'customer-outcomes',
    windowDays: OUTCOME_EVIDENCE_WINDOW_DAYS,
    requests: byRequest.size,
    success:
      successes.length === 0
        ? null
        : {
            n: successes.length,
            rate: successBits.reduce((a: number, b) => a + b, 0) / successes.length,
            ci: jeffreysCi(successBits),
          },
    score:
      scores.length === 0
        ? null
        : {
            n: scores.length,
            mean: scores.reduce((a, b) => a + b, 0) / scores.length,
            ci: jeffreysCi(scores),
          },
    human:
      humans.length === 0
        ? null
        : {
            accepted: humans.filter((h) => h === 'accepted').length,
            edited: humans.filter((h) => h === 'edited').length,
            rejected: humans.filter((h) => h === 'rejected').length,
            regenerated: humans.filter((h) => h === 'regenerated').length,
          },
    otherStrategyRequests,
  };
}
