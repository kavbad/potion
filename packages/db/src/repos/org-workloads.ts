// G2 rung 1 (migration 0087) — discovered-workload repository. Snapshot
// semantics: a discovery run REPLACES the org's rows (the table records the
// current observed structure, not history). Org-scoped by construction.
import { and, asc, eq, ne } from 'drizzle-orm';
import type { PotionDb } from '../db.js';
import { orgWorkloads, type NewOrgWorkload, type OrgWorkloadRow } from '../schema.js';

/**
 * G2 rung 3: ADOPTED rows are routing state, not observations — a discovery
 * snapshot must never wipe them. The replace clears only non-adopted rows;
 * the caller receives the surviving adopted rows so it can avoid id
 * collisions and skip re-discovering their territory.
 */
export async function replaceOrgWorkloads(
  db: PotionDb,
  orgId: string,
  rows: NewOrgWorkload[],
): Promise<void> {
  await db.delete(orgWorkloads).where(and(eq(orgWorkloads.orgId, orgId), ne(orgWorkloads.status, 'adopted')));
  if (rows.length > 0) await db.insert(orgWorkloads).values(rows);
}

/** The org's ADOPTED workloads — the serve path's sub-assignment set. */
export async function listAdoptedWorkloads(
  db: PotionDb,
  orgId: string,
): Promise<Array<{ id: string; parentCluster: string; centroid: unknown; threshold: number }>> {
  return db
    .select({
      id: orgWorkloads.id,
      parentCluster: orgWorkloads.parentCluster,
      centroid: orgWorkloads.centroid,
      threshold: orgWorkloads.threshold,
    })
    .from(orgWorkloads)
    .where(and(eq(orgWorkloads.orgId, orgId), eq(orgWorkloads.status, 'adopted')));
}

/** One-way-checked status transition (adopt: measured → adopted; retire:
 * adopted → measured). Returns false when the row is missing or not in the
 * expected state — the route turns that into a 404/409, never a silent
 * overwrite. */
export async function setWorkloadStatus(
  db: PotionDb,
  orgId: string,
  id: string,
  from: string,
  to: string,
): Promise<boolean> {
  const rows = await db
    .update(orgWorkloads)
    .set({ status: to })
    .where(and(eq(orgWorkloads.orgId, orgId), eq(orgWorkloads.id, id), eq(orgWorkloads.status, from)))
    .returning({ id: orgWorkloads.id });
  return rows.length > 0;
}

/** G2 rung 2: attach a measurement to one discovered workload (and flip it
 * to 'measured'). Org-scoped; false when the row is gone — a re-discovery
 * raced the measurement, and the measurement of an old grouping must not
 * resurrect it. */
export async function setWorkloadMeasurement(
  db: PotionDb,
  orgId: string,
  id: string,
  measurement: unknown,
): Promise<boolean> {
  const rows = await db
    .update(orgWorkloads)
    .set({ measurement, status: 'measured' })
    .where(and(eq(orgWorkloads.orgId, orgId), eq(orgWorkloads.id, id)))
    .returning({ id: orgWorkloads.id });
  return rows.length > 0;
}

export async function listOrgWorkloads(db: PotionDb, orgId: string): Promise<OrgWorkloadRow[]> {
  return db
    .select()
    .from(orgWorkloads)
    .where(eq(orgWorkloads.orgId, orgId))
    .orderBy(asc(orgWorkloads.parentCluster), asc(orgWorkloads.id));
}
