// Dial geometry — a 1-D control over a legitimately 3-axis
// (quality, cost, latency) Pareto space, defined honestly: the quality
// ladder is the primary axis (exact floats from frontier rows), the
// latency tolerance is the second knob (default never binds), and EVERY
// projection comes from core's selectPoint under the emitted policy —
// the one selection authority. viewOf() is the fence: it reads the
// SELECTED point and nothing else.
import { fastestQualityQualifyingPoint, selectPoint, type Frontier, type FrontierPoint, type Policy, qualityLowerBound } from '@potion/core';
import type { DialSelectionContext } from './context.js';
import type { DialGap } from './gaps.js';

/** Default tolerance = max eligible latency × this headroom (never binds
 * until the user tightens it). */
export const DEFAULT_TOLERANCE_HEADROOM = 1.5;

export interface DialDomain {
  slot: 'brain' | 'tools';
  clusterId: string;
  frontierId: string;
  frontierVersion: number;
  /** Distinct quality values, ascending, EXACT floats from frontier rows
   * (the Step 6 no-rounding discipline). */
  ladder: number[];
  defaultToleranceMs: number;
  /** True when the partition restricted the domain to single-model points
   * — applied BEFORE ladder construction, so no position can map to a
   * composite: unrepresentable through motion. */
  singleOnly: boolean;
  /** Which latency numbers the selection context resolved to — surfaced
   * on every view so a serving-measured flip is visible, never silent. */
  latencyBasis: 'harness' | 'serving-measured' | 'mixed';
  eligible: FrontierPoint[];
  /** The UNFILTERED frontier points — serving selects over these
   * (X-Potion-Policy applies the policy to the whole frontier), so
   * single-only views must verify serve-agreement against them. */
  fullPoints: FrontierPoint[];
}

export interface DialPosition {
  qualityIndex: number;
  toleranceMs?: number;
}

export type DialView =
  | {
      feasible: true;
      position: DialPosition;
      policy: Policy;
      /** Everything below reads from the selectPoint RESULT — never from a
       * parallel computation over the eligible set. */
      strategyHash: string;
      strategyType: string;
      quality: number;
      costPer1K: number;
      latencyP95: number;
      providerMode: 'live';
      suiteContentHash?: string;
      frontierId: string;
      frontierVersion: number;
      latencyBasis: 'harness' | 'serving-measured' | 'mixed';
    }
  | {
      feasible: false;
      position: DialPosition;
      policy: Policy;
      gap: Extract<DialGap, { code: 'position-infeasible' | 'serve-partition-divergence' }>;
    };

export interface BuildDomainOptions {
  frontier: Frontier | null;
  clusterId: string;
  slot: 'brain' | 'tools';
  /** superpowers.length > 0. Today the loop attaches tools to EVERY call of
   * a tool-bearing harness (loop.ts:241), so BOTH slots sweep singles only
   * when tool-bearing — the recorded toolPolicy deviation-in-advance. */
  toolBearing: boolean;
  /** From the selection context; defaults to 'harness' for context-free
   * (pure fixture) callers. */
  latencyBasis?: 'harness' | 'serving-measured' | 'mixed';
}

/** The production path: a domain built from serving's ACTUAL selection
 * context — org-preferred frontier, serving-substituted latencies (review
 * findings 1/2/8/9). Pure-fixture callers may still hand-build frontiers
 * through buildDialDomain directly. */
export function domainFromContext(
  context: DialSelectionContext,
  opts: { slot: 'brain' | 'tools'; toolBearing: boolean },
): { ok: true; domain: DialDomain } | { ok: false; gap: DialGap } {
  return buildDialDomain({
    frontier: { ...context.frontier, points: context.boundPoints } as Frontier,
    clusterId: context.clusterId,
    slot: opts.slot,
    toolBearing: opts.toolBearing,
    latencyBasis: context.latencyBasis,
  });
}

