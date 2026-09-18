// THE SERVING DECISION — one implementation (2026-08-31, external core-API
// review P0 "make learning use the exact production route resolver").
//
// Before this module, the serve path's chain — policyForCluster →
// loadCurrentFrontier → guardFrontierProvenance → bindServingLatency →
// resolveOperatingPoint(fallbackStrategyFor) — lived in apps/server, which
// packages/workers cannot import. The learning period reimplemented it as
// "top-level qualityFloor-or-0.95 → cheapest point above", which ignored
// cluster floors (including the very floors its own proposals write),
// mishandled max_quality and latency policies, skipped the provenance
// guard, and INVERTED the infeasible fallback (cheapest, where production
// serves highest-quality). The route it measured could be the opposite end
// of the frontier from the route production serves.
//
// Now the chain lives here, and apps/server re-exports it (routes/chat.ts,
// latency-policy.ts, routing/floors.ts, context.ts keep their public
// surface as shims). servingDecisionFor() is the authoritative answer to:
// given org + kind of work + bound policy, what would Potion serve right
// now? Callers: the router compiler (assignmentsUnderPolicy), the learning
// period, and — function by function — the serve path itself.
import {
  fastestQualityQualifyingPoint,
  highestQualityPoint,
  latencyPremium,
  resolveLatency,
  selectPoint,
  type SelectionContext,
  strategyHash,
  type Frontier,
  type LatencyEvidence,
  type LatencyPremium,
  type Policy,
  type PriceTable,
  type ProviderMode,
  type ServingLatencySample,
  type StrategyConfig,
  qualityLowerBound, qualityUpperBound,
  type FrontierPoint,
} from '@potion/core';
import { listServedClusterIds, servingDegenerateCounts, servingDegenerateCountsPlatform, servingLatencyP95, type PotionDb } from '@potion/db';
import { strategyCapabilities } from '@potion/strategies';
import { loadCurrentFrontier } from './persistence.js';

// ---------------------------------------------------------------------------
// Defaults and fallbacks (moved from apps/server context.ts / default-policy.ts)
// ---------------------------------------------------------------------------

/** THE one starting rule (2026-08-28, operator: "why did it choose 74.5%
 * quality... that is kind of low no?"). One constant, used by the first-run
 * reveal, the key mint, and the learning period, so no surface can drift:
 * quality-first, cheapest point that clears the bar. */
export const DEFAULT_ORG_POLICY: Policy = { type: 'min_cost', qualityFloor: 0.95 };

// ---------------------------------------------------------------------------
// THE SIGNUP FLOOR (2026-09-18). DEFAULT_ORG_POLICY's 0.95 was a bar no
// measured kind of work could prove: on the sized head-to-head 44% of
// requests under it hit `policy_infeasible`, and the unreachable-floor rule
// served summarization on $10/1K models at 9x the auto-router's cost for
// LOWER quality. A signup should start on the highest bar EVERY kind of work
// can honour today — the minimum over the served clusters of the highest
// provable quality (max lower bound), floored to 2dp, capped by the constant
// above. The learning period still replaces it with the customer's own
// measured bar (applyDerivedDefault); this only changes what the first week
// looks like.
// ---------------------------------------------------------------------------

/** A cluster proving less than this does not drag every other kind of work
 * down with it: that is a coverage gap to fix by measurement, and the cluster
 * runs infeasible (fallback=1, alerted) until it is. */
export const SIGNUP_FLOOR_MIN = 0.75;

export interface SignupFloor {
  floor: number;
  ceiling: number;
  /** The kind of work that set the floor, when one did (null = the ceiling held). */
  limiting: { clusterId: string; highestProvable: number } | null;
  /** Clusters below SIGNUP_FLOOR_MIN, excluded from the minimum. */
  excluded: { clusterId: string; highestProvable: number }[];
  clusters: number;
}

