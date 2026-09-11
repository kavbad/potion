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
import { activeIncumbent, getOrgIncumbents, type PotionDb } from '@potion/db';

export const BASELINE_CACHE_TTL_MS = 60_000;

interface Cached {
  at: number;
  clusterHash: string | null;
  orgModels: string[];
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
export type BaselineBasis = 'cluster-incumbent' | 'org-incumbent' | 'best-of-frontier' | 'policy-infeasible';

export interface Baseline {
  hash: string;
  basis: 'cluster-incumbent' | 'org-incumbent';
}

export async function baselineFor(
  db: PotionDb,
  orgId: string,
  clusterId: string,
  frontier: Frontier | null,
  now: number = Date.now(),
): Promise<Baseline | null> {
  if (!frontier || frontier.points.length === 0) return null;
  const key = `${orgId}|${clusterId}`;
  let c = cache.get(key);
  if (!c || now - c.at > BASELINE_CACHE_TTL_MS) {
    const [row, org] = await Promise.all([activeIncumbent(db, orgId, clusterId), getOrgIncumbents(db, orgId)]);
    c = { at: now, clusterHash: row?.strategyHash ?? null, orgModels: org?.models ?? [] };
    cache.set(key, c);
  }
  const onFrontier = (hash: string) => frontier.points.some((p) => p.strategyHash === hash);
  if (c.clusterHash !== null && onFrontier(c.clusterHash)) {
    return { hash: c.clusterHash, basis: 'cluster-incumbent' };
  }
  for (const model of c.orgModels) {
    const hash = strategyHash({ type: 'single', model });
    if (onFrontier(hash)) return { hash, basis: 'org-incumbent' };
  }
  return null;
}
