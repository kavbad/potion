// PLATFORM FRONTIER BASELINE — measured routing on day zero.
//
// THE PROBLEM THIS SOLVES. A freshly migrated database has platform frontiers
// for two clusters (code-gen, extraction) and both are MOCK-provenance, from
// the demo seed. Under a live server `guardFrontierProvenance` discards
// mock-provenance frontiers, so EVERY request from EVERY org — new or not —
// falls through to the default strategy with `fallback=1`. The auto-switch is
// inert on a fresh deployment: not degraded, absent.
//
// THE EVIDENCE ALREADY EXISTS. The Step 5 platform live sweep measured all ten
// taxonomy clusters against live providers under an operator-ledgered cap
// ($3.5774 metered, reconciled and countersigned — tasks/todo.md). That
// evidence lived only in a local campaign database, so no deployment ever saw
// it. `baseline/platform-frontiers.json` is that evidence, exported verbatim:
// the same frontier rows, the same points, the same per-point evidence objects
// (eval cacheKeys, runIds, n, ci95, suite id+version, rubricHash,
// calibrationId) and the same `provider_mode='live'` stamps. Nothing is
// re-derived, re-labelled, or invented — it is a MOVE, not a claim.
//
// WHY IT MATTERS BEYOND COLD-START. Platform frontiers are what a customer
// with NO workload of their own routes on: someone building from scratch has
// no traffic to measure, so the platform baseline is the entirety of their
// evidence until their own accrues. Without it, "we pick the best model for
// what you're building" has nothing underneath it.
//
// THE RULES, ALL FAIL-SAFE:
//   · NEVER clobber. A cluster that already has ANY platform frontier is
//     skipped, whatever its provenance — an operator's own sweep always wins.
//   · NEVER downgrade. Only `provider_mode='live'` rows are importable; the
//     export refuses to write anything else, and this refuses to read it.
//   · IDEMPOTENT. Re-running imports nothing and reports why, so it is safe on
//     every boot (the F12 lesson: a data write that re-runs is a defect).
//   · HONEST. Rows carry `trigger='platform-baseline'` so the origin of the
//     evidence is legible in the database, not just in this comment.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eq, isNull, and } from 'drizzle-orm';
import { frontierPoints, frontiers } from '../schema.js';
import type { PotionDb } from '../db.js';

export interface PlatformBaselineFrontier {
  frontier: {
    id: string;
    cluster_id: string;
    version: number;
    parent_id: string | null;
    trigger: string;
    points: unknown;
    org_id: string | null;
    prices_version: string;
    created_at: string;
  };
  points: Array<{
    cluster_id: string;
    strategy_hash: string;
    strategy_config: unknown;
    quality: number;
    cost_per_1k: number;
    latency_p95: number;
    evidence: unknown;
    provider_mode: string;
  }>;
}

export interface PlatformBaseline {
  source: string;
  capturedFrom: string;
  capturedAt: string;
  providerMode: string;
  note: string;
  frontiers: PlatformBaselineFrontier[];
}

export interface PlatformBaselineReport {
  /** Clusters whose frontier was created from the baseline. */
  imported: string[];
  /** Clusters skipped because a platform frontier already existed. */
  skippedExisting: string[];
  /** Clusters refused because the baseline row was not live-provenance. */
  refusedNotLive: string[];
  pointsImported: number;
}

/** The committed baseline, read from disk the way prices/taxonomy are — no
 * JSON module resolution, so it works identically under tsc, vitest and the
 * built dist. Returns null when the file is absent rather than throwing: a
 * deployment without it simply keeps today's fallback behaviour. */
export function loadPlatformBaseline(): PlatformBaseline | null {
  for (const rel of ['../../baseline/platform-frontiers.json', '../../../baseline/platform-frontiers.json']) {
    try {
      return JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')) as PlatformBaseline;
    } catch {
      // try the next layout (src/ vs dist/src/)
    }
  }
  return null;
}

/** The id a baseline frontier takes in the target database. Deterministic, so
 * a second import collides rather than duplicating even if the existence
 * check were somehow bypassed. */
export function baselineFrontierId(clusterId: string): string {
  return `fr-platform-baseline-${clusterId}`;
}

/**
 * Import live-provenance platform frontiers for clusters that have none.
 *
 * Returns a per-cluster report rather than a boolean: a caller that cannot say
 * WHICH clusters got measured routing and which did not is exactly the kind of
 * silent instrument this codebase keeps finding.
 */
export async function importPlatformBaseline(
  db: PotionDb,
  baseline: PlatformBaseline,
): Promise<PlatformBaselineReport> {
  const report: PlatformBaselineReport = {
    imported: [],
    skippedExisting: [],
    refusedNotLive: [],
    pointsImported: 0,
  };

  for (const entry of baseline.frontiers) {
    const clusterId = entry.frontier.cluster_id;

    // Refuse anything that is not live evidence, before touching the db.
    if (entry.points.length === 0 || entry.points.some((p) => p.provider_mode !== 'live')) {
      report.refusedNotLive.push(clusterId);
      continue;
    }

    // NEVER clobber: any existing PLATFORM frontier for this cluster wins,
    // whatever its provenance or version.
    const existing = await db
      .select({ id: frontiers.id })
      .from(frontiers)
      .where(and(eq(frontiers.clusterId, clusterId), isNull(frontiers.orgId)))
      .limit(1);
    if (existing.length > 0) {
      report.skippedExisting.push(clusterId);
      continue;
    }

    const id = baselineFrontierId(clusterId);
    await db.insert(frontiers).values({
      id,
      clusterId,
      version: entry.frontier.version,
      parentId: null,
      // Legible origin: this row is imported measured evidence, not a sweep
      // this deployment ran and not a demo seed.
      trigger: 'platform-baseline',
      points: entry.frontier.points as never,
      orgId: null,
      pricesVersion: entry.frontier.prices_version,
      createdAt: entry.frontier.created_at,
    });

    for (const p of entry.points) {
      await db.insert(frontierPoints).values({
        frontierId: id,
        clusterId: p.cluster_id,
        strategyHash: p.strategy_hash,
        strategyConfig: p.strategy_config as never,
        quality: p.quality,
        costPer1K: p.cost_per_1k,
        latencyP95: p.latency_p95,
        orgId: null,
        evidence: p.evidence as never,
        providerMode: p.provider_mode,
      });
      report.pointsImported += 1;
    }
    report.imported.push(clusterId);
  }

  return report;
}