export async function signupQualityFloor(db: PotionDb, orgId: string): Promise<SignupFloor> {
  const ceiling = DEFAULT_ORG_POLICY.type === 'min_cost' ? DEFAULT_ORG_POLICY.qualityFloor : 0.95;
  let floor = ceiling;
  let limiting: SignupFloor['limiting'] = null;
  const excluded: SignupFloor['excluded'] = [];
  let clusters = 0;
  for (const clusterId of await listServedClusterIds(db)) {
    const frontier = await loadCurrentFrontier(db, clusterId, orgId);
    if (!frontier || frontier.points.length === 0) continue;
    clusters++;
    let highest = -1;
    for (const p of frontier.points) highest = Math.max(highest, qualityLowerBound(p));
    // FLOOR to 2dp, never round up (routing/floors.ts mintFloor semantics).
    const minted = Math.floor(highest * 100) / 100;
    if (minted < SIGNUP_FLOOR_MIN) { excluded.push({ clusterId, highestProvable: highest }); continue; }
    if (minted < floor) { floor = minted; limiting = { clusterId, highestProvable: highest }; }
  }
  return { floor, ceiling, limiting, excluded, clusters };
}

/** The rule a fresh org is bound to: min_cost at the signup floor. */
export async function signupPolicyFor(db: PotionDb, orgId: string): Promise<Policy> {
  const { floor } = await signupQualityFloor(db, orgId);
  return { type: 'min_cost', qualityFloor: floor };
}

/** TRUE for a 'default' row nobody chose: the mint's shape (min_cost, no
 * per-kind floors) at the signup floor of its day — today's derived value
 * or the retired 0.95 constant. An edited floor, a per-kind floor, or any
 * other name is a choice, and choices are never replaced. */
export function isUnchosenSignupPolicy(name: string, config: Policy, signupFloor: number): boolean {
  if (name !== 'default' || config.type !== 'min_cost') return false;
  if (config.clusterFloors !== undefined && Object.keys(config.clusterFloors).length > 0) return false;
  const legacy = DEFAULT_ORG_POLICY.type === 'min_cost' ? DEFAULT_ORG_POLICY.qualityFloor : 0.95;
  return config.qualityFloor === signupFloor || config.qualityFloor === legacy;
}

/** Strategy used when the assigned cluster has NO frontier yet (e.g.
 * 'general') on a MOCK server: a plain mid-tier single. Documented
 * fallback; requests served this way carry `fallback=1` and `frontier=v0`
 * in the trace header. */
export const DEFAULT_STRATEGY: StrategyConfig = { type: 'single', model: 'mock-mid' };

/**
 * G2.4 (FIFTH false-live instance — the first on the SERVING path): under a
 * LIVE server the last-resort fallback must be a REAL strategy, never the
 * mock-alias DEFAULT_STRATEGY. Pre-G2.4, a live deployment with an absent
 * or provenance-blocked frontier executed `mock-mid`, which resolves to the
 * mock transport that createProviders always carries — mock text returned
 * as a live 200.
 *
 * Owner decision: preserve FAIL-OPEN serving by designating a live default
 * (the mid-class representative with mock excluded — the G1.5
 * excludeProvider convention), and refuse honestly ONLY when no live
 * strategy is resolvable at all. Returns null when the price table has no
 * non-mock entry; callers turn that into an explicit refusal.
 */
export function liveDefaultStrategy(prices: PriceTable): StrategyConfig | null {
  // Mid-class band mirrors @potion/researcher's classifyModel (inputPer1M
  // <= 3 and > 0.5); the tie-break — cheapest, then alias — is the
  // classRepresentative rule. Resolved here rather than importing the
  // researcher package so the serving path keeps its dependency surface.
  const live = prices.entries.filter((e) => e.provider !== 'mock');
  const byPrice = [...live].sort(
    (a, b) => a.inputPer1M - b.inputPer1M || a.alias.localeCompare(b.alias),
  );
  const mid = byPrice.find((e) => e.inputPer1M > 0.5 && e.inputPer1M <= 3);
  return (mid ?? byPrice[0]) ? { type: 'single', model: (mid ?? byPrice[0])!.alias } : null;
}

/** The fallback strategy for a server in `mode`: the mock default under
 * mock, the designated live default under live (null = refuse). */
export function fallbackStrategyFor(
  mode: ProviderMode,
  prices: PriceTable,
): StrategyConfig | null {
  return mode === 'live' ? liveDefaultStrategy(prices) : DEFAULT_STRATEGY;
}

