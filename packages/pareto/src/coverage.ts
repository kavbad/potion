// COVERAGE RANKING (SERVING-ROADMAP S7 L3) — demand met with evidence.
//
// core/coverage.ts decides whether ONE cell is covered, given the evidence
// that would serve it. This assembles that evidence out of the database and
// ranks every published cell, so the question "what have we never tested
// for?" has an ordered answer with a reason on every row.
//
// WHAT COUNTS AS EVIDENCE, and why it is narrower than it looks:
//
//   Only LIVE-provenance points. Mock points exist on frontiers in dev and
//   would otherwise report a cluster as measured when nothing was ever
//   bought. The serving path refuses them under the provenance guard; the
//   coverage read must agree with the serving path or it is describing a
//   different product.
//
//   Only SINGLE points can cover tool-carrying demand, because the serve
//   path narrows tool requests to single points (routes/chat.ts). A
//   tool-capable cascade would never be selected, so counting it as coverage
//   would hide the gap it does not close.
//
//   A strategy's context window is its SMALLEST member's. Everything in an
//   ensemble sees the prompt.
import { assessCoverage, strategyModels, type CoverageEvidence, type CoverageVerdict } from '@potion/core';
import {
  demandCellContributors,
  listDemandCells,
  listModelCatalog,
  orgs,
  type DemandCellRow,
  type PotionDb,
} from '@potion/db';
import { eq } from 'drizzle-orm';
import { loadCurrentFrontier } from './persistence.js';

export interface CoverageGap extends CoverageVerdict {
  cell: DemandCellRow;
  /** Null when the cluster has no frontier at all. */
  evidence: CoverageEvidence | null;
}

export interface RankOptions {
  /** Only demand at or after this ISO week start. */
  sinceWeek?: string;
  /** Cap on cells examined (busiest first). */
  limit?: number;
  /** Include covered cells in the output (default: gaps only). */
  includeCovered?: boolean;
  /**
   * S7 L4 premium: multiply the score of cells a priority org contributed to
   * (orgs.learning_priority). Default 1 — no effect.
   *
   * This reads the PRIVATE contributor table, and that is the only place it
   * may be read: it changes the ORDER measurements happen in, never what a
   * published cell contains and never who can see one. A priority org buys
   * its unmet demand being measured first, not visibility into anyone.
   */
  priorityWeight?: number;
}

/**
 * Rank published demand by how badly it is unserved. Gaps first, worst first.
 */
export async function rankCoverageGaps(
  db: PotionDb,
  opts: RankOptions = {},
): Promise<CoverageGap[]> {
  const cells = await listDemandCells(db, {
    ...(opts.sinceWeek !== undefined ? { sinceWeek: opts.sinceWeek } : {}),
    limit: opts.limit ?? 200,
  });
  if (cells.length === 0) return [];

  const catalog = new Map((await listModelCatalog(db)).map((m) => [m.alias, m]));
  const evidenceByCluster = new Map<string, CoverageEvidence | null>();
  const priorityWeight = opts.priorityWeight ?? 1;
  const prioritized =
    priorityWeight === 1 ? new Set<string>() : await prioritizedCellKeys(db);

  const gaps: CoverageGap[] = [];
  for (const cell of cells) {
    let evidence: CoverageEvidence | null = null;
    if (cell.bucketKind === 'cluster') {
      if (!evidenceByCluster.has(cell.bucket)) {
        evidenceByCluster.set(cell.bucket, await clusterEvidence(db, cell.bucket, catalog));
      }
      evidence = evidenceByCluster.get(cell.bucket) ?? null;
    }
    const verdict = assessCoverage(
      {
        bucket: cell.bucket,
        bucketKind: cell.bucketKind,
        shapeClass: cell.shapeClass,
        requests: cell.requests,
        orgCount: cell.orgCount,
      },
      evidence,
    );
    if (verdict.covered && opts.includeCovered !== true) continue;
    const weighted = prioritized.has(cell.cellKey)
      ? { ...verdict, score: verdict.score * priorityWeight }
      : verdict;
    gaps.push({ ...weighted, cell, evidence });
  }

  // Score descending; ties break on cell key so the ranking is TOTAL and a
  // job that acts on "the top gap" acts on the same one twice.
  gaps.sort((a, b) => b.score - a.score || a.cell.cellKey.localeCompare(b.cell.cellKey));
  return gaps;
}

/** Cells with at least one priority-org contributor. Private read (S7 L2:
 * contributors never leave the aggregator); used for ORDER only. */
async function prioritizedCellKeys(db: PotionDb): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({ cellKey: demandCellContributors.cellKey })
    .from(demandCellContributors)
    .innerJoin(orgs, eq(orgs.id, demandCellContributors.orgId))
    .where(eq(orgs.learningPriority, true));
  return new Set(rows.map((r) => r.cellKey));
}

type Catalog = Map<string, { supportsTools: boolean | null; contextLength: number | null }>;

async function clusterEvidence(
  db: PotionDb,
  clusterId: string,
  catalog: Catalog,
): Promise<CoverageEvidence | null> {
  // Platform scope (no orgId): S7 learns across customers, so the evidence
  // it measures against is the platform frontier every org can inherit.
  const frontier = await loadCurrentFrontier(db, clusterId);
  if (frontier === null) return null;

  const live = frontier.points.filter((p) => p.providerMode === 'live');
  let toolCapablePoints = 0;
  let maxContextTokens: number | null = null;

  for (const point of live) {
    const aliases = strategyModels(point.strategyConfig);
    const entries = aliases.map((a) => catalog.get(a));

    if (
      point.strategyConfig.type === 'single' &&
      entries.every((e) => e?.supportsTools === true)
    ) {
      toolCapablePoints++;
    }

    // Unknown context anywhere in the strategy makes the whole point's window
    // unknown — a maximum computed over what happened to be reported would
    // overstate the fleet.
    const windows = entries.map((e) => e?.contextLength ?? null);
    if (windows.every((w) => w !== null)) {
      const smallest = Math.min(...(windows as number[]));
      maxContextTokens = maxContextTokens === null ? smallest : Math.max(maxContextTokens, smallest);
    }
  }

  return { livePoints: live.length, toolCapablePoints, maxContextTokens };
}
