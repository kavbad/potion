// FLOOR FEASIBILITY (2026-09-16). Feasibility is not a judgement call: for
// each kind of work with a measured frontier, does any point's quality LOWER
// BOUND clear the floor? If not, min_cost admits nothing there and the serve
// path — correctly — serves the best-quality point at a premium with
// fallback=1 and says so only in a header. Found live: a floor of
// 0.978543771043771 on classification v8, whose highest provable quality is
// 0.969, sat on a key for weeks; the floor card accepted it without a word.
//
// This answers the question at SAVE time, per cluster, so the card can say
// "on classification the highest provable quality is 0.97" before the
// customer commits — and keeps the decision theirs.
import { loadTaxonomy } from '@potion/cluster';
import { qualityLowerBound, type FrontierPoint, type Policy } from '@potion/core';
import type { PotionDb } from '@potion/db';
import { loadCurrentFrontier } from '@potion/pareto';
import { floorFor } from './floors.js';

export interface ClusterFeasibility {
  clusterId: string;
  /** The floor this policy applies on this cluster (per-kind floor, else the default). */
  floor: number;
  /** The highest quality any measured point on this cluster can PROVE (max lower bound). */
  highestProvable: number;
  /** The point that proves it. */
  bestModel: string;
  points: number;
  feasible: boolean;
}

function labelOf(p: FrontierPoint): string {
  const cfg = p.strategyConfig as { type: string; model?: string; name?: string };
  return cfg.model ?? cfg.name ?? cfg.type;
}

/**
 * One row per kind of work that has a frontier for this org. Clusters with
 * nothing measured are omitted: there is no evidence to warn from, and the
 * serve path already labels them "default (not measured yet)".
 */
export async function floorFeasibility(db: PotionDb, orgId: string, policy: Policy): Promise<ClusterFeasibility[]> {
  const out: ClusterFeasibility[] = [];
  for (const c of loadTaxonomy().clusters) {
    const floor = floorFor(policy, c.id);
    if (floor === null) continue;
    const frontier = await loadCurrentFrontier(db, c.id, orgId);
    if (!frontier || frontier.points.length === 0) continue;
    let best: FrontierPoint | null = null;
    let highest = -1;
    for (const p of frontier.points) {
      const lb = qualityLowerBound(p);
      if (lb > highest) { highest = lb; best = p; }
    }
    if (best === null) continue;
    out.push({
      clusterId: c.id,
      floor,
      highestProvable: Number(highest.toFixed(4)),
      bestModel: labelOf(best),
      points: frontier.points.length,
      feasible: highest >= floor,
    });
  }
  return out;
}

export function infeasibleOnly(rows: ClusterFeasibility[]): ClusterFeasibility[] {
  return rows.filter((r) => !r.feasible);
}