// ---------------------------------------------------------------------------
// Per-cluster floors (moved from apps/server routing/floors.ts)
// ---------------------------------------------------------------------------

/** The policy as it applies to one cluster: its own floor substituted in. */
export function policyForCluster(policy: Policy, clusterId: string): Policy {
  if (policy.type !== 'min_cost' && policy.type !== 'compound') return policy;
  const own = policy.clusterFloors?.[clusterId];
  if (typeof own !== 'number' || own === policy.qualityFloor) return policy;
  return { ...policy, qualityFloor: own };
}

// ---------------------------------------------------------------------------
// Operating-point resolution (moved from apps/server routes/chat.ts)
// ---------------------------------------------------------------------------

export interface OperatingPoint {
  /** Why the fallback fired (2026-08-24, beta feedback): 'policy_infeasible'
   * = no measured point met the policy (e.g. the quality floor); the best
   * point served. Absent when fallback is 0. */
  /** 'reasoning_budget' (2026-09-06): every point the policy admits is a
   *  reasoning model under an output budget too small for one to emit
   *  anything, so the platform fallback served instead. Distinct from
   *  policy_infeasible — the policy was satisfiable, the BUDGET was not. */
  fallbackReason?: 'no_frontier' | 'no_point_resolvable' | 'policy_infeasible' | 'reasoning_budget';
  /** null = no strategy is resolvable for this server's mode (live server,
   * no non-mock price entry) — the caller REFUSES rather than serving mock
   * output on a live path (G2.4). */
  config: StrategyConfig | null;
  /** 1 when the policy was infeasible (or no frontier exists) and the
   * documented fallback fired. */
  fallback: 0 | 1;
  frontierVersion: number;
  frontier: Frontier | null;
  /**
   * G2.6 — set ONLY in the compound-policy latency-infeasible case: points
   * cleared the quality floor but none cleared the latency bound, so the
   * FASTEST quality-qualifying point was served and the SLO was knowingly
   * missed. Owner's rule: violate the customer-observable dimension
   * (latency), never the customer-invisible one (quality) — detecting quality
   * degradation is the product itself. Never silent: it rides the trace, the
   * DTO, the playground response, and a standing policy condition.
   */
  latencyViolation?: LatencyViolation;
  /**
   * Set ONLY when a request carried `tools` and the policy's optimum was a
   * prompt-transforming strategy, so selection was narrowed to single-model
   * points. Same discipline as latencyViolation: the substitution is real, so
   * it is labelled rather than hidden.
   *
   * Note what is and is not given up. Restricting to single points can never
   * BREACH a policy's stated bound — a quality floor still holds, a cost
   * ceiling still holds, a latency bound still holds, because the restricted
   * set is a subset of the qualifying set. It costs optimality only. That is
   * why `fallback` stays 0 when a single point still satisfies the policy:
   * the request genuinely was routed on measured evidence.
   */
  toolConstraint?: ToolConstraint;
}

/** The labelled consequence of tools forcing a single-model point. */
export interface ToolConstraint {
  /** The strategy type the policy would have selected without tools. */
  wouldHaveServedType: string;
  /** Its hash, so the substitution is auditable against the frontier. */
  wouldHaveServedHash: string;
}

/** The labeled consequence of an unmeetable latency bound (G2.6). */
export interface LatencyViolation {
  boundMs: number;
  qualityFloor: number;
  /** The p95 actually served — always > boundMs. */
  servedP95Ms: number;
  servedStrategyHash: string;
  /** Relax the bound to this and the policy is feasible on cost again. */
  relaxLatencyToMs: number | null;
  /** Or relax quality to this and the CURRENT bound is feasible. */
  relaxQualityToFloor: number | null;
}

/**
 * selectPoint(policy) with the §8 NULL fallback applied.
 *
 * G2.4: `fallbackStrategy` is the LAST-RESORT config for this server's
 * provider mode — DEFAULT_STRATEGY (mock-mid) under mock, the designated
 * live default under live (fallbackStrategyFor above). It is null
 * only when a live server's price table has no non-mock entry; callers turn
 * that into an honest refusal instead of serving mock text as a live 200
 * (the fifth false-live instance, first on the serving path).
 */
