// Frontier pins (R7, migration 0053) — the customer's right to say
// "don't move under me without telling me".
//
// A pin names one exact frontier row per (org, cluster, instrument). The
// serving read consults it BEFORE the latest-version query, so a published
// movement cannot change a pinned org's served point. Releasing is a delete:
// absence is the default and means "serve the newest", byte-for-byte the
// behavior every org had before pins existed.
import { and, eq } from 'drizzle-orm';
import type { PotionDb } from '../db.js';
import { frontierPins, type FrontierPinRow } from '../schema.js';

export type Instrument = 'default' | 'tools' | 'vision' | 'audio';

export async function getFrontierPin(
  db: PotionDb,
  orgId: string,
  clusterId: string,
  instrument: Instrument = 'default',
): Promise<FrontierPinRow | null> {
  const rows = await db
    .select()
    .from(frontierPins)
    .where(
      and(
        eq(frontierPins.orgId, orgId),
        eq(frontierPins.clusterId, clusterId),
        eq(frontierPins.instrument, instrument),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function listFrontierPins(db: PotionDb, orgId: string): Promise<FrontierPinRow[]> {
  return db.select().from(frontierPins).where(eq(frontierPins.orgId, orgId));
}

/** Pin (or re-pin) a cluster to an exact frontier row. */
export async function setFrontierPin(
  db: PotionDb,
  pin: {
    orgId: string;
    clusterId: string;
    instrument?: Instrument;
    frontierId: string;
    frontierVersion: number;
    pinnedBy: string;
  },
): Promise<FrontierPinRow> {
  const values = {
    orgId: pin.orgId,
    clusterId: pin.clusterId,
    instrument: pin.instrument ?? 'default',
    frontierId: pin.frontierId,
    frontierVersion: pin.frontierVersion,
    pinnedBy: pin.pinnedBy,
  };
  const rows = await db
    .insert(frontierPins)
    .values(values)
    .onConflictDoUpdate({
      target: [frontierPins.orgId, frontierPins.clusterId, frontierPins.instrument],
      set: { frontierId: values.frontierId, frontierVersion: values.frontierVersion, pinnedBy: values.pinnedBy },
    })
    .returning();
  return rows[0]!;
}

/** Release a pin. Returns false when there was nothing pinned. */
export async function releaseFrontierPin(
  db: PotionDb,
  orgId: string,
  clusterId: string,
  instrument: Instrument = 'default',
): Promise<boolean> {
  const rows = await db
    .delete(frontierPins)
    .where(
      and(
        eq(frontierPins.orgId, orgId),
        eq(frontierPins.clusterId, clusterId),
        eq(frontierPins.instrument, instrument),
      ),
    )
    .returning({ orgId: frontierPins.orgId });
  return rows.length > 0;
}
