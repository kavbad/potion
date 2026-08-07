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
  getServingFrontier,
  insertFrontier,
  type PotionDb,
} from '@potion/db';

/** Per-cluster provenance context stamped onto points at save time (G1.6).
 * The CALLER resolves these (approved rubric etc.) — pareto never depends on
 * cluster-rubrics repos. */
export interface FrontierProvenanceContext {
  suiteId?: string;
  suiteVersion?: string;
  rubricHash?: string;
  calibrationId?: string;
}

export interface SaveFrontierOpts {
  /** Tenant scope; absent = platform. Version chains are SCOPE-EXACT. */
  orgId?: string;
  provenance?: FrontierProvenanceContext;
}

const SAVE_RETRIES = 3;

function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; message?: string; cause?: { code?: string; message?: string } };
  const code = err?.code ?? err?.cause?.code;
  const msg = `${err?.message ?? ''} ${err?.cause?.message ?? ''}`;
  return code === '23505' || /duplicate key|unique/i.test(msg);
}

/**
 * saveFrontier(db, clusterId, points, trigger, pricesVersion, opts?) → the
 * persisted Frontier. Version chains per (scope, cluster): first save is v1
 * (parentId null), each subsequent save is max(version)+1 with parentId
 * pointing at the previous latest row IN THE SAME SCOPE — an org's chain
 * never forks off the platform chain.
 *
 * Race fix (G1.6): the (org, cluster, version) unique turns the historical
 * read-then-insert race into a retryable 23505; we re-read and retry up to
 * SAVE_RETRIES so both concurrent savers land distinct versions.
 *
 * Provenance (owner rule): opts.provenance fields are stamped into each
 * point's evidence ONLY where absent — fresh points get them; carried-over
 * points keep their ORIGINAL links verbatim (the honest audit trail across
 * rubric supersessions).
 */
export async function saveFrontier(
  db: PotionDb,
  clusterId: ClusterId,
  points: FrontierPoint[],
  trigger: Frontier['trigger'],
  pricesVersion: string,
  opts: SaveFrontierOpts = {},
): Promise<Frontier> {
  const stamped =
    opts.provenance === undefined
      ? points
      : points.map((p) => {
          if (p.evidence === undefined) return p;
          const ev = { ...p.evidence };
          if (ev.suiteId === undefined && opts.provenance!.suiteId !== undefined) ev.suiteId = opts.provenance!.suiteId;
          if (ev.suiteVersion === undefined && opts.provenance!.suiteVersion !== undefined) ev.suiteVersion = opts.provenance!.suiteVersion;
          if (ev.rubricHash === undefined && opts.provenance!.rubricHash !== undefined) ev.rubricHash = opts.provenance!.rubricHash;
          if (ev.calibrationId === undefined && opts.provenance!.calibrationId !== undefined) ev.calibrationId = opts.provenance!.calibrationId;
          return { ...p, evidence: ev };
        });
  let lastErr: unknown;
  for (let attempt = 0; attempt < SAVE_RETRIES; attempt++) {
    const prev = await getLatestFrontier(db, clusterId, opts.orgId ?? null);
    const frontier: Frontier = {
      id: `fr-${randomUUID()}`,
      clusterId,
      version: (prev?.version ?? 0) + 1,
      parentId: prev?.id ?? null,
      trigger,
      points: stamped,
      pricesVersion,
      orgId: opts.orgId ?? null,
      createdAt: new Date().toISOString(),
    };
    try {
      await insertFrontier(db, frontier);
      return frontier;
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      lastErr = e; // lost the race — re-read latest and try the next version
    }
  }
  throw lastErr;
}

/**
 * The SERVING read (G1.6): org-preferred with platform fallback; omitted
 * orgId pins platform (share links + leaderboard get platform-only
 * semantics by default). A fully-retired (zero-point) org frontier falls
 * back to platform.
 */
export async function loadCurrentFrontier(
  db: PotionDb,
  clusterId: ClusterId,
  orgId?: string,
): Promise<Frontier | null> {
  return getServingFrontier(db, clusterId, orgId);
}

/** Load a specific frontier version by row id. */
export async function loadFrontier(db: PotionDb, id: string): Promise<Frontier | null> {
  return getFrontierById(db, id);
}
