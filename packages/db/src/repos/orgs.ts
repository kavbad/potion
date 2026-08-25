// Thin typed repository for orgs (M2 Wave 1, ROADMAP #13). Org ids are text
// in the house id style ('org_demo' seeded; runtime orgs 'org-<8hex>').
import { asc, eq } from 'drizzle-orm';
import type { PotionDb } from '../db.js';
import { orgs, type NewOrg, type OrgRow } from '../schema.js';

/** Insert an org; ON CONFLICT DO NOTHING so seeding is idempotent. */
export async function createOrg(db: PotionDb, org: NewOrg): Promise<void> {
  await db.insert(orgs).values(org).onConflictDoNothing({ target: orgs.id });
}

export async function getOrgById(db: PotionDb, id: string): Promise<OrgRow | null> {
  const rows = await db.select().from(orgs).where(eq(orgs.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function listOrgs(db: PotionDb): Promise<OrgRow[]> {
  return db.select().from(orgs).orderBy(asc(orgs.createdAt));
}

/** Model-field semantics toggle (migration 0058): label-blind routing is an
 * explicit org choice, never a silent default. */
export async function setOrgRouteAllModels(db: PotionDb, id: string, value: boolean): Promise<void> {
  await db.update(orgs).set({ routeAllModels: value }).where(eq(orgs.id, id));
}
