// Thin typed repository for frontiers + frontier_points (SPEC §7).
import { desc, eq } from 'drizzle-orm';
import type { Frontier } from '@potion/core';
import type { PotionDb } from '../db.js';
import { frontierPoints, frontiers } from '../schema.js';

/** Persist a frontier row plus one frontier_points row per point. */
export async function insertFrontier(db: PotionDb, frontier: Frontier): Promise<void> {
  await db.insert(frontiers).values({
    id: frontier.id,
    clusterId: frontier.clusterId,
    version: frontier.version,
    parentId: frontier.parentId,
    trigger: frontier.trigger,
    points: frontier.points,
    pricesVersion: frontier.pricesVersion,
    createdAt: frontier.createdAt,
  });
  if (frontier.points.length > 0) {
    await db.insert(frontierPoints).values(
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
      })),
    );
  }
}

export async function getFrontierById(db: PotionDb, id: string): Promise<Frontier | null> {
  const rows = await db.select().from(frontiers).where(eq(frontiers.id, id)).limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    clusterId: row.clusterId,
    version: row.version,
    parentId: row.parentId,
    trigger: row.trigger as Frontier['trigger'],
    points: row.points,
    pricesVersion: row.pricesVersion,
    createdAt: row.createdAt,
  };
}

/** Latest version for a cluster (version desc). */
export async function getLatestFrontier(
  db: PotionDb,
  clusterId: string,
): Promise<Frontier | null> {
  const rows = await db
    .select()
    .from(frontiers)
    .where(eq(frontiers.clusterId, clusterId))
    .orderBy(desc(frontiers.version))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    clusterId: row.clusterId,
    version: row.version,
    parentId: row.parentId,
    trigger: row.trigger as Frontier['trigger'],
    points: row.points,
    pricesVersion: row.pricesVersion,
    createdAt: row.createdAt,
  };
}