export function resolveOperatingPoint(
  policy: Policy,
  frontier: Frontier | null,
  fallbackStrategy: StrategyConfig | null = DEFAULT_STRATEGY,
  opts: { toolCapableOnly?: boolean; request?: SelectionContext } = {},
): OperatingPoint {
  // TOOL-CAPABLE NARROWING. A request carrying `tools` cannot be served by a
  // strategy that rewrites or fans out the prompt — cascade/ensemble/
  // draft-verify transform what the model sees, and tool-call semantics
  // cannot be guaranteed through that. This used to be a hard 400, which
  // meant a customer whose policy happened to select a cascade discovered it
  // in production and had no route through: the refusal named the problem and
  // offered only "choose a different policy".
  //
  // Instead: resolve normally, and if the optimum is not single, re-resolve
  // over the single-only subset and LABEL the substitution. 41 of the 44
  // points on the committed platform frontier are single, so this almost
  // always finds a measured answer, and both last-resort fallbacks
  // (DEFAULT_STRATEGY, liveDefaultStrategy) are single by construction.
  if (opts.toolCapableOnly) {
    const unrestricted = resolveOperatingPoint(policy, frontier, fallbackStrategy, { ...(opts.request ? { request: opts.request } : {}) });
    if (unrestricted.config === null) return unrestricted;
    if (unrestricted.config.type === 'single') return unrestricted;
    const unrestrictedPoint = frontier?.points.find((p) => p.strategyHash === strategyHash(unrestricted.config as StrategyConfig));
    if (strategyCapabilities(unrestricted.config).canServeTools && unrestrictedPoint?.evidence?.toolsMeasured === true) return unrestricted;
    // MIXING M3: a point may carry tools when its SHAPE can (strategyCapabilities)
    // and — for anything but a single model — it was MEASURED on items that
    // carried tools (evidence.toolsMeasured). Singles are trusted as before.
    const singles = frontier
      ? frontier.points.filter(
          (p) =>
            strategyCapabilities(p.strategyConfig).canServeTools &&
            (p.strategyConfig.type === 'single' || p.evidence?.toolsMeasured === true),
        )
      : [];
    const narrowed: Frontier | null =
      frontier && singles.length > 0 ? { ...frontier, points: singles } : null;
    const restricted = resolveOperatingPoint(policy, narrowed, fallbackStrategy, { ...(opts.request ? { request: opts.request } : {}) });
    return {
      ...restricted,
      // A narrowed frontier still reports its real version; only an absent
      // one falls to 0, which resolveOperatingPoint already handles.
      toolConstraint: {
        wouldHaveServedType: unrestricted.config.type,
        wouldHaveServedHash: strategyHash(unrestricted.config),
      },
    };
  }
  if (!frontier || frontier.points.length === 0) {
    return { config: fallbackStrategy, fallback: 1, fallbackReason: 'no_frontier', frontierVersion: 0, frontier };
  }
  // Request-aware cost when the caller supplied the request's size and the
  // frontier carries token profiles; the measured scalar otherwise. See
  // core/select.ts — a fixed prompt overhead is a different fraction of a
  // short request than of the suite item it was measured on.
  const selected = selectPoint(policy, frontier, opts.request);
  if (selected) {
    return {
      config: selected.strategyConfig,
      fallback: 0,
      frontierVersion: frontier.version,
      frontier,
    };
  }
  // G2.6 case (ii) — LATENCY-side infeasibility on a compound policy. Points
  // clear the quality floor; none clear the bound. Serving the highest-quality
  // point (the generic fallback below) would ignore the SLO entirely; refusing
  // would break serving. So: serve the FASTEST point that still meets the
  // quality floor, and label the violation everywhere. Quality is never traded
  // away to meet latency — that is the one substitution the customer cannot
  // detect for themselves.
  //
  // Case (i), quality-side infeasibility, falls through to the existing
  // highest-quality fallback: no latency SLO is violated by serving the best
  // quality available, and blaming the bound would send the customer to relax
  // the wrong knob.
  if (policy.type === 'compound') {
    const fastest = fastestQualityQualifyingPoint(frontier.points, policy.qualityFloor);
    if (fastest) {
      const premium = latencyPremium(policy, frontier.points);
      return {
        config: fastest.strategyConfig,
        fallback: 1,
        frontierVersion: frontier.version,
        frontier,
        latencyViolation: {
          boundMs: policy.p95Ms,
          qualityFloor: policy.qualityFloor,
          servedP95Ms: fastest.latencyP95,
          servedStrategyHash: fastest.strategyHash,
          relaxLatencyToMs: premium.relaxLatencyToMs,
          relaxQualityToFloor: premium.relaxQualityToFloor,
        },
      };
    }
  }
  const best = highestQualityPoint(frontier.points);
  if (!best) {
    return { config: fallbackStrategy, fallback: 1, fallbackReason: 'no_point_resolvable', frontierVersion: frontier.version, frontier };
  }
  const served = infeasibleFallbackPoint(frontier.points, best);
  return { config: served.strategyConfig, fallback: 1, fallbackReason: 'policy_infeasible', frontierVersion: frontier.version, frontier };
}

