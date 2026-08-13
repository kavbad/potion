// Autopilot slot-filling from LIVE platform frontiers, provenance per
// choice. The single-strategy partition is enforced BY CONSTRUCTION here:
// tool-bearing missions filter candidates to single-model points BEFORE
// selection, so a Lab spec pairing tools with a composite is
// unrepresentable as an output, not merely rejected downstream.
import { selectPoint, type Frontier, type FrontierPoint, type Policy } from '@potion/core';
import { P95_HEADROOM } from './constants.js';
import type { TaxonomyCluster } from './interview.js';

export type GenerationGap =
  | { code: 'cluster-uncertain'; candidates: string[]; question: string }
  | { code: 'frontier-missing'; clusterId: string; question: string }
  | { code: 'frontier-not-live'; clusterId: string; frontierId: string; question: string }
  | { code: 'no-single-points'; clusterId: string; frontierId: string; question: string };

export interface AutopilotChoice {
  /** 'brain.toolPolicy' added in Step 7 (additive): dial moves on the tool
   * slot record choices in the same provenance vocabulary. */
  slot: 'brain.policy' | 'brain.toolPolicy';
  decision: Policy;
  basis: {
    clusterId: string;
    frontierId: string;
    frontierVersion: number;
    strategyHash: string;
    providerMode: 'live';
    suiteContentHash?: string;
  };
  partition: 'single-only' | 'full';
  alternatives: number;
}

export class AutopilotInvariantError extends Error {
  constructor(detail: string) {
    super(`autopilot invariant violated (a bug, not a gap): ${detail}`);
    this.name = 'AutopilotInvariantError';
  }
}

/**
 * The quality knee — the candidate with the greatest quality-per-cost
 * marginal gain over its cheaper neighbor (the cheapest point's gain is
 * measured from the origin). Ties → higher quality, then lower cost, then
 * strategyHash asc: the choice is total and reproducible.
 */
export function kneePoint(candidates: FrontierPoint[]): FrontierPoint {
  if (candidates.length === 0) throw new AutopilotInvariantError('kneePoint on empty candidate set');
  const sorted = [...candidates].sort(
    (a, b) => a.costPer1K - b.costPer1K || a.quality - b.quality || (a.strategyHash < b.strategyHash ? -1 : 1),
  );
  let best = sorted[0]!;
  let bestGain = best.quality / Math.max(best.costPer1K, 1e-9);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    const dc = Math.max(cur.costPer1K - prev.costPer1K, 1e-9);
    const gain = (cur.quality - prev.quality) / dc;
    if (
      gain > bestGain ||
      (gain === bestGain &&
        (cur.quality > best.quality ||
          (cur.quality === best.quality &&
            (cur.costPer1K < best.costPer1K ||
              (cur.costPer1K === best.costPer1K && cur.strategyHash < best.strategyHash)))))
    ) {
      best = cur;
      bestGain = gain;
    }
  }
  return best;
}

export interface FillOptions {
  clusterId: TaxonomyCluster;
  frontier: Frontier | null;
  toolBearing: boolean;
}

/**
 * Fill the brain slot from the cluster's latest platform frontier.
 * The emitted compound policy uses the knee's EXACT quality as the floor
 * (no rounding — a rounded-down floor could admit a cheaper lower-quality
 * point and silently re-select it at serve time) and its p95 × headroom as
 * the bound, so core's own `selectPoint` reproduces the same point at
 * serve time. That reproduction is asserted here — a mismatch is a bug,
 * never a quietly different choice.
 */
export function fillBrainSlot(opts: FillOptions): { ok: true; policy: Policy; choice: AutopilotChoice } | { ok: false; gap: GenerationGap } {
  const { clusterId, frontier, toolBearing } = opts;
  if (frontier === null || frontier.points.length === 0) {
    return {
      ok: false,
      gap: {
        code: 'frontier-missing',
        clusterId,
        question: `No platform frontier exists for '${clusterId}' yet — run the platform sweep for it, or pick a different cluster.`,
      },
    };
  }
  const notLive = frontier.points.find((p) => p.providerMode !== 'live');
  if (notLive !== undefined) {
    return {
      ok: false,
      gap: {
        code: 'frontier-not-live',
        clusterId,
        frontierId: frontier.id,
        question: `The '${clusterId}' frontier carries non-live (SIMULATED) evidence — autopilot only builds on paid, live-evidenced points. Re-sweep the cluster.`,
      },
    };
  }
  const candidates = toolBearing
    ? frontier.points.filter((p) => p.strategyConfig.type === 'single')
    : frontier.points;
  if (candidates.length === 0) {
    return {
      ok: false,
      gap: {
        code: 'no-single-points',
        clusterId,
        frontierId: frontier.id,
        question: `This mission uses tools, but the '${clusterId}' frontier has no single-model points — tool-bearing slots cannot draw composites.`,
      },
    };
  }
  const knee = kneePoint(candidates);
  const policy: Policy = {
    type: 'compound',
    qualityFloor: knee.quality,
    p95Ms: Math.max(Math.ceil(knee.latencyP95 * P95_HEADROOM), 1),
  };
  // THE POLICY IS THE AUTHORITY (pre-commit review finding): on a 3-axis
  // Pareto frontier a cheaper equal-quality point can be feasible under the
  // knee-derived policy, and serving's min-cost comparator will pick IT —
  // so the recorded choice is what selectPoint actually selects, never the
  // knee heuristic's proposal. The knee only shapes the policy. The old
  // assert-they-match version threw AutopilotInvariantError on legitimate
  // frontiers, making whole clusters ungenerable.
  const selected = selectPoint(policy, { ...frontier, points: candidates });
  if (selected === null) {
    // Impossible by construction: the knee itself satisfies its own floor
    // (equality) and bound (headroom ≥ 1) — a null here is a real bug.
    throw new AutopilotInvariantError(`knee ${knee.strategyHash} infeasible under its own policy`);
  }
  return {
    ok: true,
    policy,
    choice: {
      slot: 'brain.policy',
      decision: policy,
      basis: {
        clusterId,
        frontierId: frontier.id,
        frontierVersion: frontier.version,
        strategyHash: selected.strategyHash,
        providerMode: 'live',
        ...(selected.evidence?.suiteContentHash !== undefined
          ? { suiteContentHash: selected.evidence.suiteContentHash }
          : {}),
      },
      partition: toolBearing ? 'single-only' : 'full',
      alternatives: candidates.length,
    },
  };
}
