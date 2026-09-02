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
  /** G1 holdout (0086): explicit consent + capped slice for the randomized
   * incumbent baseline. Off by default, always visible where it acts. */
  holdoutConsent: boolean;
  holdoutRate: number;
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
    holdoutConsent: r.holdoutConsent,
    holdoutRate: r.holdoutRate,
    designatedAt: r.designatedAt,
  };
}

/** G1 holdout config write (settings route). UPDATE-only by design: holdout
 * requires a designated incumbent row to exist — no incumbent, no baseline.
 * Returns false when the org never designated one (the route 409s). */
export async function setHoldoutConfig(
  db: PotionDb,
  orgId: string,
  cfg: { consent: boolean; rate: number },
): Promise<boolean> {
  const rows = await db
    .update(orgIncumbents)
    .set({ holdoutConsent: cfg.consent, holdoutRate: cfg.rate, updatedAt: new Date() })
    .where(eq(orgIncumbents.orgId, orgId))
    .returning({ orgId: orgIncumbents.orgId });
  return rows.length > 0;
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
