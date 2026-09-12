// The provider-drift tripwire's ledger (schema.ts driftCanaries).
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import type { PotionDb } from '../db.js';
import { driftCanaries, type DriftCanaryRow, type NewDriftCanary } from '../schema.js';

export async function insertDriftCanary(db: PotionDb, row: NewDriftCanary): Promise<void> {
  await db.insert(driftCanaries).values(row);
}

export async function listDriftCanariesForWeek(db: PotionDb, week: string): Promise<DriftCanaryRow[]> {
  return db.select().from(driftCanaries).where(eq(driftCanaries.week, week)).orderBy(driftCanaries.clusterId);
}

export async function weekHasDriftCanaries(db: PotionDb, week: string): Promise<boolean> {
  const rows = await db.select({ n: sql<number>`count(*)` }).from(driftCanaries).where(eq(driftCanaries.week, week));
  return Number(rows[0]?.n ?? 0) > 0;
}

/**
 * The latest drift detection among these strategies — the learning period's
 * fourth trigger: a proposal older than a drift on the point it measured
 * (serving or incumbent) is stale by construction. `since` bounds the scan.
 */
export async function latestDriftAmong(
  db: PotionDb,
  strategyHashes: readonly string[],
  since: Date,
): Promise<{ strategyHash: string; model: string; detectedAt: Date } | null> {
  if (strategyHashes.length === 0) return null;
  const rows = await db
    .select({ strategyHash: driftCanaries.strategyHash, model: driftCanaries.model, detectedAt: driftCanaries.detectedAt })
    .from(driftCanaries)
    .where(and(inArray(driftCanaries.strategyHash, [...strategyHashes]), eq(driftCanaries.verdict, 'drift'), gt(driftCanaries.detectedAt, since)))
    .orderBy(desc(driftCanaries.detectedAt))
    .limit(1);
  return rows[0] ?? null;
}
