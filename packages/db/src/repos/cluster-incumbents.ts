// Cluster-incumbent designation repo (G2.1, migration 0025). The incumbent
// is the org's DESIGNATED baseline strategy per cluster — the denominator of
// every retention verdict and the source of every derived floor. Lifecycle
// clones cluster_rubrics: at most one ACTIVE per (org, cluster) (partial
// unique index), redesignation supersedes the previous row transactionally,
// and superseded rows stay listed forever with their status_reason — the
// owner rule: customers see everything derived from their data, paired with
// status + evidence. There is NO silent default: an undesignated cluster is
// an explicit "retention unavailable" state, never an inferred baseline.
import { and, desc, eq } from 'drizzle-orm';
import type { PotionDb } from '../db.js';
import {
  clusterIncumbents,
  strategyConfigs,
  type ClusterIncumbentRow,
} from '../schema.js';

/**
 * Designate `strategyHash` as the active incumbent for (org, cluster).
 * Transactional: the previous active row (if any) flips to 'superseded'
 * with a reason naming its successor, then the new row inserts as active.
 * The strategy hash must resolve in strategy_configs — a designation
 * pointing at nothing would render every later verdict unexplainable.
 * Re-designating the CURRENT incumbent is a recorded no-op (returns the
 * existing row) — idempotent, no churn in the history.
 */
export async function designateIncumbent(
  db: PotionDb,
  orgId: string,
  clusterId: string,
  strategyHash: string,
): Promise<ClusterIncumbentRow> {
  return db.transaction(async (tx) => {
    const strategy = (
      await tx
        .select({ hash: strategyConfigs.hash })
        .from(strategyConfigs)
        .where(eq(strategyConfigs.hash, strategyHash))
    )[0];
    if (!strategy) {
      throw new Error(`strategy ${strategyHash} not found — cannot designate an unknown incumbent`);
    }
    const current = (
      await tx
        .select()
        .from(clusterIncumbents)
        .where(
          and(
            eq(clusterIncumbents.orgId, orgId),
            eq(clusterIncumbents.clusterId, clusterId),
            eq(clusterIncumbents.status, 'active'),
          ),
        )
    )[0];
    if (current && current.strategyHash === strategyHash) return current;
    // Supersede BEFORE inserting: the one-active partial unique index is
    // checked per-statement, so the new active row must not coexist with
    // the old one even inside the transaction.
    if (current) {
      await tx
        .update(clusterIncumbents)
        .set({
          status: 'superseded',
          statusReason: `superseded by redesignation to ${strategyHash}`,
        })
        .where(eq(clusterIncumbents.id, current.id));
    }
    const inserted = (
      await tx
        .insert(clusterIncumbents)
        .values({ orgId, clusterId, strategyHash, status: 'active' })
        .returning()
    )[0]!;
    return inserted;
  });
}

/** The active incumbent for (org, cluster), or null = undesignated (the
 * caller surfaces "retention unavailable", never infers a baseline). */
export async function activeIncumbent(
  db: PotionDb,
  orgId: string,
  clusterId: string,
): Promise<ClusterIncumbentRow | null> {
  const rows = await db
    .select()
    .from(clusterIncumbents)
    .where(
      and(
        eq(clusterIncumbents.orgId, orgId),
        eq(clusterIncumbents.clusterId, clusterId),
        eq(clusterIncumbents.status, 'active'),
      ),
    );
  return rows[0] ?? null;
}

/** Full designation history for an org (optionally one cluster), newest
 * first — superseded rows included with their reasons (visible rigor). */
export async function listIncumbents(
  db: PotionDb,
  orgId: string,
  clusterId?: string,
): Promise<ClusterIncumbentRow[]> {
  const where = clusterId
    ? and(eq(clusterIncumbents.orgId, orgId), eq(clusterIncumbents.clusterId, clusterId))
    : eq(clusterIncumbents.orgId, orgId);
  return db
    .select()
    .from(clusterIncumbents)
    .where(where)
    .orderBy(desc(clusterIncumbents.designatedAt), desc(clusterIncumbents.id));
}