/**
 * QUALITY-INFEASIBLE FALLBACK: the cheapest point statistically tied with
 * the best (2026-09-11; two tightenings tried and reverted 2026-09-17 — see
 * the function body).
 *
 * When no point clears the bound floor, this used to serve the
 * highest-quality point outright. On a design partner's agentic-tool-use
 * frontier that was $44/1K (q 0.972) while a $0.14/1K point measured
 * q 0.950 — inside the best point's own confidence interval — sat beside
 * it: 300x the price for a difference the evidence cannot distinguish,
 * recorded as "$0 saved" because the served point was also the comparator.
 *
 * The rule: take the best point's quality LOWER bound as the bar, admit
 * every point whose quality UPPER bound reaches it (the evidence cannot
 * rank them below the best), and serve the cheapest of those. Points
 * without an interval collapse to their mean, so a CI-less frontier
 * behaves exactly as before (only equal-or-better quality qualifies).
 * Quality is not traded for cost here — nothing the evidence can call
 * worse than the best is admitted; only the spread the evidence cannot
 * resolve is.
 */
export function infeasibleFallbackPoint(points: readonly FrontierPoint[], best: FrontierPoint): FrontierPoint {
  // THE 2026-09-11 RULE, RESTORED (2026-09-17, #39 → #41 → #42). Two
  // tightenings were tried the same day and both lost on the head-to-head:
  //   (a) "cheapest point that MEASURED at the bar" — put rewrite-edit on
  //       claude-opus-5-fast ($29.93/1K) for 13/20 items; 1.33x → 8.95x.
  //   (b) "cheapest point whose MEAN reaches the best's lower bound" — is
  //       STRICTER than this rule when the best point's interval is tight:
  //       on rewrite-edit nothing cheaper than opus-fast reached its lower
  //       bound, so opus served again (6.79x); on extraction granite-micro's
  //       mean (0.904) was admitted anyway, so the quality gain (b) was
  //       meant to buy never came.
  // The upper-bound test below admitted the cheaper points the evidence
  // cannot distinguish from the best, and the morning run under it was the
  // best 0.95 result of the day (1.33x, quality 0.899). What that run got
  // wrong (granite-micro at 0.869 on extraction) is the FRONTIER's number
  // for granite (0.904 on the suite), not this rule — fix the measurement,
  // not the tie.
  const bar = qualityLowerBound(best);
  const tied = points.filter((p) => qualityUpperBound(p) >= bar);
  const cheapest = [...tied].sort((a, b) => a.costPer1K - b.costPer1K || b.quality - a.quality)[0];
  return cheapest ?? best;
}

/**
 * Serve-time provenance guard (ROADMAP M1a item 4): a simulated number may
 * never masquerade as live evidence.
 *
 * A frontier is TAINTED when any point's provider_mode is 'mock' or
 * 'unknown' (absent on the value object — pre-M1a rows). When the server
 * runs with live providers we REFUSE to serve from a tainted frontier: the
 * request falls back per the existing no-frontier rule (DEFAULT_STRATEGY,
 * frontier=v0, fallback=1) and the trace header carries provenance=blocked.
 * When running mock-only (dev), tainted frontiers serve with
 * provenance=mock. All-live frontiers always serve with provenance=live.
 */
