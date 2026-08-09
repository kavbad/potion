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

/** An item with evidence for ONE strategy only — a coverage gap the verdict
 * must report, not swallow (G2.8-followup). */
export interface UnpairableItem {
  itemId: string;
  has: 'candidate' | 'incumbent';
}

export interface PairedQualities {
  /** Items scored by BOTH strategies, ordered by itemId. */
  pairs: QualityPair[];
  /** Items scored by exactly one — reported, never silently dropped. */
  unpairable: UnpairableItem[];
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
): Promise<PairedQualities> {
  const rows = await db
    .select({
      itemId: evalResults.itemId,
      strategyHash: evalResults.strategyHash,
      quality: evalResults.quality,
      cacheKey: evalResults.cacheKey,
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
    )
    // G2.8-followup: TOTAL, EXPLICIT ordering. Without it the scan order is
    // unspecified by the SQL contract, `byItem` (insertion-ordered) inherits
    // it, and `computeRetention` seeds from sha256(JSON.stringify(ratios)) —
    // so the CI95 of a CONTRACTUAL verdict was a function of physical row
    // order. It happened to be stable on one PGlite file; that is luck, not a
    // guarantee, and it survives neither a vacuum nor a plan change.
    .orderBy(evalResults.itemId, evalResults.strategyHash);

  const byItem = new Map<string, Map<string, { quality: number; cacheKey: string }>>();
  for (const r of rows) {
    const m = byItem.get(r.itemId) ?? new Map<string, { quality: number; cacheKey: string }>();
    const existing = m.get(r.strategyHash);
    if (existing !== undefined) {
      // REFUSE rather than guess. The previous code did `m.set(...)`, so a
      // second row for the same (item, strategy) silently won on scan order —
      // a value-changing race, not merely an ordering one. Naming both cache
      // keys makes the collision diagnosable instead of invisible.
      throw new Error(
        `pairedQualities: duplicate eval evidence for item '${r.itemId}' strategy ` +
          `'${r.strategyHash}' (cacheKeys ${existing.cacheKey} and ${r.cacheKey}) — ` +
          'refusing to pick one; a contractual verdict must not depend on which row was scanned last',
      );
    }
    m.set(r.strategyHash, { quality: r.quality, cacheKey: r.cacheKey });
    byItem.set(r.itemId, m);
  }

  const pairs: QualityPair[] = [];
  const unpairable: UnpairableItem[] = [];
  // Iterating a Map keyed by itemId in insertion order, over rows already
  // sorted by itemId, gives a deterministic item sequence.
  for (const [itemId, m] of byItem) {
    const candidate = m.get(scope.candidateHash);
    const incumbent = m.get(scope.incumbentHash);
    if (candidate !== undefined && incumbent !== undefined) {
      pairs.push({
        itemId,
        candidateQuality: candidate.quality,
        incumbentQuality: incumbent.quality,
      });
      continue;
    }
    // Previously dropped silently. An item evaluated for one strategy but not
    // the other is a COVERAGE GAP, and a verdict that hides it reads as
    // cleaner than the evidence supports.
    unpairable.push({
      itemId,
      has: candidate !== undefined ? 'candidate' : 'incumbent',
    });
  }
  return { pairs, unpairable };
}
