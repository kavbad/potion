// O1 (Onboarding, 2026-08-27) — the org's interpreted workload. One row per
// org, upserted whole on re-interpretation; the router compiler reads it
// into the document (and the identity hash), so re-describing the product
// mints a new router version.
import { eq } from 'drizzle-orm';
import { routerInterpretations, type RouterInterpretationRow } from '../schema.js';
import type { PotionDb } from '../db.js';

export async function getRouterInterpretation(db: PotionDb, orgId: string): Promise<RouterInterpretationRow | null> {
  const rows = await db.select().from(routerInterpretations).where(eq(routerInterpretations.orgId, orgId)).limit(1);
  return rows[0] ?? null;
}

export async function upsertRouterInterpretation(
  db: PotionDb,
  row: { orgId: string; description: string; summary: string; mix: Array<{ clusterId: string; share: number }>; source: 'model' | 'fallback' },
): Promise<RouterInterpretationRow> {
  const rows = await db
    .insert(routerInterpretations)
    .values({ ...row, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: routerInterpretations.orgId,
      set: { description: row.description, summary: row.summary, mix: row.mix, source: row.source, updatedAt: new Date() },
    })
    .returning();
  return rows[0]!;
}
