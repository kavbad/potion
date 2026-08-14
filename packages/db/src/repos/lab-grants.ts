// Lab Step 10: superpower grants — the ROUTE-FACING surface. STRUCTURALLY
// token-free: every SELECT here uses the explicit STATUS_COLUMNS projection,
// which excludes token_envelope / refresh_envelope entirely — a token cannot
// leak through a field the query never fetched (custody enforcement 1 of 3;
// the query-shape meta-test in lab-grants.test.ts pins this file's source).
// The ONLY envelope read is repos/lab-grants-runtime.ts (worker-fenced); the
// ONLY decrypt path is @potion/custody's openGrantToken. Writes may CARRY
// sealed envelopes in (inserting is not reading); nothing here returns one.
import { and, eq, sql } from 'drizzle-orm';
import { labSuperpowerGrants } from '../schema.js';
import type { PotionDb } from '../db.js';

/** What routes may see: everything about a grant EXCEPT the sealed tokens. */
export interface LabGrantStatusRow {
  id: string;
  connectorId: string;
  superpowerId: string;
  scopesGranted: string[];
  tokenExpiresAt: Date | null;
  status: 'active' | 'expired' | 'revoked';
  grantedBy: string;
  createdAt: Date;
  updatedAt: Date;
  revokedAt: Date | null;
}

// The projection IS the enforcement: no envelope column appears here.
const STATUS_COLUMNS = {
  id: labSuperpowerGrants.id,
  connectorId: labSuperpowerGrants.connectorId,
  superpowerId: labSuperpowerGrants.superpowerId,
  scopesGranted: labSuperpowerGrants.scopesGranted,
  tokenExpiresAt: labSuperpowerGrants.tokenExpiresAt,
  status: labSuperpowerGrants.status,
  grantedBy: labSuperpowerGrants.grantedBy,
  createdAt: labSuperpowerGrants.createdAt,
  updatedAt: labSuperpowerGrants.updatedAt,
  revokedAt: labSuperpowerGrants.revokedAt,
};

export async function listLabGrants(db: PotionDb, orgId: string): Promise<LabGrantStatusRow[]> {
  return db
    .select(STATUS_COLUMNS)
    .from(labSuperpowerGrants)
    .where(eq(labSuperpowerGrants.orgId, orgId));
}

export async function getLabGrant(
  db: PotionDb,
  orgId: string,
  connectorId: string,
): Promise<LabGrantStatusRow | null> {
  const rows = await db
    .select(STATUS_COLUMNS)
    .from(labSuperpowerGrants)
    .where(
      and(eq(labSuperpowerGrants.orgId, orgId), eq(labSuperpowerGrants.connectorId, connectorId)),
    )
    .limit(1);
  return rows[0] ?? null;
}

export interface UpsertLabGrantInput {
  id: string;
  orgId: string;
  connectorId: string;
  superpowerId: string;
  scopesGranted: string[];
  /** Sealed by @potion/custody sealEnvelope BEFORE this call — this repo
   * never sees plaintext and never decrypts. */
  tokenEnvelope: string;
  refreshEnvelope?: string | null;
  tokenExpiresAt?: Date | null;
  grantedBy: string;
}

/** Insert or REPLACE the org's grant for this connector (unique per pair in
 * v1). A re-grant after expiry or revocation replaces the row wholesale:
 * fresh envelopes, status back to 'active', revoked_at cleared — the healed
 * filament is a new grant, never a resurrected one. */
export async function upsertLabGrant(db: PotionDb, input: UpsertLabGrantInput): Promise<void> {
  await db
    .insert(labSuperpowerGrants)
    .values({
      id: input.id,
      orgId: input.orgId,
      connectorId: input.connectorId,
      superpowerId: input.superpowerId,
      scopesGranted: input.scopesGranted,
      tokenEnvelope: input.tokenEnvelope,
      refreshEnvelope: input.refreshEnvelope ?? null,
      tokenExpiresAt: input.tokenExpiresAt ?? null,
      status: 'active',
      grantedBy: input.grantedBy,
    })
    .onConflictDoUpdate({
      target: [labSuperpowerGrants.orgId, labSuperpowerGrants.connectorId],
      set: {
        id: input.id,
        superpowerId: input.superpowerId,
        scopesGranted: input.scopesGranted,
        tokenEnvelope: input.tokenEnvelope,
        refreshEnvelope: input.refreshEnvelope ?? null,
        tokenExpiresAt: input.tokenExpiresAt ?? null,
        status: 'active',
        grantedBy: input.grantedBy,
        updatedAt: sql`now()`,
        revokedAt: null,
      },
    });
}

/** Typed status transition. 'revoked' is terminal: an active or expired
 * grant may be revoked, but a revoked grant can never be marked 'expired'
 * (a deliberate cut must keep reading as a cut, not decay into a softer
 * state). Returns false when no transition happened. */
export async function markLabGrantStatus(
  db: PotionDb,
  orgId: string,
  connectorId: string,
  status: 'expired' | 'revoked',
  now: Date = new Date(),
): Promise<boolean> {
  const guard =
    status === 'expired'
      ? and(
          eq(labSuperpowerGrants.orgId, orgId),
          eq(labSuperpowerGrants.connectorId, connectorId),
          eq(labSuperpowerGrants.status, 'active'),
        )
      : and(
          eq(labSuperpowerGrants.orgId, orgId),
          eq(labSuperpowerGrants.connectorId, connectorId),
          sql`${labSuperpowerGrants.status} != 'revoked'`,
        );
  const updated = await db
    .update(labSuperpowerGrants)
    .set({
      status,
      updatedAt: now,
      ...(status === 'revoked' ? { revokedAt: now } : {}),
    })
    .where(guard)
    .returning({ id: labSuperpowerGrants.id });
  return updated.length > 0;
}

/** The ONE connection-state derivation for DTOs (harness + run + connector
 * list all call this): a stored 'active' whose token_expires_at has passed
 * reads 'expired' live — display never waits for the worker to notice. */
export function grantConnectionStatus(
  row: Pick<LabGrantStatusRow, 'status' | 'tokenExpiresAt'> | null,
  now: Date = new Date(),
): 'not-connected' | 'connected' | 'expired' | 'revoked' {
  if (row === null) return 'not-connected';
  if (row.status === 'revoked') return 'revoked';
  if (row.status === 'expired') return 'expired';
  if (row.tokenExpiresAt !== null && row.tokenExpiresAt.getTime() <= now.getTime()) {
    return 'expired';
  }
  return 'connected';
}
