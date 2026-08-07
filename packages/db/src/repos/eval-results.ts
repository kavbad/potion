// Thin typed repository for eval_results (SPEC §7; G1.6 org attribution +
// retirement-by-staleness; G2.1 paired qualities).
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { EvalResult, ProviderMode } from '@potion/core';
import type { PotionDb } from '../db.js';
import { evalResults } from '../schema.js';

/** db 'unknown' ↔ core absence: an EvalResult without a recorded provenance
 * round-trips with providerMode undefined (never silently 'live'). */
function providerModeToDb(mode: ProviderMode | undefined): string {
  return mode ?? 'unknown';
}

function providerModeFromDb(raw: string): ProviderMode | undefined {
  return raw === 'mock' || raw === 'live' ? raw : undefined;
}

/** Insert one eval result, keyed by its content-addressed cacheKey. */
export async function insertEvalResult(db: PotionDb, result: EvalResult): Promise<void> {
  await db.insert(evalResults).values({
    cacheKey: result.cacheKey,
    runId: result.runId,
    itemId: result.itemId,
    clusterId: result.clusterId,
    strategyHash: result.strategyHash,
    strategyConfig: result.strategyConfig,
    quality: result.quality,
    scorer: result.scorer,
    judgeAgreement: result.judgeAgreement ?? null,
    usage: result.usage,
    latencyMs: result.latencyMs,
    modelVersions: result.modelVersions,
    pricesVersion: result.pricesVersion,
    providerMode: providerModeToDb(result.providerMode),
    orgId: result.orgId ?? null,
    createdAt: result.createdAt,
  });
}

function rowToEvalResult(row: typeof evalResults.$inferSelect): EvalResult {
  const mode = providerModeFromDb(row.providerMode);
  return {
    runId: row.runId,
    itemId: row.itemId,
    clusterId: row.clusterId,
    strategyHash: row.strategyHash,
    strategyConfig: row.strategyConfig,
    quality: row.quality,
    scorer: row.scorer,
    ...(row.judgeAgreement !== null ? { judgeAgreement: row.judgeAgreement } : {}),
    usage: row.usage,
    latencyMs: row.latencyMs,
    modelVersions: row.modelVersions,
    pricesVersion: row.pricesVersion,
    ...(mode !== undefined ? { providerMode: mode } : {}),
    ...(row.orgId !== null ? { orgId: row.orgId } : {}),
    cacheKey: row.cacheKey,
    createdAt: row.createdAt,
  };
}

/**
 * Evidence retirement (G1.6, resolving the G1.3 standing decision): rows
 * whose source items were purged are marked STALE, never deleted — deleting
 * evidence would make historical frontiers unexplainable, and old frontier
 * points keep these cacheKeys as documented tombstone references. Returns
 * the retired rows' (clusterId) values so callers can recompute affected
 * frontiers immediately.
 */
export async function retireEvalResultsByItemIds(
  db: PotionDb,
  itemIds: string[],
): Promise<Array<{ cacheKey: string; clusterId: string }>> {
  if (itemIds.length === 0) return [];
  const out: Array<{ cacheKey: string; clusterId: string }> = [];
  for (let i = 0; i < itemIds.length; i += 500) {
    const chunk = itemIds.slice(i, i + 500);
    const rows = await db
      .update(evalResults)
      .set({ stale: true })
      .where(and(inArray(evalResults.itemId, chunk), eq(evalResults.stale, false)))
      .returning({ cacheKey: evalResults.cacheKey, clusterId: evalResults.clusterId });
    out.push(...rows);
  }
  return out;
}

/** Cache lookup for harness resume (SPEC §5). */
export async function getEvalResultByCacheKey(
  db: PotionDb,
  cacheKey: string,
): Promise<EvalResult | null> {
  const rows = await db
    .select()
    .from(evalResults)
    .where(eq(evalResults.cacheKey, cacheKey))
    .limit(1);
  const row = rows[0];
  return row ? rowToEvalResult(row) : null;
}

export async function listEvalResults(db: PotionDb, runId: string): Promise<EvalResult[]> {
  const rows = await db.select().from(evalResults).where(eq(evalResults.runId, runId));
  return rows.map(rowToEvalResult);
}

/** One item scored by both strategies — structurally identical to the
 * researcher gate's ItemPair (§15.4 heldout pairs). */
export interface QualityPair {
  itemId: string;
  candidateQuality: number;
  incumbentQuality: number;
}

/**
 * Per-item quality rows for two hashes on one cluster, paired by itemId
 * (G2.1 lift of the workers-private liveHeldoutPairs). Non-stale rows in
 * ONE providerMode only — modes structurally cannot mix in a pairing (the
 * research promotion gate passes 'live'; guarantee:suite-verify passes the
 * env's mode and stamps it on the verdict). orgId scoping matches the
 * eval rows' attribution: an org's pairing never mixes platform evidence.
 */
export async function pairedQualities(
  db: PotionDb,
  scope: {
    clusterId: string;
    candidateHash: string;
    incumbentHash: string;
    pricesVersion: string;
    providerMode: 'mock' | 'live';
    orgId?: string;
  },
): Promise<QualityPair[]> {
  const rows = await db
    .select({
      itemId: evalResults.itemId,
      strategyHash: evalResults.strategyHash,
      quality: evalResults.quality,
    })
    .from(evalResults)
    .where(
      and(
        eq(evalResults.clusterId, scope.clusterId),
        inArray(evalResults.strategyHash, [scope.candidateHash, scope.incumbentHash]),
        eq(evalResults.pricesVersion, scope.pricesVersion),
        eq(evalResults.stale, false),
        eq(evalResults.providerMode, scope.providerMode),
        scope.orgId !== undefined ? eq(evalResults.orgId, scope.orgId) : isNull(evalResults.orgId),
      ),
    );
  const byItem = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const m = byItem.get(r.itemId) ?? new Map<string, number>();
    m.set(r.strategyHash, r.quality);
    byItem.set(r.itemId, m);
  }
  const pairs: QualityPair[] = [];
  for (const [itemId, m] of byItem) {
    const candidateQuality = m.get(scope.candidateHash);
    const incumbentQuality = m.get(scope.incumbentHash);
    if (candidateQuality !== undefined && incumbentQuality !== undefined) {
      pairs.push({ itemId, candidateQuality, incumbentQuality });
    }
  }
  return pairs;
}
