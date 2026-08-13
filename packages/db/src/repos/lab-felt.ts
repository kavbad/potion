// Lab Step 7: felt-sample cache repo — the durable "repeated positions cost
// nothing" store. Keyed by everything that determines what a felt call
// would say: (org, probe content, policy content, frontier row).
import { and, eq } from 'drizzle-orm';
import { labFeltSamples, type LabFeltSampleRow } from '../schema.js';
import type { PotionDb } from '../db.js';

export interface FeltCacheKey {
  orgId: string;
  probeHash: string;
  policyHash: string;
  frontierId: string;
}

export async function getFeltSample(db: PotionDb, key: FeltCacheKey): Promise<LabFeltSampleRow | null> {
  const rows = await db
    .select()
    .from(labFeltSamples)
    .where(
      and(
        eq(labFeltSamples.orgId, key.orgId),
        eq(labFeltSamples.probeHash, key.probeHash),
        eq(labFeltSamples.policyHash, key.policyHash),
        eq(labFeltSamples.frontierId, key.frontierId),
      ),
    );
  return rows[0] ?? null;
}

export async function insertFeltSample(
  db: PotionDb,
  row: typeof labFeltSamples.$inferInsert,
): Promise<void> {
  // Same key re-felt (a race between two sweeps): first write wins — the
  // sample content is a function of the key, so the rows are equivalent.
  await db.insert(labFeltSamples).values(row).onConflictDoNothing();
}