export function buildDialDomain(
  opts: BuildDomainOptions,
): { ok: true; domain: DialDomain } | { ok: false; gap: DialGap } {
  const { frontier, clusterId, slot, toolBearing } = opts;
  if (frontier === null || frontier.points.length === 0) {
    return {
      ok: false,
      gap: {
        code: 'frontier-missing',
        clusterId,
        question: `No platform frontier exists for '${clusterId}' — run the platform sweep for it.`,
      },
    };
  }
  if (frontier.points.some((p) => p.providerMode !== 'live')) {
    return {
      ok: false,
      gap: {
        code: 'frontier-not-live',
        clusterId,
        frontierId: frontier.id,
        question: `The '${clusterId}' frontier carries non-live (SIMULATED) evidence — the dial only sweeps paid, live-evidenced points. Re-sweep the cluster.`,
      },
    };
  }
  const singleOnly = toolBearing;
  const eligible = singleOnly
    ? frontier.points.filter((p) => p.strategyConfig.type === 'single')
    : frontier.points;
  if (eligible.length === 0) {
    return {
      ok: false,
      gap: {
        code: 'no-single-points',
        clusterId,
        frontierId: frontier.id,
        question: `This harness uses tools, but the '${clusterId}' frontier has no single-model points — tool-bearing slots cannot draw composites.`,
      },
    };
  }
  // 2026-09-01 (CI lower-bound campaign): rungs are the bars this frontier
  // can PROVE — each point's interval lower bound, not its mean. A floor
  // emitted from a rung is then always satisfiable by that rung's point
  // under the selector's lower-bound feasibility (a mean-rung floor would
  // exclude its own point the moment the point carries an interval).
  const ladder = [...new Set(eligible.map((p) => qualityLowerBound(p)))].sort((a, b) => a - b);
  const maxLatency = Math.max(...eligible.map((p) => p.latencyP95));
  return {
    ok: true,
    domain: {
      slot,
      clusterId,
      frontierId: frontier.id,
      frontierVersion: frontier.version,
      ladder,
      defaultToleranceMs: Math.max(Math.ceil(maxLatency * DEFAULT_TOLERANCE_HEADROOM), 1),
      singleOnly,
      latencyBasis: opts.latencyBasis ?? 'harness',
      eligible,
      fullPoints: frontier.points,
    },
  };
}

/** Position → the emitted compound policy. The exact-float floor and the
 * tolerance bound are the ONLY inputs serving needs to reproduce the
 * choice through its own selector. */
export function positionPolicy(domain: DialDomain, position: DialPosition): Policy {
  const floor = domain.ladder[position.qualityIndex];
  if (floor === undefined) {
    throw new RangeError(`qualityIndex ${position.qualityIndex} outside ladder [0, ${domain.ladder.length - 1}]`);
  }
  return {
    type: 'compound',
    qualityFloor: floor,
    p95Ms: position.toleranceMs ?? domain.defaultToleranceMs,
  };
}

/** THE ONE-AUTHORITY FENCE: a view is a projection of the selected point,
 * and this helper takes ONLY the selected point (plus position/policy
 * identity). No other function constructs feasible views. */
function viewOf(
  selected: FrontierPoint,
  position: DialPosition,
  policy: Policy,
  domain: DialDomain,
): DialView {
  return {
    feasible: true,
    position,
    policy,
    strategyHash: selected.strategyHash,
    strategyType: selected.strategyConfig.type,
    quality: selected.quality,
    costPer1K: selected.costPer1K,
    latencyP95: selected.latencyP95,
    providerMode: 'live',
    ...(selected.evidence?.suiteContentHash !== undefined
      ? { suiteContentHash: selected.evidence.suiteContentHash }
      : {}),
    frontierId: domain.frontierId,
    frontierVersion: domain.frontierVersion,
    latencyBasis: domain.latencyBasis,
  };
}