export function guardFrontierProvenance(
  frontier: Frontier | null,
  serverMode: 'mock' | 'live',
  warn: (msg: string) => void = () => {},
): { frontier: Frontier | null; provenance: 'live' | 'mock' | 'blocked' } {
  if (!frontier || frontier.points.length === 0) {
    return { frontier, provenance: serverMode };
  }
  const tainted = frontier.points.some((p) => (p.providerMode ?? 'unknown') !== 'live');
  if (!tainted) return { frontier, provenance: 'live' };
  if (serverMode === 'live') {
    warn(
      `provenance guard: refusing to serve cluster '${frontier.clusterId}' from ` +
        `frontier v${frontier.version} — provider_mode mock/unknown under live providers ` +
        `(falling back to the no-frontier default)`,
    );
    return { frontier: null, provenance: 'blocked' };
  }
  return { frontier, provenance: 'mock' };
}

// ---------------------------------------------------------------------------
// Serving-grade latency binding (moved from apps/server latency-policy.ts)
// ---------------------------------------------------------------------------

/** Rollup window. An hour of traffic is long enough to accumulate the sample
 * minimum on a modest workload and short enough that a regression shows up
 * while it still matters. */
export const SERVING_LATENCY_WINDOW_MIN = 60;

/** Per-(org, cluster) rollup cache TTL. Matches the org provider-set cache
 * (context.ts ORG_PROVIDER_CACHE_TTL_MS): fresh enough that a latency
 * regression binds within a minute, cheap enough that a hot cluster does not
 * issue a quantile query per request. Per-replica by construction — a shared
 * cache is a G2.5 (Redis) seam, not a correctness gap: replicas converge
 * within the TTL. */
export const SERVING_LATENCY_CACHE_TTL_MS = 60_000;

interface CacheEntry {
  at: number;
  rows: ServingLatencySample[];
}

const latencyCache = new Map<string, CacheEntry>();

/** Test seam: drop the memo so a suite can observe a fresh rollup. */
export function clearServingLatencyCache(): void {
  latencyCache.clear();
  degeneracyCache.clear();
}

// ---------------------------------------------------------------------------
// Serving-measured DEGENERACY exclusion (2026-09-01, the or-gemini-flash
// incident). A route measured q=1.0 on its instrument suite returned six
// consecutive ZERO-TOKEN completions in production — no floor or policy can
// dodge a point whose suite number is perfect, so the org's own measured
// traffic must be able to overrule the suite at serve time, exactly the way
// serving-measured latency already substitutes (G2.6). A strategy with a
// recent burst of empty completions on this org+cluster is EXCLUDED from
// selection; fail-open when exclusion would empty the frontier (an outage
// is worse than a degraded route).
// ---------------------------------------------------------------------------

/** Minimum empty completions in the window before a strategy is excludable —
 * below this the evidence is noise, not a burst. */
export const DEGENERACY_MIN_EMPTY = 4;
/** Minimum share of the strategy's window servings that came back empty. */
export const DEGENERACY_MIN_RATIO = 0.5;
/** The exclusion's MEMORY — deliberately much longer than the latency
 * window. A 60-min memory produced a sawtooth live (2026-09-01): the burst
 * aged out, the broken route came back, broke the next customer run, and
 * re-tripped — one wrecked run per hour forever. While excluded a strategy
 * serves nothing, so no fresh rows dilute the ratio: exclusion holds for
 * the window, then the route gets ONE earned retry — still broken, one
 * burst re-excludes it; healed, good rows wash the ratio out. */
export const DEGENERACY_WINDOW_MIN = 7 * 24 * 60;

const degeneracyCache = new Map<string, { at: number; rows: Awaited<ReturnType<typeof servingDegenerateCounts>> }>();

export interface DegeneracyBinding {
  /** The frontier with degenerate strategies excluded — identity-equal to
   * the input when nothing qualifies (the common path). */
  frontier: Frontier | null;
  /** Strategy hashes excluded, for the trace and receipts. */
  excluded: string[];
}

