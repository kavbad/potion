// Serving-grade latency resolution (G2.6, owner requirement 1: "latency
// evidence must be serving-grade, not harness-grade").
//
// THE PROBLEM this module exists to make honest. A frontier point's
// `latencyP95` is HARNESS-grade: runEval records one latency per eval ITEM
// (strategy-only, scorer excluded), and aggregate.ts takes a nearest-rank p95
// ACROSS ITEMS. That is a spread over different prompts, not a distribution of
// one call under load. It is also a different SPAN from what an SLO
// experiences: request_logs.latency_ms is end-to-end server handling time, so
// the harness number is an OPTIMISTIC LOWER BOUND on the customer's p95.
//
// So: bind against the serving distribution where one exists, and where it
// does not, keep the harness number but say plainly that it is provisional.
// A policy that silently binds a benchmark number to a customer's stated SLO
// is the kind of quiet substitution this platform exists to detect.
import type { FrontierPoint } from './types.js';

/**
 * Minimum served requests before a serving p95 is trusted enough to REPLACE
 * the harness value.
 *
 * 30 for two reasons that agree: a nearest-rank p95 below roughly 20 samples
 * IS the sample maximum (rank = ceil(0.95·n) = n), so it carries no tail
 * information at all; and 30 is already the platform's low/medium confidence
 * line (confidenceFor). Below this the serving number is noisier than the
 * benchmark it would replace.
 */
export const SERVING_LATENCY_MIN_SAMPLES = 30;

/** Which clock the number came off. The two sources measure DIFFERENT spans;
 * every surface that shows a latency says which one it is showing. */
export type LatencySpan = 'end-to-end' | 'strategy-only';

export interface LatencyEvidence {
  source: 'serving' | 'harness';
  p95Ms: number;
  /** Sample count behind p95Ms (serving requests, or harness eval items). */
  n: number;
  /**
   * True when the number is NOT serving-grade — either no serving rollup
   * exists yet, or it has fewer than SERVING_LATENCY_MIN_SAMPLES samples, or
   * the rollup query failed. A provisional selection is still served (a
   * rollup failure must never break serving), but it is labeled everywhere.
   */
  provisional: boolean;
  /** Rollup window in minutes; absent for harness evidence. */
  windowMin?: number;
  span: LatencySpan;
}

/** A serving-latency rollup for one strategy, as read from request_logs. */
export interface ServingLatencySample {
  strategyHash: string;
  p95Ms: number;
  n: number;
}

export interface ResolvedLatency {
  /** The points with serving-grade p95 substituted where available. */
  points: FrontierPoint[];
  /** Per strategyHash: which number was used and why. */
  evidence: Record<string, LatencyEvidence>;
  /** True when NO point resolved to serving-grade evidence. */
  allProvisional: boolean;
}

/**
 * Substitute serving-grade p95 into frontier points where the evidence is
 * strong enough, and report per-point what was used.
 *
 * PURE, and it never mutates its input: the frontier is cached and shared
 * across requests, so a mutation here would poison every subsequent selection
 * on the replica. Shallow copies only.
 */
export function resolveLatency(
  points: FrontierPoint[],
  serving: ServingLatencySample[],
  windowMin: number,
  minSamples: number = SERVING_LATENCY_MIN_SAMPLES,
): ResolvedLatency {
  const byHash = new Map(serving.map((s) => [s.strategyHash, s]));
  const evidence: Record<string, LatencyEvidence> = {};
  const resolved = points.map((p) => {
    const s = byHash.get(p.strategyHash);
    if (s !== undefined && s.n >= minSamples) {
      evidence[p.strategyHash] = {
        source: 'serving',
        p95Ms: s.p95Ms,
        n: s.n,
        provisional: false,
        windowMin,
        span: 'end-to-end',
      };
      return { ...p, latencyP95: s.p95Ms };
    }
    evidence[p.strategyHash] = {
      source: 'harness',
      p95Ms: p.latencyP95,
      // Harness n comes from the point's own provenance when it has any.
      n: p.evidence?.latencyN ?? p.evidence?.n ?? 0,
      provisional: true,
      span: 'strategy-only',
    };
    return p;
  });
  return {
    points: resolved,
    evidence,
    allProvisional: Object.values(evidence).every((e) => e.provisional),
  };
}

/**
 * Epsilon band for near-tie handling in every selection/relaxation
 * comparison. G2.6 moved the constant here from pareto/dominance.ts (which
 * re-exports it as DOMINANCE_EPSILON, verbatim) so the frontier's notion of
 * "these coordinates are equal" and the premium's notion of "this relaxation
 * target is actually reachable" cannot drift apart. Without it, float noise in
 * an aggregated p95 can produce a relaxTo value that does not admit the point
 * it was derived from.
 */
export const SELECTION_EPSILON = 1e-9;