function pseudoFrontier(domain: DialDomain, points: FrontierPoint[]): Frontier {
  return {
    id: domain.frontierId,
    clusterId: domain.clusterId,
    version: domain.frontierVersion,
    parentId: null,
    trigger: 'recompute',
    points,
    pricesVersion: '',
    createdAt: '',
  } as unknown as Frontier;
}

export function viewPosition(domain: DialDomain, position: DialPosition): DialView {
  const policy = positionPolicy(domain, position);
  const selected = selectPoint(policy, pseudoFrontier(domain, domain.eligible));
  if (selected !== null) {
    // SERVE-AGREEMENT for single-only domains (build finding): serving
    // applies this policy to the FULL frontier and 400s tools+composite
    // POST-selection, so a position a composite would capture at serve
    // time is refused HERE — the 400 stays unreachable from Lab paths.
    if (domain.singleOnly) {
      const serveSelected = selectPoint(policy, pseudoFrontier(domain, domain.fullPoints));
      if (serveSelected !== null && serveSelected.strategyHash !== selected.strategyHash) {
        return {
          feasible: false,
          position,
          policy,
          gap: {
            code: 'serve-partition-divergence',
            qualityIndex: position.qualityIndex,
            toleranceMs: position.toleranceMs ?? domain.defaultToleranceMs,
            capturedBy: serveSelected.strategyHash,
            question:
              `At this position a composite strategy would capture serving's selection ` +
              `(tools cannot ride composites) — pick a different position, tighten the ` +
              `latency tolerance, or drop the tools.`,
          },
        };
      }
    }
    return viewOf(selected, position, policy, domain);
  }
  // Infeasible under the emitted policy — but serving NEVER refuses a
  // compound policy (review finding): it serves the fastest
  // quality-qualifying point over the FULL frontier with latency_violated,
  // or the highest-quality NULL fallback. The dial states what serving
  // would actually do; for single-only domains a composite landing there
  // is the same partition divergence as the feasible case.
  const floor = domain.ladder[position.qualityIndex]!;
  const qualifying = domain.eligible.filter((p) => qualityLowerBound(p) >= floor);
  const relaxHintMs = Math.min(...qualifying.map((p) => p.latencyP95));
  const fallback =
    fastestQualityQualifyingPoint(domain.fullPoints, floor) ??
    [...domain.fullPoints].sort((a, b) => b.quality - a.quality || a.costPer1K - b.costPer1K)[0] ??
    null;
  const fallbackMode: 'latency-violated' | 'null-fallback' =
    fastestQualityQualifyingPoint(domain.fullPoints, floor) !== null ? 'latency-violated' : 'null-fallback';
  if (domain.singleOnly && fallback !== null && fallback.strategyConfig.type !== 'single') {
    return {
      feasible: false,
      position,
      policy,
      gap: {
        code: 'serve-partition-divergence',
        qualityIndex: position.qualityIndex,
        toleranceMs: position.toleranceMs ?? domain.defaultToleranceMs,
        capturedBy: fallback.strategyHash,
        question:
          `This position is latency-infeasible and serving's fallback would land on a ` +
          `composite (tools cannot ride composites) — relax the tolerance or pick a ` +
          `different position.`,
      },
    };
  }
  return {
    feasible: false,
    position,
    policy,
    gap: {
      code: 'position-infeasible',
      qualityIndex: position.qualityIndex,
      toleranceMs: position.toleranceMs ?? domain.defaultToleranceMs,
      relaxHintMs,
      serveWouldServe:
        fallback !== null ? { strategyHash: fallback.strategyHash, mode: fallbackMode } : null,
    },
  };
}

/** The full sweep: one view per ladder rung at the given tolerance. */
export function dialViews(domain: DialDomain, toleranceMs?: number): DialView[] {
  return domain.ladder.map((_, k) =>
    viewPosition(domain, { qualityIndex: k, ...(toleranceMs !== undefined ? { toleranceMs } : {}) }),
  );
}