export async function bindServingDegeneracy(
  db: PotionDb,
  frontier: Frontier | null,
  orgId: string,
  clusterId: string,
  warn: (msg: string) => void = () => {},
  now: Date = new Date(),
): Promise<DegeneracyBinding> {
  if (!frontier || frontier.points.length === 0) return { frontier, excluded: [] };
  let rows: Awaited<ReturnType<typeof servingDegenerateCounts>> = [];
  try {
    const key = `${orgId}::${clusterId}`;
    const hit = degeneracyCache.get(key);
    if (hit && now.getTime() - hit.at < SERVING_LATENCY_CACHE_TTL_MS) {
      rows = hit.rows;
    } else {
      // THE COLD-START RULE (2026-09-02, the first real signup): the org's
      // own measurement decides first, but an org with NO reading on a
      // strategy inherits the PLATFORM's — route health is platform truth
      // (counts per strategy, no org ids, no content), and a brand-new
      // org's first run must not rediscover a failure the platform
      // already paid for. An org's own healthy readings still outrank the
      // platform view for THAT org (its traffic may genuinely differ).
      const own = await servingDegenerateCounts(db, orgId, clusterId, DEGENERACY_WINDOW_MIN, now);
      const platform = await servingDegenerateCountsPlatform(db, clusterId, DEGENERACY_WINDOW_MIN, now);
      const ownByHash = new Map(own.map((r) => [r.strategyHash, r]));
      rows = [...own, ...platform.filter((r) => !ownByHash.has(r.strategyHash))];
      degeneracyCache.set(key, { at: now.getTime(), rows });
    }
  } catch (err) {
    // Measurement failure never breaks serving — no exclusion is the honest
    // fallback (we could not measure, so we did not claim to).
    warn(`serving-degeneracy rollup failed for org=${orgId} cluster=${clusterId}: ${String(err)}`);
    return { frontier, excluded: [] };
  }
  const degenerate = new Set(
    rows
      .filter((r) => r.empty >= DEGENERACY_MIN_EMPTY && r.empty / r.total >= DEGENERACY_MIN_RATIO)
      .map((r) => r.strategyHash),
  );
  if (degenerate.size === 0) return { frontier, excluded: [] };
  const kept = frontier.points.filter((p) => !degenerate.has(p.strategyHash));
  if (kept.length === 0) {
    // Fail open: every point is degenerate-flagged — serve the frontier as
    // measured rather than nothing, and say so.
    warn(
      `serving-degeneracy would exclude EVERY point for org=${orgId} cluster=${clusterId} — failing open`,
    );
    return { frontier, excluded: [] };
  }
  const excluded = frontier.points.filter((p) => degenerate.has(p.strategyHash)).map((p) => p.strategyHash);
  return { frontier: { ...frontier, points: kept }, excluded };
}

/** True when the policy states a latency constraint at all. Only these pay
 * for the rollup — and latency_bound gets the SAME binding as compound,
 * because shipping two meanings of "p95" would be worse than shipping one
 * that is sometimes provisional. */
export function policyHasLatencyDimension(policy: Policy): boolean {
  return policy.type === 'compound' || policy.type === 'latency_bound';
}

export interface LatencyBinding {
  /** The frontier the policy should be evaluated against — serving-grade p95
   * substituted where the evidence supports it. Identity-equal to the input
   * when no substitution applies. */
  frontier: Frontier | null;
  /** Per-strategyHash evidence: which number, from which clock, over what n. */
  evidence: Record<string, LatencyEvidence>;
  /** 'serving' when ANY point resolved to serving-grade evidence. The value
   * the trace's latency_src= field reports. */
  source: 'serving' | 'harness';
  /** The cost the bound is charging, computed against the SAME resolved
   * points the selection used. */
  premium: LatencyPremium;
}

/** The no-op binding: the policy has no latency dimension, or there is no
 * frontier to bind against. */
function inert(frontier: Frontier | null): LatencyBinding {
  return {
    frontier,
    evidence: {},
    source: 'harness',
    premium: latencyPremium({ type: 'min_cost', qualityFloor: 0 }, []),
  };
}

/**
 * Resolve the latency the policy will be evaluated against (G2.6).
 *
 * Returns the frontier unchanged for policies without a latency dimension, so
 * the common path costs one boolean. A rollup failure NEVER breaks serving:
 * catch, warn, fall back to the harness numbers marked provisional.
 */
