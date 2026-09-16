// The savings baseline (2026-08-22). A receipt's "saved" figure is the gap
// between what the request cost and what it would have cost on the baseline
// point of the same frontier, scaled by the request's own usage (chat.ts
// baselineCostUsd). Before this the baseline was always the frontier's
// highest-quality point — "vs the best measured model" — even for an org that
// had named the model it actually uses. The order now:
//   1. the cluster's designated incumbent (G2.1, cluster_incumbents), if it
//      is a point on the frontier being served;
//   2. the org's named incumbent from onboarding (org_incumbents.models), the
//      first one that is a point on this frontier;
//   3. null → the highest-quality point, as before.
// Cached per org+cluster for a minute: two reads per request is not worth
// paying on every call, and a designation changing a minute late is fine.
import { strategyHash, type Frontier } from '@potion/core';
import { activeIncumbent, getOrgIncumbents, observedIncumbents, type PotionDb } from '@potion/db';

export const BASELINE_CACHE_TTL_MS = 60_000;
/** How far back the observed incumbent looks (routing + the picker agree). */
export const OBSERVED_WINDOW_MS = 30 * 24 * 3600 * 1000;

interface Cached {
  at: number;
  clusterHash: string | null;
  orgModels: string[];
  /** The labels this org's requests NAMED on this cluster, most-named first
   * (2026-09-16). Resolved to roster aliases at read time by the caller's
   * resolver, because this cache has no price table. */
  observedLabels: string[];
}
const cache = new Map<string, Cached>();

/** Test seam: forget every cached designation. */
export function clearBaselineCache(): void {
  cache.clear();
}

/**
 * WHICH comparator a recorded baseline_cost_usd came from (request_logs
 * .baseline_basis). 'policy-infeasible' (2026-09-11): the bound floor
 * admitted no point, the highest-quality point served, and the comparator
 * is that same point — a $0 gap that is a symptom, not a saving.
 */
export type BaselineBasis =
  | 'request-incumbent'
  | 'cluster-incumbent'
  | 'org-incumbent'
  | 'observed-incumbent'
  | 'best-of-frontier'
  | 'policy-infeasible';

export interface Baseline {
  hash: string;
  basis: 'request-incumbent' | 'cluster-incumbent' | 'org-incumbent' | 'observed-incumbent';
}

export interface BaselineOpts {
  /** The roster alias THIS request named in its `model` field (route-all or
   * a pin), or null for 'potion-auto'. The exact counterfactual: what this
   * request would have cost on the model its own code asked for. */
  requestModel?: string | null;
  /** Label → roster alias, from the server's price table (2026-09-16). */
  resolveAlias?: (label: string) => string | null;
}

/**
 * THE COMPARATOR, IN ORDER OF HOW MUCH IT PROVES (2026-09-16 revision):
 *   0. the model THIS request named — exact, per request, nothing to ask;
 *   1. the cluster's designated incumbent;
 *   2. the org's named incumbent from onboarding;
 *   3. the model this org's requests NAMED MOST on this kind of work in the
 *      last 30 days — observed, never typed;
 *   4. null → the frontier's best point, stamped 'best-of-frontier'.
 * Each must be a point on the frontier being served, or it cannot be priced.
 */
export async function baselineFor(
  db: PotionDb,
  orgId: string,
  clusterId: string,
  frontier: Frontier | null,
  now: number = Date.now(),
  opts: BaselineOpts = {},
): Promise<Baseline | null> {
  if (!frontier || frontier.points.length === 0) return null;
  const onFrontier = (hash: string) => frontier.points.some((p) => p.strategyHash === hash);
  if (opts.requestModel) {
    const hash = strategyHash({ type: 'single', model: opts.requestModel });
    if (onFrontier(hash)) return { hash, basis: 'request-incumbent' };
  }
  const key = `${orgId}|${clusterId}`;
  let c = cache.get(key);
  if (!c || now - c.at > BASELINE_CACHE_TTL_MS) {
    const [row, org, observed] = await Promise.all([
      activeIncumbent(db, orgId, clusterId),
      getOrgIncumbents(db, orgId),
      observedIncumbents(db, orgId, new Date(now - OBSERVED_WINDOW_MS)),
    ]);
    c = {
      at: now,
      clusterHash: row?.strategyHash ?? null,
      orgModels: org?.models ?? [],
      observedLabels: observed.filter((o) => o.clusterId === clusterId).map((o) => o.model),
    };
    cache.set(key, c);
  }
  if (c.clusterHash !== null && onFrontier(c.clusterHash)) {
    return { hash: c.clusterHash, basis: 'cluster-incumbent' };
  }
  for (const model of c.orgModels) {
    const hash = strategyHash({ type: 'single', model });
    if (onFrontier(hash)) return { hash, basis: 'org-incumbent' };
  }
  for (const label of c.observedLabels) {
    const alias = opts.resolveAlias ? opts.resolveAlias(label) : label;
    if (alias === null) continue;
    const hash = strategyHash({ type: 'single', model: alias });
    if (onFrontier(hash)) return { hash, basis: 'observed-incumbent' };
  }
  return null;
}
