// SHADOW → ORG EVIDENCE (2026-09-01) — the shadow plane's judge scores,
// aggregated into per-cluster evidence the router artifact can show and a
// challenger gate can read.
//
// Doctrine, in order of what would otherwise go wrong:
//   · ONE INSTRUMENT, NEVER MIXED. Shadow quality comes from the serve
//     judge (reference-free, on the org's real sampled traffic). The
//     frontier's quality column comes from eval suites — a different
//     instrument on a different distribution. These numbers never blend:
//     the serving comparator here is the org's own quality_samples (the
//     SAME serve judge scoring the SAME traffic's served answers), and the
//     evidence block is labeled instrument: 'serve-judge'.
//   · STATISTICALLY GOOD ENOUGH, not point-estimate good enough. A
//     challenger `qualifies` only when its generalized-Jeffreys LOWER
//     bound clears the cluster's floor on ≥ SHADOW_QUALIFY_MIN_N scored
//     samples — the first decision surface to consume the intervals the
//     evidence layer always carried (external review §9/§10).
//   · SAME COST BASIS on both sides. Challenger cost is measured actuals
//     (mean shadow cost_usd × 1000); the serving side is the org's own
//     measured cost per served request (request_logs), never a
//     suite-average costPer1K — mixing bases is the savings-baseline
//     critique (§21) all over again.
//   · READ-ONLY. `qualifies` flags a challenger on the artifact; nothing
//     here mutates routing. Promotion stays a human act (proposal
//     doctrine: Potion proposes, the user reacts).
import { jeffreysCi, quantileNearestRank } from '@potion/core';
import { listQualitySamplesSince, listShadowResults, servedClusterCostSince, type PotionDb } from '@potion/db';

/** Evidence window (UTC days), aligned with the savings report default. */
export const SHADOW_EVIDENCE_WINDOW_DAYS = 30;

/** Minimum SCORED samples before a challenger may qualify — the savings
 * report's 'medium' confidence edge (low < 30). */
export const SHADOW_QUALIFY_MIN_N = 30;

/** The shadow_results columns the aggregation reads (structural — the db
 * row type satisfies it). */
export interface ShadowRowLike {
  clusterId: string;
  candidateHash: string;
  candidateModel: string;
  quality: number | null;
  costUsd: number;
  latencyMs: number;
}

/** Serve-judge observations aggregated: n scored, mean, Jeffreys 95%. */
export interface ShadowObserved {
  n: number;
  quality: number;
  qualityCi: [number, number];
}

export interface ShadowChallenger extends ShadowObserved {
  strategyHash: string;
  /** The recorded candidate_model label (single model or combination). */
  model: string;
  /** ALL rows for this candidate (cost/latency evidence) — ≥ n. */
  samples: number;
  /** Measured actuals: mean shadow cost per request × 1000. */
  costPer1K: number;
  latencyP95: number;
  qualifies: boolean;
  /** Why it does or does not qualify — honest words, always present. */
  reason: string;
}

export interface ClusterShadowEvidence {
  instrument: 'serve-judge';
  windowDays: number;
  /** The SERVING strategy's own serve-judge scores (quality_samples) over
   * the window — the one-scale comparator. null = no guarantee sampling. */
  servingObserved: ShadowObserved | null;
  /** The org's measured serving cost for this cluster, per 1K requests
   * (actuals from request_logs) — the cost side of the compare. */
  servingMeasuredCostPer1K: number | null;
  challengers: ShadowChallenger[];
}

export interface ShadowEvidenceInputs {
  shadowRows: ShadowRowLike[];
  primaryQualities: Array<{ clusterId: string | null; strategyHash: string; quality: number }>;
  servedCosts: Array<{ clusterId: string; meanCostUsd: number; requests: number }>;
}

/** One fetch per org (three windowed reads); per-cluster slicing is pure. */
export async function orgShadowEvidenceInputs(
  db: PotionDb,
  orgId: string,
  now: Date = new Date(),
): Promise<ShadowEvidenceInputs> {
  const since = new Date(now.getTime() - SHADOW_EVIDENCE_WINDOW_DAYS * 24 * 3600 * 1000);
  const day = (d: Date): string => d.toISOString().slice(0, 10);
  const [shadowRows, primaryQualities, servedCosts] = await Promise.all([
    listShadowResults(db, orgId, { fromDay: day(since), toDay: day(now) }),
    listQualitySamplesSince(db, orgId, since),
    servedClusterCostSince(db, orgId, since),
  ]);
  return { shadowRows, primaryQualities, servedCosts };
}

