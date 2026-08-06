// Versioned frontier persistence (SPEC §6): each save inserts a `frontiers`
// row (version = max existing version for the cluster + 1, parentId = the
// previous version's id → a per-cluster version chain) plus one
// `frontier_points` row per point. Reads return the core Frontier shape.
//
// Implemented over the thin repositories in @potion/db (insertFrontier /
// getLatestFrontier / getFrontierById) so both drivers (PGlite, node-pg)
// work unchanged.
import { randomUUID } from 'node:crypto';
import type { ClusterId, Frontier, FrontierPoint } from '@potion/core';
import {
  getFrontierById,
  getLatestFrontier,
  insertFrontier,
  type PotionDb,
} from '@potion/db';

/**
 * saveFrontier(db, clusterId, points, trigger, pricesVersion) → the persisted
 * Frontier. version chains per cluster: first save is v1 (parentId null),
 * each subsequent save is max(version)+1 with parentId pointing at the
 * previous latest row.
 */
export async function saveFrontier(
  db: PotionDb,
  clusterId: ClusterId,
  points: FrontierPoint[],
  trigger: Frontier['trigger'],
  pricesVersion: string,
): Promise<Frontier> {
  const prev = await getLatestFrontier(db, clusterId);
  const frontier: Frontier = {
    id: `fr-${randomUUID()}`,
    clusterId,
    version: (prev?.version ?? 0) + 1,
    parentId: prev?.id ?? null,
    trigger,
    points,
    pricesVersion,
    createdAt: new Date().toISOString(),
  };
  await insertFrontier(db, frontier);
  return frontier;
}

/** Latest (highest-version) frontier for a cluster, or null when none saved. */
export async function loadCurrentFrontier(
  db: PotionDb,
  clusterId: ClusterId,
): Promise<Frontier | null> {
  return getLatestFrontier(db, clusterId);
}

/** Load a specific frontier version by row id. */
export async function loadFrontier(db: PotionDb, id: string): Promise<Frontier | null> {
  return getFrontierById(db, id);
}
