// G2 RUNG 3 — SERVE-PATH WORKLOAD SUB-ASSIGNMENT (2026-09-02, review §16's
// second half: discovered structure becomes ROUTING only by explicit
// adoption).
//
// After the taxonomy assigns a request to its parent cluster, the request's
// OWN classification vector is compared against the org's ADOPTED workload
// centroids within that parent. A match at or above the gate re-addresses
// the request to the workload id, which serves on the workload's own org
// frontier (minted from its measurement rows at adopt time). Doctrine:
//   · EXPLICIT, never silent: only rows an admin adopted participate;
//     discovery alone changes nothing.
//   · SAME FEATURES: the vector compared is the exact embedding serving
//     classified on — no second embed, no drift between the two decisions.
//   · SAME GATE: the threshold is the one that FORMED the group at
//     discovery, read off the row — serving never re-derives it.
//   · FAIL-OPEN to the parent: no vector (hint path), no adopted rows, an
//     empty/guard-blocked workload frontier, or any error at all means the
//     request serves exactly as it would have yesterday.
import { listAdoptedWorkloads } from '@potion/db';
import { guardFrontierProvenance, loadCurrentFrontier } from '@potion/pareto';
import type { PotionContext } from '../context.js';

/** Adopted-set cache TTL — mirrors the holdout config cache: fresh enough
 * that adopt/retire binds within a minute, cheap enough that serving never
 * pays a per-request read. The adopt/retire routes bust it in-process. */
export const WORKLOAD_ROUTING_CACHE_TTL_MS = 60_000;

interface AdoptedRow {
  id: string;
  parentCluster: string;
  centroid: number[];
  threshold: number;
}

const cache = new Map<string, { at: number; rows: AdoptedRow[] }>();

export function bustWorkloadRoutingCache(orgId: string): void {
  cache.delete(orgId);
}

// Local twin of the workers' cosineSim — the serve path must not pull the
// workers package in for eight lines of arithmetic.
function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return -1;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? -1 : dot / denom;
}

async function adoptedFor(ctx: PotionContext, orgId: string): Promise<AdoptedRow[]> {
  const hit = cache.get(orgId);
  if (hit !== undefined && Date.now() - hit.at < WORKLOAD_ROUTING_CACHE_TTL_MS) return hit.rows;
  let rows: AdoptedRow[] = [];
  try {
    rows = (await listAdoptedWorkloads(ctx.db.db, orgId)).flatMap((r) =>
      Array.isArray(r.centroid)
        ? [{ id: r.id, parentCluster: r.parentCluster, centroid: r.centroid as number[], threshold: r.threshold }]
        : [],
    );
  } catch {
    rows = []; // a config read failure never breaks serving — parent routing
  }
  cache.set(orgId, { at: Date.now(), rows });
  return rows;
}

export interface WorkloadSubAssignment {
  workloadId: string;
  similarity: number;
}

/**
 * Decide whether THIS request re-addresses to an adopted workload within
 * its parent cluster. Never throws into the serving path; null = serve the
 * parent as before.
 */
export async function resolveWorkloadSubAssignment(
  ctx: PotionContext,
  orgId: string,
  parentCluster: string,
  embedding: number[] | undefined,
): Promise<WorkloadSubAssignment | null> {
  if (embedding === undefined || embedding.length === 0) return null;
  try {
    const rows = (await adoptedFor(ctx, orgId)).filter((r) => r.parentCluster === parentCluster);
    if (rows.length === 0) return null;
    let best: { row: AdoptedRow; sim: number } | null = null;
    for (const row of rows) {
      const sim = cosine(embedding, row.centroid);
      if (sim >= row.threshold && (best === null || sim > best.sim)) best = { row, sim };
    }
    if (best === null) return null;
    // The workload must actually be servable HERE — an org frontier that
    // exists and survives this server's provenance guard with points. An
    // adopted row whose frontier was retired (or is mock under live) falls
    // open to the parent instead of falling back to the default strategy.
    const loaded = await loadCurrentFrontier(ctx.db.db, best.row.id, orgId);
    const guarded = guardFrontierProvenance(loaded, ctx.providerMode);
    if (guarded.frontier === null || guarded.frontier.points.length === 0) return null;
    return { workloadId: best.row.id, similarity: best.sim };
  } catch {
    return null;
  }
}
