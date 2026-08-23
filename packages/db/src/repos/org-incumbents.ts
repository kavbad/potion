// What an org uses today, and whether it agreed to sampling — the two facts
// the learning period needs before it may spend a cent on their behalf.
import { eq } from 'drizzle-orm';
import type { PotionDb } from '../db.js';
import { orgIncumbents } from '../schema.js';

export interface OrgIncumbents {
  orgId: string;
  models: string[];
  other: string | null;
  samplingConsent: boolean;
  sampleCapPerCluster: number;
  designatedAt: Date;
}

export async function getOrgIncumbents(db: PotionDb, orgId: string): Promise<OrgIncumbents | null> {
  const rows = await db.select().from(orgIncumbents).where(eq(orgIncumbents.orgId, orgId)).limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    orgId: r.orgId,
    models: Array.isArray(r.models) ? (r.models as string[]) : [],
    other: r.other,
    samplingConsent: r.samplingConsent,
    sampleCapPerCluster: r.sampleCapPerCluster,
    designatedAt: r.designatedAt,
  };
}

export async function upsertOrgIncumbents(
  db: PotionDb,
  input: { orgId: string; models: string[]; other: string | null; samplingConsent: boolean },
): Promise<OrgIncumbents> {
  const now = new Date();
  await db
    .insert(orgIncumbents)
    .values({ orgId: input.orgId, models: input.models, other: input.other, samplingConsent: input.samplingConsent, designatedAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: orgIncumbents.orgId,
      set: { models: input.models, other: input.other, samplingConsent: input.samplingConsent, updatedAt: now },
    });
  return (await getOrgIncumbents(db, input.orgId))!;
}
