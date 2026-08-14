// openGrantToken — THE ONLY decrypt path for superpower grants (Step 10).
// Composes the worker-only envelope read (@potion/db lab-grants-runtime)
// with openEnvelope, so the dependency direction stays custody → db and no
// token-bearing query ever lives beside route code. Import-fenced: the
// fence test fails if apps/server/src/routes/** or apps/dashboard/**
// reference this function or the runtime repo. Plaintext exists only in
// the caller's frames — never in a checkpoint, span, narration, report,
// or response (the redactor + secret gate prove that end-to-end).
import { readGrantEnvelopes, resealGrantToken, type PotionDb } from '@potion/db';
import { openEnvelope, sealEnvelope } from './envelope.js';

export interface OpenGrant {
  connectorId: string;
  superpowerId: string;
  scopesGranted: string[];
  status: 'active' | 'expired' | 'revoked';
  accessToken: string;
  refreshToken: string | null;
  tokenExpiresAt: Date | null;
}

/** Open the org's grant for a connector. Returns null when no grant row
 * exists. The row's TYPED status rides along untouched — callers decide
 * what a non-active grant means (the runtime turns it into a typed tool
 * failure, never a crash and never a silent skip). Throws
 * CustodyDecryptError on tamper or wrong master key. */
export async function openGrantToken(
  db: PotionDb,
  masterKey: Buffer,
  orgId: string,
  connectorId: string,
): Promise<OpenGrant | null> {
  const row = await readGrantEnvelopes(db, orgId, connectorId);
  if (row === null) return null;
  return {
    connectorId: row.connectorId,
    superpowerId: row.superpowerId,
    scopesGranted: row.scopesGranted,
    status: row.status,
    accessToken: openEnvelope(masterKey, row.tokenEnvelope),
    refreshToken: row.refreshEnvelope === null ? null : openEnvelope(masterKey, row.refreshEnvelope),
    tokenExpiresAt: row.tokenExpiresAt,
  };
}

/** Seal and store a refreshed access token (worker refresh path). Returns
 * false when the grant is no longer active — a revocation that raced the
 * refresh wins, and the fresh token is deliberately dropped on the floor. */
export async function sealRefreshedToken(
  db: PotionDb,
  masterKey: Buffer,
  orgId: string,
  connectorId: string,
  accessToken: string,
  tokenExpiresAt: Date | null,
): Promise<boolean> {
  return resealGrantToken(db, orgId, connectorId, sealEnvelope(masterKey, accessToken), tokenExpiresAt);
}
