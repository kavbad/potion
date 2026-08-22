// Research repository (M4b, ROADMAP #37, SPEC §15.6, migration 0014_research).
// Both tables are platform-GLOBAL (no org scoping — the autoresearcher is a
// platform capability: recipes it verifies publish frontier versions all orgs
// inherit; per-org private research is a documented follow-up in SPEC §15).
import { and, desc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import type { PotionDb } from '../db.js';
import {
  clusters,
  evalResults,
  orgs,
  recipeStatus,
  researchCycles,
  strategyConfigs,
  type ClusterRow,
  type EvalResultRow,
  type NewResearchCycle,
  type OrgRow,
  type RecipeStatusRow,
  type ResearchCycleRow,
  type StrategyConfigRow,
} from '../schema.js';

/** Open one research cycle (status 'queued'; id comes from the db). */
export async function insertResearchCycle(
  db: PotionDb,
  row: NewResearchCycle,
): Promise<ResearchCycleRow> {
  const inserted = await db.insert(researchCycles).values(row).returning();
  return inserted[0]!;
}

/** Patch a cycle's mutable fields (status transitions, spend, provenance,
 * completion timestamp). Returns the post-update row, or null for unknown
 * ids (worker crash-consistency: callers tolerate a vanished row). */
export async function updateResearchCycle(
  db: PotionDb,
  id: string,
  patch: Partial<
    Pick<ResearchCycleRow, 'status' | 'spendUsd' | 'provenance' | 'completedAt' | 'candidates'>
  >,
): Promise<ResearchCycleRow | null> {
  const updated = await db.update(researchCycles).set(patch).where(eq(researchCycles.id, id)).returning();
  return updated[0] ?? null;
}

/** Recent cycles, newest first (dashboard /recipes lineage + audit). */
/** Cycles listing. With `opts.orgId`: platform cycles (org_id NULL) plus
 * the org's OWN — other tenants' cycles are invisible (G1.8: candidate
 * sets, spend, and focus aliases are tenant data). Unscoped listing remains
 * for internal/worker callers only. */
export async function listResearchCycles(
  db: PotionDb,
  limit = 50,
  opts: { orgId?: string } = {},
): Promise<ResearchCycleRow[]> {
  return db
    .select()
    .from(researchCycles)
    .where(
      opts.orgId !== undefined
        ? or(isNull(researchCycles.orgId), eq(researchCycles.orgId, opts.orgId))
        : undefined,
    )
    .orderBy(desc(researchCycles.createdAt))
    .limit(limit);
}

export async function getResearchCycle(
  db: PotionDb,
  id: string,
): Promise<ResearchCycleRow | null> {
  const rows = await db.select().from(researchCycles).where(eq(researchCycles.id, id)).limit(1);
  return rows[0] ?? null;
}

/** Cumulative live research spend across ALL cycles — the §15.3 research
 * ledger total (separate from the M1b cap). */
export async function researchSpendTotalUsd(db: PotionDb): Promise<number> {
  const rows = await db.select({ spendUsd: researchCycles.spendUsd }).from(researchCycles);
  return rows.reduce((sum, r) => sum + r.spendUsd, 0);
}

/** Upsert one recipe's lifecycle state. firstCycleId is only ever SET, never
 * cleared — later cycles touching the same recipe leave the provenance of
 * its first discovery intact. updatedAt always moves. */
export async function upsertRecipeStatus(
  db: PotionDb,
  strategyHash: string,
  status: RecipeStatusRow['status'],
  firstCycleId?: string,
): Promise<void> {
  await db
    .insert(recipeStatus)
    .values({
      strategyHash,
      status,
      ...(firstCycleId !== undefined ? { firstCycleId } : {}),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: recipeStatus.strategyHash,
      set: { status, updatedAt: new Date() },
    });
}

/** Status rows for a set of hashes (missing hashes = never seen by the
 * researcher — callers treat them as implicit 'candidate'). */
export async function getRecipeStatusByHashes(
  db: PotionDb,
  hashes: string[],
): Promise<Map<string, RecipeStatusRow>> {
  if (hashes.length === 0) return new Map();
  const rows = await db
    .select()
    .from(recipeStatus)
    .where(inArray(recipeStatus.strategyHash, hashes));
  return new Map(rows.map((r) => [r.strategyHash, r]));
}

/** Every recipe in one lifecycle state (e.g. all current 'frontier' recipes
 * for the leaderboard cross-check). */
export async function listRecipeStatusByStatus(
  db: PotionDb,
  status: RecipeStatusRow['status'],
): Promise<RecipeStatusRow[]> {
  return db.select().from(recipeStatus).where(eq(recipeStatus.status, status));
}

/**
 * Recipes promoted to the frontier within the last `sinceDays`.
 *
 * THE GAP THIS FILLS. A promotion is the autoresearcher's whole output — the
 * moment a recipe clears the paired-bootstrap gate and starts serving real
 * traffic. Until now the only way to learn about one was an alert rule:
 * `emitPromotionAlerts` fans out to orgs subscribed to `recipe_promoted`, and
 * `dispatchAlertEvent` matches rules and delivers. With no rule configured —
 * the state of every deployment that has not set up a webhook — a promotion
 * was recorded nowhere and announced to nobody. The status row changed and
 * that was all.
 *
 * `recipe_status.updated_at` already dates every transition, so the record
 * existed; nothing read it. Ordered newest first because the question this
 * answers is "what changed since I last looked".
 */
export async function listRecentlyPromoted(
  db: PotionDb,
  sinceDays = 30,
  limit = 50,
): Promise<RecipeStatusRow[]> {
  const since = new Date(Date.now() - sinceDays * 86_400_000);
  return db
    .select()
    .from(recipeStatus)
    .where(and(eq(recipeStatus.status, 'frontier'), gte(recipeStatus.updatedAt, since)))
    .orderBy(desc(recipeStatus.updatedAt))
    .limit(limit);
}

// ---------------------------------------------------------------------------
// Read models for the /api/recipes + /api/leaderboard surfaces (M4b #37/#32,
// SPEC §15.5/§13.4). Routes stay drizzle-free; assembly lives there, raw
// queries live here.
// ---------------------------------------------------------------------------

/** Every registered strategy config (the recipe library's backbone). */
export async function listAllStrategyConfigs(db: PotionDb): Promise<StrategyConfigRow[]> {
  return db.select().from(strategyConfigs);
}

/** Every recipe_status row (all lifecycle states). */
export async function listAllRecipeStatus(db: PotionDb): Promise<RecipeStatusRow[]> {
  return db.select().from(recipeStatus);
}

/** The eval-lineage projection /api/recipes groups by hash. */
export type EvalLineageRow = Pick<
  EvalResultRow,
  'strategyHash' | 'clusterId' | 'runId' | 'providerMode' | 'createdAt'
>;
/** Lineage rows for the recipe library. With `opts.orgId`: platform rows
 * plus the org's own — G1.8 closes the pre-existing leak where every
 * tenant's agent-cluster ids surfaced to every viewer via /api/recipes. */
export async function listEvalLineageRows(
  db: PotionDb,
  opts: { orgId?: string } = {},
): Promise<EvalLineageRow[]> {
  return db
    .select({
      strategyHash: evalResults.strategyHash,
      clusterId: evalResults.clusterId,
      runId: evalResults.runId,
      providerMode: evalResults.providerMode,
      createdAt: evalResults.createdAt,
    })
    .from(evalResults)
    .where(
      opts.orgId !== undefined
        ? or(isNull(evalResults.orgId), eq(evalResults.orgId, opts.orgId))
        : undefined,
    );
}

/** Every seeded cluster (leaderboard iterates these), newest first. */
/**
 * List clusters. With `opts.orgId`, returns PLATFORM clusters (org_id NULL —
 * static taxonomy + grandfathered pre-G1.2 agent rows) plus the org's OWN;
 * other tenants' clusters are invisible (G1.2). `platformOnly` (G1.6) pins
 * org_id IS NULL — the public leaderboard uses this. Unscoped global listing
 * remains for internal/worker callers only.
 */
export async function listClusters(
  db: PotionDb,
  opts: { orgId?: string; platformOnly?: boolean } = {},
): Promise<ClusterRow[]> {
  // platformOnly (G1.6): the public leaderboard pins org_id IS NULL
  // explicitly — before G1.6 it iterated every tenant's agent clusters and
  // only the live-evidence gate kept them off the public surface; G1.7's
  // live org frontiers would have turned that into a cross-tenant leak.
  return db
    .select()
    .from(clusters)
    .where(
      opts.platformOnly === true
        ? isNull(clusters.orgId)
        : opts.orgId !== undefined
          ? or(isNull(clusters.orgId), eq(clusters.orgId, opts.orgId))
          : undefined,
    )
    .orderBy(desc(clusters.createdAt));
}

/**
 * Ownership-checked cluster lookup (G1.2): platform clusters (org_id NULL)
 * resolve for every org; tenant clusters only for their owner. Returns null
 * for other tenants' ids — callers surface the SAME not-found error as for
 * unknown ids (no existence oracle).
 */
export async function getClusterByIdForOrg(
  db: PotionDb,
  id: string,
  orgId: string,
): Promise<ClusterRow | null> {
  const rows = await db
    .select()
    .from(clusters)
    .where(and(eq(clusters.id, id), or(isNull(clusters.orgId), eq(clusters.orgId, orgId))))
    .limit(1);
  return rows[0] ?? null;
}

/** One cluster by id (null when unknown) — X-Potion-Cluster hint validation
 * (M5 #36, SPEC §14.2). */
export async function getClusterById(db: PotionDb, id: string): Promise<ClusterRow | null> {
  const rows = await db.select().from(clusters).where(eq(clusters.id, id));
  return rows[0] ?? null;
}

/** Latest LIVE run id for one (cluster, strategy) — the leaderboard's
 * verification provenance a skeptic can re-run. */
export async function latestLiveRunForPoint(
  db: PotionDb,
  clusterId: string,
  strategyHash: string,
): Promise<{ runId: string; createdAt: string } | null> {
  const rows = await db
    .select({ runId: evalResults.runId, createdAt: evalResults.createdAt })
    .from(evalResults)
    .where(
      sql`${evalResults.clusterId} = ${clusterId} AND ${evalResults.strategyHash} = ${strategyHash} AND ${evalResults.providerMode} = 'live'`,
    )
    .orderBy(desc(evalResults.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/** Orgs that opted into public leaderboard publishing (§13.4): NAMES only —
 * opting in publishes the org's name, never its data. */
export async function listLeaderboardAdopters(db: PotionDb): Promise<Pick<OrgRow, 'name'>[]> {
  return db.select({ name: orgs.name }).from(orgs).where(eq(orgs.publishToLeaderboard, true));
}
