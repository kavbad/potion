// Boot-time consistency check: every model a platform frontier can route to
// must resolve in the model registry the server is about to serve from.
//
// Why this exists: on 2026-08-21 production imported a baseline measured
// against one price table while loading another. Routing picked the measured
// models (the receipt was perfect); the provider layer then threw
// `unknown model` and every such request was a 503. Nothing in /readyz could
// see it — the database was fine, the queue was fine, the catalogue was just
// the wrong catalogue. A frontier and the registry it was measured against
// have to move together, and this is the check that makes that a property of
// the boot rather than a memory.
//
// The resolution rule is deliberately the SAME one the serve path uses
// (packages/strategies createResolver: alias OR native id), so this check can
// never disagree with the thing it protects.
import { sql } from 'drizzle-orm';
import type { PotionDb } from '@potion/db';
import { getLatestFrontier } from '@potion/db';
import type { PriceTable, StrategyConfig } from '@potion/core';

/** Keys whose string values name a model, across every StrategyConfig shape. */
const MODEL_KEYS = new Set([
  'model',
  'draftModel',
  'verifierModel',
  'startModel',
  'upgradeModel',
  'decomposerModel',
  'judgeModel',
]);

/**
 * Every model id a strategy config can reach. Walks the config rather than
 * switching on `type`, so a new strategy shape with a new model field is
 * caught rather than silently skipped — the failure mode this check exists
 * to prevent is exactly "a field nobody thought to list".
 */
export function modelsInStrategy(config: StrategyConfig): string[] {
  const out = new Set<string>();
  const walk = (node: unknown, parentKey: string | null): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, parentKey);
      return;
    }
    if (node === null || typeof node !== 'object') {
      if (typeof node === 'string' && parentKey === 'models') out.add(node); // ensemble: models[]
      return;
    }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (MODEL_KEYS.has(k) && typeof v === 'string') out.add(v);
      else if (k === 'routing' && v && typeof v === 'object' && !Array.isArray(v)) {
        // decompose: { routing: { [cluster]: model } } — the VALUES are models
        for (const m of Object.values(v as Record<string, unknown>)) if (typeof m === 'string') out.add(m);
      } else walk(v, k);
    }
  };
  walk(config, null);
  return [...out].sort();
}

export interface UnresolvedModel {
  clusterId: string;
  frontierVersion: number;
  strategyHash: string;
  model: string;
}

export interface FrontierRegistryReport {
  /** Platform clusters with a serving frontier that were checked. */
  clustersChecked: string[];
  /** Version of the registry the server will serve from. */
  registryVersion: string;
  /** Distinct prices_version values the checked frontiers were measured at. */
  frontierPricesVersions: string[];
  /** Models a frontier routes to that the registry cannot resolve. */
  unresolved: UnresolvedModel[];
}

function resolves(prices: PriceTable, model: string): boolean {
  return prices.entries.some((e) => e.alias === model || e.model === model);
}

/**
 * Check every PLATFORM (org-less) serving frontier against the registry.
 *
 * `production: true` → throws on any unresolved model (fail closed: a server
 * that would 503 the measured route must not report ready). Otherwise the
 * report is returned for the caller to log, loudly.
 */
export async function checkPlatformFrontiersAgainstRegistry(
  db: PotionDb,
  prices: PriceTable,
  opts: { production: boolean },
): Promise<FrontierRegistryReport> {
  const rows = (
    await db.execute(sql`select distinct cluster_id from frontiers where org_id is null`)
  ).rows as Array<{ cluster_id: string }>;
  const clusterIds = rows.map((r) => r.cluster_id).sort();

  const unresolved: UnresolvedModel[] = [];
  const versions = new Set<string>();
  const checked: string[] = [];
  for (const clusterId of clusterIds) {
    const frontier = await getLatestFrontier(db, clusterId, null);
    if (!frontier) continue;
    checked.push(clusterId);
    versions.add(frontier.pricesVersion);
    for (const p of frontier.points) {
      for (const model of modelsInStrategy(p.strategyConfig)) {
        if (!resolves(prices, model)) {
          unresolved.push({ clusterId, frontierVersion: frontier.version, strategyHash: p.strategyHash, model });
        }
      }
    }
  }

  const report: FrontierRegistryReport = {
    clustersChecked: checked,
    registryVersion: prices.version,
    frontierPricesVersions: [...versions].sort(),
    unresolved,
  };

  if (opts.production && unresolved.length > 0) {
    throw new Error(formatFailure(report));
  }
  return report;
}

export function formatFailure(report: FrontierRegistryReport): string {
  const models = [...new Set(report.unresolved.map((u) => u.model))].sort();
  const where = report.unresolved
    .map((u) => `${u.clusterId} v${u.frontierVersion} ${u.strategyHash.slice(0, 8)} → ${u.model}`)
    .slice(0, 12)
    .join('; ');
  return (
    `frontier/registry mismatch: ${models.length} model(s) the platform frontiers route to ` +
    `are not in the model registry (registry version ${report.registryVersion}; frontiers measured at ` +
    `${report.frontierPricesVersions.join(', ') || 'unknown'}). Missing: ${models.join(', ')}. ` +
    `Set POTION_PRICES_PATH to the table the frontiers were measured against, or re-measure. ` +
    `(${where}${report.unresolved.length > 12 ? '; …' : ''})`
  );
}
