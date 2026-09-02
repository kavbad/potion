// G2 rung 1 (migration 0087) — discovered-workload repository. Snapshot
// semantics: a discovery run REPLACES the org's rows (the table records the
// current observed structure, not history). Org-scoped by construction.
import { and, asc, eq } from 'drizzle-orm';
import type { PotionDb } from '../db.js';
import { orgWorkloads, type NewOrgWorkload, type OrgWorkloadRow } from '../schema.js';

export async function replaceOrgWorkloads(
  db: PotionDb,
  orgId: string,
  rows: NewOrgWorkload[],
): Promise<void> {
  await db.delete(orgWorkloads).where(eq(orgWorkloads.orgId, orgId));
  if (rows.length > 0) await db.insert(orgWorkloads).values(rows);
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