export async function bindServingLatency(
  db: PotionDb,
  policy: Policy,
  frontier: Frontier | null,
  orgId: string,
  clusterId: string,
  warn: (msg: string) => void = () => {},
  now: Date = new Date(),
): Promise<LatencyBinding> {
  if (!policyHasLatencyDimension(policy)) return inert(frontier);
  if (!frontier || frontier.points.length === 0) return inert(frontier);

  let rows: ServingLatencySample[] = [];
  try {
    rows = await cachedRollup(db, orgId, clusterId, now);
  } catch (err) {
    // The customer's request is served against the harness numbers, and every
    // surface says the evidence is provisional — which is exactly the honest
    // answer: we could not measure, so we did not claim to.
    warn(
      `serving-latency rollup failed for org=${orgId} cluster=${clusterId} — ` +
        `binding against PROVISIONAL harness latency: ${String(err)}`,
    );
    rows = [];
  }

  const resolved = resolveLatency(frontier.points, rows, SERVING_LATENCY_WINDOW_MIN);
  return {
    frontier: { ...frontier, points: resolved.points },
    evidence: resolved.evidence,
    source: resolved.allProvisional ? 'harness' : 'serving',
    premium: latencyPremium(policy, resolved.points),
  };
}

async function cachedRollup(
  db: PotionDb,
  orgId: string,
  clusterId: string,
  now: Date,
): Promise<ServingLatencySample[]> {
  const key = `${orgId}::${clusterId}`;
  const hit = latencyCache.get(key);
  if (hit && now.getTime() - hit.at < SERVING_LATENCY_CACHE_TTL_MS) return hit.rows;
  const rows = await servingLatencyP95(db, orgId, clusterId, SERVING_LATENCY_WINDOW_MIN, now);
  latencyCache.set(key, { at: now.getTime(), rows });
  return rows;
}

// ---------------------------------------------------------------------------
// THE composed decision
// ---------------------------------------------------------------------------

export interface ServingDecisionArgs {
  orgId: string;
  clusterId: string;
  /** The org's bound policy (callers resolve it; DEFAULT_ORG_POLICY is what
   * any key would have been minted with). */
  policy: Policy;
  providerMode: ProviderMode;
  prices: PriceTable;
  warn?: (msg: string) => void;
  now?: Date;
}

export interface ServingDecision {
  /** The frontier as loaded (org-preferred, default instrument); null = none. */
  loaded: Frontier | null;
  provenance: 'live' | 'mock' | 'blocked';
  /** The policy as it applies to this cluster (its own floor substituted). */
  clusterPolicy: Policy;
  binding: LatencyBinding;
  /** Serving-measured degeneracy exclusion applied AFTER the latency
   * binding — org-measured empty-completion bursts overrule suite scores. */
  degeneracy: DegeneracyBinding;
  op: OperatingPoint;
}

/**
 * THE authoritative answer to: given org + kind of work + bound policy, what
 * would Potion serve right now? Exactly the serve path's chain — one
 * implementation, so nothing that evaluates "the current route" (the router
 * compiler, the learning period) can drift from what production executes.
 * The request-level serve path composes the same functions itself, adding
 * per-request concerns (instrument selection, tool narrowing, pins,
 * guarantee overrides) on top of this workload-level decision.
 */
export async function servingDecisionFor(db: PotionDb, a: ServingDecisionArgs): Promise<ServingDecision> {
  const warn = a.warn ?? (() => {});
  const loaded = await loadCurrentFrontier(db, a.clusterId, a.orgId);
  const guarded = guardFrontierProvenance(loaded, a.providerMode, warn);
  const clusterPolicy = policyForCluster(a.policy, a.clusterId);
  const binding = await bindServingLatency(db, clusterPolicy, guarded.frontier, a.orgId, a.clusterId, warn, a.now);
  const degeneracy = await bindServingDegeneracy(db, binding.frontier, a.orgId, a.clusterId, warn, a.now);
  const op = resolveOperatingPoint(clusterPolicy, degeneracy.frontier, fallbackStrategyFor(a.providerMode, a.prices));
  return { loaded, provenance: guarded.provenance, clusterPolicy, binding, degeneracy, op };
}
