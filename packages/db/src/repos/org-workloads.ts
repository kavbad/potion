// G2 rung 1 (migration 0087) — discovered-workload repository. Snapshot
// semantics: a discovery run REPLACES the org's rows (the table records the
// current observed structure, not history). Org-scoped by construction.
import { asc, eq } from 'drizzle-orm';
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

export async function listOrgWorkloads(db: PotionDb, orgId: string): Promise<OrgWorkloadRow[]> {
  return db
    .select()
    .from(orgWorkloads)
    .where(eq(orgWorkloads.orgId, orgId))
    .orderBy(asc(orgWorkloads.parentCluster), asc(orgWorkloads.id));
}
