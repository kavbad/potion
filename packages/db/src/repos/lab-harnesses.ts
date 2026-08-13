// Lab Step 8: harness catalog repo — org-scoped reads/writes; cross-org
// ids are 404-shaped nulls, never existence oracles.
import { and, desc, eq } from 'drizzle-orm';
import { labHarnesses, type LabHarnessRow } from '../schema.js';
import type { PotionDb } from '../db.js';

export async function upsertLabHarness(
  db: PotionDb,
  row: typeof labHarnesses.$inferInsert,
): Promise<void> {
  await db
    .insert(labHarnesses)
    .values(row)
    .onConflictDoUpdate({
      target: [labHarnesses.orgId, labHarnesses.harnessHash],
      set: { name: row.name, specText: row.specText, sidecar: row.sidecar, clusterId: row.clusterId },
    });
}

export async function getLabHarness(
  db: PotionDb,
  orgId: string,
  harnessHash: string,
): Promise<LabHarnessRow | null> {
  const rows = await db
    .select()
    .from(labHarnesses)
    .where(and(eq(labHarnesses.orgId, orgId), eq(labHarnesses.harnessHash, harnessHash)));
  return rows[0] ?? null;
}

export async function listLabHarnesses(db: PotionDb, orgId: string): Promise<LabHarnessRow[]> {
  return db
    .select()
    .from(labHarnesses)
    .where(eq(labHarnesses.orgId, orgId))
    .orderBy(desc(labHarnesses.createdAt));
}
