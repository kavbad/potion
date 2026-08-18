// THE MODEL REGISTRY (SERVING-ROADMAP S5) — the catalog, in the database.
//
// WHAT THIS REPLACES. `prices.json` was the registry, and `research:scan`
// grew it with writeFileSync. That file ships inside the container image, so
// every discovery died on the next deploy — and never reached the running
// process regardless, because loadPrices() runs once at boot. A catalog that
// cannot survive a restart is not a catalog; it is a build artifact.
//
// WHAT THIS IS NOT. Rows here are everything Potion knows it COULD call.
// They are not what it will route to: only measured frontier points are
// routable, and this table has no opinion about measurement. Keeping the two
// separate is the whole reason "we support 300 models" does not become a
// claim nobody evaluated. Catalog ≠ frontier.
//
// THE VERSION, and why it is not re-derived. `pricesVersion` keys
// eval_results cache cells, so it must move exactly when the catalog changes
// and never otherwise. It is carried over VERBATIM from the seed file on
// first load; a content hash — the tempting choice — would have changed on
// the very first boot after this migration and invalidated the Step 5
// campaign's $3.58 of paid-for evidence.
import { desc, sql } from 'drizzle-orm';
import type { PotionDb } from '../db.js';
import { models, type ModelRow, type NewModelRow } from '../schema.js';

/** The shape the rest of the platform already speaks (core's PriceTable). */
export interface RegistryTable {
  version: string;
  updatedAt: string;
  entries: Array<{
    alias: string;
    provider: string;
    model: string;
    inputPer1M: number;
    outputPer1M: number;
  }>;
}

export interface SeedReport {
  /** Aliases inserted because the registry did not have them. */
  inserted: string[];
  /** Aliases already present and left EXACTLY as they were. */
  skipped: string[];
}

/**
 * Seed the registry from the committed price table.
 *
 * NEVER CLOBBERS. An alias already in the table wins, whatever its prices —
 * the same rule the platform-frontier baseline follows, and for the same
 * reason: a live catalog that a redeploy silently reverts to the committed
 * file would reintroduce the exact bug S5 exists to fix. Adding missing
 * aliases is safe and keeps a fresh database bootable with no network;
 * overwriting present ones is not.
 *
 * IDEMPOTENT: a second call inserts nothing and says so.
 */
export async function seedModelRegistry(
  db: PotionDb,
  table: RegistryTable,
): Promise<SeedReport> {
  const existing = new Set((await db.select({ alias: models.alias }).from(models)).map((r) => r.alias));
  const report: SeedReport = { inserted: [], skipped: [] };
  const rows: NewModelRow[] = [];
  for (const e of table.entries) {
    if (existing.has(e.alias)) {
      report.skipped.push(e.alias);
      continue;
    }
    rows.push({
      alias: e.alias,
      provider: e.provider,
      model: e.model,
      inputPer1M: e.inputPer1M,
      outputPer1M: e.outputPer1M,
      pricesVersion: table.version,
      source: 'seed',
    });
    report.inserted.push(e.alias);
  }
  if (rows.length > 0) await db.insert(models).values(rows);
  return report;
}

/**
 * The live registry, in PriceTable shape.
 *
 * Returns null when the table is EMPTY rather than an empty table: an empty
 * registry is indistinguishable from a broken read, and a caller that
 * silently served an empty price table would resolve no models at all. Null
 * makes the caller fall back to the file, which is the honest recovery.
 *
 * Version = the newest row's. It moves precisely when a scan adds something
 * and stays put otherwise, which is the cache-invalidation semantics
 * eval_results depends on.
 */
export async function loadModelRegistry(db: PotionDb): Promise<RegistryTable | null> {
  const rows = await db.select().from(models).orderBy(desc(models.createdAt));
  if (rows.length === 0) return null;
  const newest = rows[0]!;
  return {
    version: newest.pricesVersion,
    updatedAt: (newest.updatedAt ?? newest.createdAt ?? new Date()).toISOString(),
    entries: rows.map((r) => ({
      alias: r.alias,
      provider: r.provider,
      model: r.model,
      inputPer1M: r.inputPer1M,
      outputPer1M: r.outputPer1M,
    })),
  };
}

/** Full catalog rows, including the facts a PriceTable cannot carry. */
export async function listModelCatalog(db: PotionDb): Promise<ModelRow[]> {
  return db.select().from(models).orderBy(models.alias);
}

export interface AddScannedReport {
  added: string[];
  /** Present already; left alone. A scan DISCOVERS, it does not re-price. */
  alreadyKnown: string[];
}

/**
 * Record models a scan discovered.
 *
 * Additive only. A scan that re-priced existing entries would rewrite the
 * cost basis of evidence already collected under the old prices, so
 * re-pricing is a deliberate operator action, not a side effect of looking.
 *
 * New rows carry `version`, which the caller bumps — that is what invalidates
 * stale-price eval cells, and it is the same semantics the file-based
 * mergePriceEntry had.
 */
export async function addScannedModels(
  db: PotionDb,
  entries: Array<{
    alias: string;
    provider: string;
    model: string;
    inputPer1M: number;
    outputPer1M: number;
    contextLength?: number | null;
    maxOutputTokens?: number | null;
    supportsTools?: boolean | null;
  }>,
  version: string,
): Promise<AddScannedReport> {
  const existing = new Set((await db.select({ alias: models.alias }).from(models)).map((r) => r.alias));
  const report: AddScannedReport = { added: [], alreadyKnown: [] };
  const rows: NewModelRow[] = [];
  for (const e of entries) {
    if (existing.has(e.alias)) {
      report.alreadyKnown.push(e.alias);
      continue;
    }
    rows.push({
      alias: e.alias,
      provider: e.provider,
      model: e.model,
      inputPer1M: e.inputPer1M,
      outputPer1M: e.outputPer1M,
      pricesVersion: version,
      source: 'scan',
      ...(e.contextLength != null ? { contextLength: e.contextLength } : {}),
      ...(e.maxOutputTokens != null ? { maxOutputTokens: e.maxOutputTokens } : {}),
      ...(e.supportsTools != null ? { supportsTools: e.supportsTools } : {}),
    });
    report.added.push(e.alias);
  }
  if (rows.length > 0) await db.insert(models).values(rows);
  return report;
}

/** Row count — used by boot logging and by tests asserting the seed landed. */
export async function countModels(db: PotionDb): Promise<number> {
  const res = await db.execute(sql`SELECT count(*)::int AS n FROM models`);
  return Number((res.rows as Array<{ n: number }>)[0]?.n ?? 0);
}