function observed(scores: number[]): ShadowObserved | null {
  if (scores.length === 0) return null;
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  return { n: scores.length, quality: mean, qualityCi: jeffreysCi(scores) };
}

/**
 * The per-cluster evidence block, or null when the window holds nothing for
 * this cluster (no shadow rows AND no serving samples) — an absent block
 * renders as absent, never as zeros.
 */
export function clusterShadowEvidence(
  inputs: ShadowEvidenceInputs,
  args: {
    clusterId: string;
    /** The CURRENT serving strategy — its historical shadow rows (from when
     * a different primary served) are excluded from challengers: a strategy
     * is not a challenger to itself. */
    servingHash: string;
    /** The cluster's quality floor under the org's policy; null = the
     * policy has no floor dimension (max_quality), so floor-based
     * qualification is undefined and says so. */
    clusterFloor: number | null;
  },
): ClusterShadowEvidence | null {
  const rows = inputs.shadowRows.filter((r) => r.clusterId === args.clusterId);
  const primaryScores = inputs.primaryQualities
    .filter((s) => s.clusterId === args.clusterId && s.strategyHash === args.servingHash)
    .map((s) => s.quality);
  if (rows.length === 0 && primaryScores.length === 0) return null;

  const cost = inputs.servedCosts.find((c) => c.clusterId === args.clusterId) ?? null;
  const servingMeasuredCostPer1K = cost === null ? null : cost.meanCostUsd * 1000;

  const byCandidate = new Map<string, ShadowRowLike[]>();
  for (const r of rows) {
    if (r.candidateHash === args.servingHash) continue;
    const group = byCandidate.get(r.candidateHash);
    if (group) group.push(r);
    else byCandidate.set(r.candidateHash, [r]);
  }

  const challengers: ShadowChallenger[] = [...byCandidate.entries()].map(([hash, samples]) => {
    const scored = samples.filter((r) => r.quality !== null).map((r) => r.quality!);
    const obs = observed(scored) ?? { n: 0, quality: 0, qualityCi: [0, 1] as [number, number] };
    const costPer1K = (samples.reduce((s, r) => s + r.costUsd, 0) / samples.length) * 1000;
    const latencyP95 = quantileNearestRank(samples.map((r) => r.latencyMs), 0.95);
    const lower = obs.qualityCi[0];

    let qualifies = false;
    let reason: string;
    if (obs.n < SHADOW_QUALIFY_MIN_N) {
      reason = `${obs.n} of ${SHADOW_QUALIFY_MIN_N} scored samples`;
    } else if (args.clusterFloor === null) {
      reason = 'policy has no quality floor — floor qualification undefined';
    } else if (lower < args.clusterFloor) {
      reason = `quality lower bound ${lower.toFixed(3)} below the ${args.clusterFloor.toFixed(2)} floor`;
    } else if (servingMeasuredCostPer1K === null) {
      reason = 'no measured serving cost in the window to compare against';
    } else if (costPer1K >= servingMeasuredCostPer1K) {
      reason = `not cheaper: $${costPer1K.toFixed(4)}/1K vs serving's measured $${servingMeasuredCostPer1K.toFixed(4)}/1K`;
    } else {
      qualifies = true;
      reason =
        `lower bound ${lower.toFixed(3)} ≥ ${args.clusterFloor.toFixed(2)} floor on ${obs.n} of your requests · ` +
        `measured $${costPer1K.toFixed(4)} vs $${servingMeasuredCostPer1K.toFixed(4)} /1K`;
    }
    return {
      strategyHash: hash,
      model: samples[0]!.candidateModel,
      samples: samples.length,
      costPer1K,
      latencyP95,
      qualifies,
      reason,
      ...obs,
    };
  });
  // Qualified first, then cheapest — the order a reader should meet them in.
  challengers.sort(
    (a, b) => Number(b.qualifies) - Number(a.qualifies) || a.costPer1K - b.costPer1K || a.strategyHash.localeCompare(b.strategyHash),
  );

  return {
    instrument: 'serve-judge',
    windowDays: SHADOW_EVIDENCE_WINDOW_DAYS,
    servingObserved: observed(primaryScores),
    servingMeasuredCostPer1K,
    challengers,
  };
}
