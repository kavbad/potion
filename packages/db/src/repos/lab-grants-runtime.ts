// Lab Step 10: the WORKER-ONLY grant read — the only query in the codebase
// that selects the sealed envelope columns. Import-fenced (custody
// enforcement 2 of 3): apps/server/src/routes/** and apps/dashboard/**
// import nothing from this module or from @potion/custody's openGrantToken;
// the fence test reads their source and fails on any reference. Decryption
// does NOT happen here — this returns envelopes; @potion/custody's
// openGrantToken (the single decrypt path) composes this read with
// openEnvelope, keeping the dependency direction custody → db.
import { and, eq } from 'drizzle-orm';
import { labSuperpowerGrants } from '../schema.js';
import type { PotionDb } from '../db.js';

export interface LabGrantEnvelopeRow {
  id: string;
  connectorId: string;
  superpowerId: string;
  scopesGranted: string[];
  tokenEnvelope: string;
  refreshEnvelope: string | null;
  tokenExpiresAt: Date | null;
  status: 'active' | 'expired' | 'revoked';
}

export async function readGrantEnvelopes(
  db: PotionDb,
  orgId: string,
  connectorId: string,
): Promise<LabGrantEnvelopeRow | null> {
  const rows = await db
    .select({
      id: labSuperpowerGrants.id,
      connectorId: labSuperpowerGrants.connectorId,
      superpowerId: labSuperpowerGrants.superpowerId,
      scopesGranted: labSuperpowerGrants.scopesGranted,
      tokenEnvelope: labSuperpowerGrants.tokenEnvelope,
      refreshEnvelope: labSuperpowerGrants.refreshEnvelope,
      tokenExpiresAt: labSuperpowerGrants.tokenExpiresAt,
      status: labSuperpowerGrants.status,
    })
    .from(labSuperpowerGrants)
    .where(
      and(eq(labSuperpowerGrants.orgId, orgId), eq(labSuperpowerGrants.connectorId, connectorId)),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Master-key rotation sweep (CustodyService.rotateMasterKey): every grant
 * row's envelopes, all orgs — grants are custodied rows and rotation must
 * cover them or a rotated master strands every connector. */
export async function listGrantEnvelopesAllOrgs(
  db: PotionDb,
): Promise<Array<{ id: string; orgId: string; tokenEnvelope: string; refreshEnvelope: string | null }>> {
  return db
    .select({
      id: labSuperpowerGrants.id,
      orgId: labSuperpowerGrants.orgId,
      tokenEnvelope: labSuperpowerGrants.tokenEnvelope,
      refreshEnvelope: labSuperpowerGrants.refreshEnvelope,
    })
    .from(labSuperpowerGrants);
}

export async function rewrapGrantEnvelopes(
  db: PotionDb,
  id: string,
  tokenEnvelope: string,
  refreshEnvelope: string | null,
): Promise<void> {
  await db
    .update(labSuperpowerGrants)
    .set({ tokenEnvelope, refreshEnvelope })
    .where(eq(labSuperpowerGrants.id, id));
}

/** Runtime write after a successful refresh: the NEW sealed access token
 * (and expiry) replace the old. Only an 'active' grant reseals — a grant
 * revoked mid-refresh stays revoked (the guard loses the race on purpose). */
export async function resealGrantToken(
  db: PotionDb,
  orgId: string,
  connectorId: string,
  tokenEnvelope: string,
  tokenExpiresAt: Date | null,
  now: Date = new Date(),
): Promise<boolean> {
  const updated = await db
    .update(labSuperpowerGrants)
    .set({ tokenEnvelope, tokenExpiresAt, updatedAt: now })
    .where(
      and(
        eq(labSuperpowerGrants.orgId, orgId),
        eq(labSuperpowerGrants.connectorId, connectorId),
        eq(labSuperpowerGrants.status, 'active'),
      ),
    )
    .returning({ id: labSuperpowerGrants.id });
  return updated.length > 0;
}
