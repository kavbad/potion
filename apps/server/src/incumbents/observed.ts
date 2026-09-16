// THE INCUMBENT, OBSERVED (2026-09-16). The picker asked "which model do you
// use today?" — one answer for an org that may run dozens across many kinds
// of work. Their traffic already answers it per kind of work, with volumes:
// the `model` label each request names. This resolves those labels against
// the priced roster (a label off the roster is still shown — named but not
// measurable) and ranks them per cluster.
import type { PriceTable } from '@potion/core';
import { observedIncumbents, type PotionDb } from '@potion/db';

export const OBSERVED_WINDOW_DAYS = 30;

export interface ObservedModel {
  /** The label the requests named, verbatim. */
  label: string;
  /** The roster alias it resolves to, or null when it is not a priced model. */
  alias: string | null;
  requests: number;
  /** Share of this kind of work's NAMED requests. */
  share: number;
  lastSeen: string;
}

export interface ObservedCluster {
  clusterId: string;
  namedRequests: number;
  models: ObservedModel[];
}

export function aliasResolver(prices: PriceTable): (label: string) => string | null {
  return (label) => prices.entries.find((e) => e.alias === label || e.model === label)?.alias ?? null;
}

export async function observedIncumbentsFor(
  db: PotionDb,
  prices: PriceTable,
  orgId: string,
  now: number = Date.now(),
): Promise<ObservedCluster[]> {
  const since = new Date(now - OBSERVED_WINDOW_DAYS * 24 * 3600 * 1000);
  const rows = await observedIncumbents(db, orgId, since);
  const resolve = aliasResolver(prices);
  const byCluster = new Map<string, ObservedCluster>();
  for (const r of rows) {
    const c = byCluster.get(r.clusterId) ?? { clusterId: r.clusterId, namedRequests: 0, models: [] };
    c.namedRequests += r.requests;
    c.models.push({ label: r.model, alias: resolve(r.model), requests: r.requests, share: 0, lastSeen: r.lastSeen.toISOString() });
    byCluster.set(r.clusterId, c);
  }
  for (const c of byCluster.values()) {
    for (const m of c.models) m.share = c.namedRequests > 0 ? Number((m.requests / c.namedRequests).toFixed(4)) : 0;
  }
  return [...byCluster.values()].sort((a, b) => b.namedRequests - a.namedRequests);
}
