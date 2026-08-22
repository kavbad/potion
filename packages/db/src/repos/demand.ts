// DEMAND CELLS (SERVING-ROADMAP S7 L2) — the merge that turns per-process
// accumulator deltas into k-anonymous published demand.
//
// The serve path holds sums in memory (core/demand.ts) and drains them on a
// timer; this is where those deltas meet everyone else's. Two rules govern
// every line below:
//
//   PUBLICATION IS A WRITE GATE. A cell that has not been fed by ≥K distinct
//   orgs is not written to `demand_cells` at all. It accumulates privately
//   and appears the moment it stops being one customer's traffic. Nothing
//   downstream needs to remember to filter, because there is nothing to
//   filter.
//
//   A PUBLISHED ROW CARRIES NO IDENTITY. Contributor org ids live in a
//   private table and are converted to a COUNT on the way out.
//
// Merge is additive and idempotent-by-accumulation, not by delta id: a
// delivered delta is folded in once by construction (the accumulator drains
// to empty). A crash between drain and merge loses that window's counts,
// which is the safe direction — under-counting demand delays a measurement,
// over-counting it would spend money on a workload nobody has.
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { isPublishable, normalizeCentroid, type DemandDelta } from '@potion/core';
import type { PotionDb } from '../db.js';
import {
  demandCellContributors,
  demandCellStaging,
  demandCells,
  type DemandCellRow,
} from '../schema.js';

/** Canonical embedding width; a centroid of any other width is not stored. */
const CENTROID_DIMS = 384;

export interface MergeOptions {
  /** Distinct orgs required before a cell may be published. */
  minOrgs?: number;
  /** Requests required before a cell may be published. */
  minRequests?: number;
}

export interface MergeReport {
  /** Cells whose staging row was updated. */
  merged: number;
  /** Cells that cleared the gate and are now published. */
  published: number;
  /** Cells still below the gate — held privately, deliberately unreadable. */
  withheld: number;
}

/**
 * Fold accumulator deltas into staging, then publish whatever now qualifies.
 */
export async function mergeDemandDeltas(
  db: PotionDb,
  deltas: readonly DemandDelta[],
  opts: MergeOptions = {},
): Promise<MergeReport> {
  const report: MergeReport = { merged: 0, published: 0, withheld: 0 };

  for (const delta of deltas) {
    const existing = (
      await db.select().from(demandCellStaging).where(eq(demandCellStaging.cellKey, delta.cellKey))
    )[0];

    const centroidSum = addSums(existing?.centroidSum ?? null, delta.centroidSum);
    const merged = {
      cellKey: delta.cellKey,
      bucket: delta.bucket,
      bucketKind: delta.bucketKind,
      shapeClass: delta.shapeClass,
      weekStart: delta.weekStart,
      requests: (existing?.requests ?? 0) + delta.requests,
      confidenceSum: (existing?.confidenceSum ?? 0) + delta.confidenceSum,
      confidenceCount: (existing?.confidenceCount ?? 0) + delta.confidenceCount,
      confidenceMin: minDefined(existing?.confidenceMin ?? null, delta.confidenceMin),
      centroidSum,
      centroidCount: (existing?.centroidCount ?? 0) + delta.centroidCount,
      updatedAt: new Date(),
    };

    await db
      .insert(demandCellStaging)
      .values(merged)
      .onConflictDoUpdate({ target: demandCellStaging.cellKey, set: merged });

    if (delta.orgIds.length > 0) {
      await db
        .insert(demandCellContributors)
        .values(delta.orgIds.map((orgId) => ({ cellKey: delta.cellKey, orgId })))
        .onConflictDoNothing();
    }
    report.merged++;

    const orgCount = await contributorCount(db, delta.cellKey);
    if (!isPublishable(orgCount, merged.requests, opts.minOrgs, opts.minRequests)) {
      report.withheld++;
      continue;
    }

    const centroid = normalizeCentroid(merged.centroidSum);
    const published = {
      cellKey: delta.cellKey,
      bucket: merged.bucket,
      bucketKind: merged.bucketKind,
      shapeClass: merged.shapeClass,
      weekStart: merged.weekStart,
      requests: merged.requests,
      orgCount,
      // Averaged over the observations that MEASURED a fit, not over every
      // request: hinted traffic has no fit to average.
      confidenceMean:
        merged.confidenceCount === 0 ? null : merged.confidenceSum / merged.confidenceCount,
      confidenceMin: merged.confidenceMin,
      confidenceCount: merged.confidenceCount,
      // A centroid of the wrong width came from a different embedder; publish
      // the cell without one rather than a direction in the wrong space.
      centroid: centroid !== null && centroid.length === CENTROID_DIMS ? centroid : null,
      publishedAt: new Date(),
    };
    await db
      .insert(demandCells)
      .values(published)
      .onConflictDoUpdate({ target: demandCells.cellKey, set: published });
    report.published++;
  }

  return report;
}

function minDefined(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

function addSums(a: number[] | null, b: number[] | null): number[] | null {
  if (a === null) return b === null ? null : [...b];
  if (b === null) return a;
  // Different widths mean two embedders fed one cell; keep the established
  // sum rather than adding across incomparable spaces.
  if (a.length !== b.length) return a;
  return a.map((x, i) => x + b[i]!);
}

async function contributorCount(db: PotionDb, cellKey: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(demandCellContributors)
    .where(eq(demandCellContributors.cellKey, cellKey));
  return Number(rows[0]?.n ?? 0);
}

export interface ListDemandOptions {
  /** Only cells at or after this ISO week start (YYYY-MM-DD). */
  sinceWeek?: string;
  bucketKind?: 'cluster' | 'unassigned';
  limit?: number;
}

/** Read PUBLISHED demand, busiest first. The only demand read feature code
 * is allowed: staging and contributors are the aggregator's alone. */
export async function listDemandCells(
  db: PotionDb,
  opts: ListDemandOptions = {},
): Promise<DemandCellRow[]> {
  const filters = [
    opts.sinceWeek !== undefined ? gte(demandCells.weekStart, opts.sinceWeek) : undefined,
    opts.bucketKind !== undefined ? eq(demandCells.bucketKind, opts.bucketKind) : undefined,
  ].filter((f): f is NonNullable<typeof f> => f !== undefined);

  const base = db.select().from(demandCells);
  const filtered = filters.length > 0 ? base.where(and(...filters)) : base;
  return filtered.orderBy(desc(demandCells.requests)).limit(opts.limit ?? 100);
}
