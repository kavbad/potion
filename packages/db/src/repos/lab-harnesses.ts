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

/** W3 — record a DESCENDANT generation: same family, parent linked, typed
 * mutation carried. The parent row is never edited here; promotion stamps
 * supersededBy separately. */
export async function insertDescendantHarness(
  db: PotionDb,
  row: typeof labHarnesses.$inferInsert & { familyId: string; parentHash: string; generation: number },
): Promise<void> {
  await db.insert(labHarnesses).values(row).onConflictDoNothing();
}

/** W3 — promotion: the parent generation points at its successor. The only
 * field a generation row ever gains after birth. */
export async function markSuperseded(
  db: PotionDb,
  orgId: string,
  harnessHash: string,
  supersededBy: string,
): Promise<void> {
  await db
    .update(labHarnesses)
    .set({ supersededBy })
    .where(and(eq(labHarnesses.orgId, orgId), eq(labHarnesses.harnessHash, harnessHash)));
}

/** W3 — adopt a pre-W3 harness into a family of one (idempotent: only when
 * familyId is null). Returns the familyId. */
export async function ensureHarnessFamily(
  db: PotionDb,
  orgId: string,
  harnessHash: string,
): Promise<string | null> {
  const row = await getLabHarness(db, orgId, harnessHash);
  if (row === null) return null;
  if (row.familyId !== null) return row.familyId;
  const familyId = `fam-${harnessHash.slice(0, 12)}`;
  await db
    .update(labHarnesses)
    .set({ familyId })
    .where(and(eq(labHarnesses.orgId, orgId), eq(labHarnesses.harnessHash, harnessHash)));
  return familyId;
}

/** W3 — the family's generations, oldest first (the lineage view). */
export async function listFamilyGenerations(
  db: PotionDb,
  orgId: string,
  familyId: string,
): Promise<LabHarnessRow[]> {
  return db
    .select()
    .from(labHarnesses)
    .where(and(eq(labHarnesses.orgId, orgId), eq(labHarnesses.familyId, familyId)))
    .orderBy(labHarnesses.generation);
}
