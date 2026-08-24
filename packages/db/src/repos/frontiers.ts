// Thin typed repository for frontiers + frontier_points (SPEC §7, G1.6
// per-org). Scope semantics: org_id NULL = platform. Version chains are
// SCOPE-EXACT (an org's first frontier is v1/parent-null — never chained
// off the platform frontier); the SERVING read is org-preferred with
// platform fallback. Points carry schema-level provenance (owner rule):
// evidence rides in frontiers.points jsonb (the read path) and is mirrored
// per-row on frontier_points.evidence for SQL audit.
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Frontier } from '@potion/core';
import type { PotionDb } from '../db.js';
import { frontierPoints, frontiers } from '../schema.js';

/**
 * Persist a frontier row plus one frontier_points row per point — ONE
 * transaction (G1.6): a crash between the two inserts previously left the
 * jsonb and the mirror table disagreeing.
 */
export async function insertFrontier(db: PotionDb, frontier: Frontier): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(frontiers).values({
      id: frontier.id,
      clusterId: frontier.clusterId,
      version: frontier.version,
      parentId: frontier.parentId,
      trigger: frontier.trigger,
      points: frontier.points,
      pricesVersion: frontier.pricesVersion,
      orgId: frontier.orgId ?? null,
      createdAt: frontier.createdAt,
    instrument: frontier.instrument ?? 'default',
    });
    if (frontier.points.length > 0) {
      await tx.insert(frontierPoints).values(
        frontier.points.map((p) => ({
          frontierId: frontier.id,
          clusterId: p.clusterId,
          strategyHash: p.strategyHash,
          strategyConfig: p.strategyConfig,
          quality: p.quality,
          costPer1K: p.costPer1K,
          latencyP95: p.latencyP95,
          // Provenance per point (M1a): absence persists as explicit 'unknown'.
          providerMode: p.providerMode ?? 'unknown',
          orgId: frontier.orgId ?? null,
          evidence: p.evidence ?? null,
        })),
      );
    }
  });
}

function toFrontier(row: typeof frontiers.$inferSelect): Frontier {
  return {
    id: row.id,
    clusterId: row.clusterId,
    version: row.version,
    parentId: row.parentId,
    trigger: row.trigger as Frontier['trigger'],
    points: row.points,
    pricesVersion: row.pricesVersion,
    orgId: row.orgId,
    createdAt: row.createdAt,
    instrument: (row.instrument === 'tools' || row.instrument === 'vision' || row.instrument === 'audio' ? row.instrument : 'default') as 'default' | 'tools' | 'vision' | 'audio',
  };
}

export async function getFrontierById(db: PotionDb, id: string): Promise<Frontier | null> {
  const rows = await db.select().from(frontiers).where(eq(frontiers.id, id)).limit(1);
  return rows[0] ? toFrontier(rows[0]) : null;
}

/**
 * Latest version within ONE scope (version desc). `orgScope` null (the
 * default) = platform rows only — this is the SAVE path's read: version
 * chains never cross scopes.
 */
export async function getLatestFrontier(
  db: PotionDb,
  clusterId: string,
  orgScope: string | null = null,
  instrument: 'default' | 'tools' | 'vision' | 'audio' = 'default',
): Promise<Frontier | null> {
  const rows = await db
    .select()
    .from(frontiers)
    .where(
      and(
        eq(frontiers.clusterId, clusterId),
        orgScope === null ? isNull(frontiers.orgId) : eq(frontiers.orgId, orgScope),
        eq(frontiers.instrument, instrument),
      ),
    )
    .orderBy(desc(frontiers.version))
    .limit(1);
  return rows[0] ? toFrontier(rows[0]) : null;
}

/**
 * The SERVING read (G1.6): org-preferred with platform fallback in one
 * query. Omitted orgId pins platform (org_id IS NULL) — share links and the
 * leaderboard get platform-only semantics by default, not by caller
 * discipline. An org frontier with ZERO points is treated as absent
 * (evidence-retirement emptied it) and falls back to platform.
 */
export async function getServingFrontier(
  db: PotionDb,
  clusterId: string,
  orgId?: string,
  instrument: 'default' | 'tools' | 'vision' | 'audio' = 'default',
): Promise<Frontier | null> {
  if (orgId === undefined) return getLatestFrontier(db, clusterId, null, instrument);
  const rows = await db
    .select()
    .from(frontiers)
    .where(
      and(
        eq(frontiers.clusterId, clusterId),
        sql`(${frontiers.orgId} = ${orgId} OR ${frontiers.orgId} IS NULL)`,
        eq(frontiers.instrument, instrument),
      ),
    )
    .orderBy(desc(sql`(${frontiers.orgId} IS NOT NULL)`), desc(frontiers.version))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.orgId !== null && row.points.length === 0) {
    // Fully-retired org frontier → platform fallback.
    return getLatestFrontier(db, clusterId, null);
  }
  return toFrontier(row);
}
