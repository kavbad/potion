// THE SELECTION CONTEXT (pre-commit review, findings 1/2/3/8/9): serving
// does not select over "the latest platform frontier's raw points" — it
// selects over the ORG-PREFERRED frontier, with SERVING-MEASURED p95
// substituted into points for compound policies (G2.6, n≥30 in the 60-min
// org+cluster window), and an active guarantee ROLLBACK replaces the
// operating point entirely. A dial that evaluates in any other context is
// a parallel computation wearing the authority's clothes. This module
// reproduces serving's context with serving's OWN primitives:
// getServingFrontier (via loadCurrentFrontier orgId), core resolveLatency,
// db servingLatencyP95, db latestActiveRollback.
import {
  resolveLatency,
  SERVING_LATENCY_MIN_SAMPLES,
  type Frontier,
  type FrontierPoint,
  type LatencyEvidence,
} from '@potion/core';
import { getServingFrontier, latestActiveRollback, servingLatencyP95, type PotionDb } from '@potion/db';
import type { DialGap } from './gaps.js';

/** Mirrors apps/server/src/latency-policy.ts:44 (not importable from Lab
 * code); a drift here is a review item, not a silent constant. */
export const SERVING_LATENCY_WINDOW_MIN = 60;

export interface DialSelectionContext {
  orgId: string;
  clusterId: string;
  /** Serving's frontier read: org-preferred, platform fallback. */
  frontier: Frontier;
  /** Frontier points with serving-measured p95 substituted exactly as
   * serving substitutes them before selection. */
  boundPoints: FrontierPoint[];
  /** 'harness' when no point resolved to serving evidence (fresh org),
   * 'serving-measured' when every point did, 'mixed' otherwise. */
  latencyBasis: 'harness' | 'serving-measured' | 'mixed';
  /** Per-strategy: which latency number was used and why (core's own
   * evidence record — surfaced, never re-derived). */
  latencyEvidence: Record<string, LatencyEvidence>;
}

export type LoadContextResult =
  | { ok: true; context: DialSelectionContext }
  | { ok: false; gap: DialGap };

export async function loadDialContext(
  db: PotionDb,
  opts: { orgId: string; clusterId: string; now?: Date },
): Promise<LoadContextResult> {
  const { orgId, clusterId } = opts;
  // Finding 3: an active rollback IS the operating point — serving swaps
  // it in after selection, so no dial position is honest while one holds.
  const rollback = await latestActiveRollback(db, orgId, clusterId);
  if (rollback !== null) {
    return {
      ok: false,
      gap: {
        code: 'rollback-active',
        clusterId,
        incidentId: rollback.id,
        question:
          `A guarantee rollback is active for '${clusterId}' — serving pins the rolled-back ` +
          `strategy regardless of policy, so dial positions cannot take effect until it resolves.`,
      },
    };
  }
  // Serving's frontier read: ORG-preferred (chat.ts loads with the org).
  const frontier = await getServingFrontier(db, clusterId, orgId);
  if (frontier === null || frontier.points.length === 0) {
    return {
      ok: false,
      gap: {
        code: 'frontier-missing',
        clusterId,
        question: `No frontier serves '${clusterId}' for this org — run the platform sweep for it.`,
      },
    };
  }
  // Serving's latency substitution, via the SAME core + db primitives.
  const rollup = await servingLatencyP95(db, orgId, clusterId, SERVING_LATENCY_WINDOW_MIN, opts.now);
  const resolved = resolveLatency(frontier.points, rollup, SERVING_LATENCY_WINDOW_MIN, SERVING_LATENCY_MIN_SAMPLES);
  const sources = Object.values(resolved.evidence).map((e) => e.source);
  const latencyBasis: DialSelectionContext['latencyBasis'] = resolved.allProvisional
    ? 'harness'
    : sources.every((s) => s === 'serving')
      ? 'serving-measured'
      : 'mixed';
  return {
    ok: true,
    context: {
      orgId,
      clusterId,
      frontier,
      boundPoints: resolved.points,
      latencyBasis,
      latencyEvidence: resolved.evidence,
    },
  };
}
