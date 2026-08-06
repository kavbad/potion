// Share-token repository (M4, ROADMAP #31, SPEC §13.3, migration 0009).
// share_tokens rows are org-scoped tenant data: mint/list/revoke always
// filter org_id, so cross-org enumeration is impossible by construction. The
// public lookup (findShareTokenByHash) is intentionally NOT org-scoped — the
// sha256 token_hash IS the credential — but it only ever resolves a row the
// caller already holds the raw token for.
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { PotionDb } from '../db.js';
import { shareTokens, type NewShareToken, type ShareTokenRow } from '../schema.js';

/** Mint one share link. Returns the inserted row (id comes from the db). */
export async function insertShareToken(db: PotionDb, row: NewShareToken): Promise<ShareTokenRow> {
  const inserted = await db.insert(shareTokens).values(row).returning();
  return inserted[0]!;
}

/** All share tokens of one org, newest first (revoked included — the list
 * endpoint shows their revoked state). */
export async function listShareTokens(db: PotionDb, orgId: string): Promise<ShareTokenRow[]> {
  return db
    .select()
    .from(shareTokens)
    .where(eq(shareTokens.orgId, orgId))
    .orderBy(desc(shareTokens.createdAt));
}

/** Public-endpoint lookup by the sha256 of the raw token. Returns the row
 * regardless of revoked state — the caller decides the 404 mapping. */
export async function findShareTokenByHash(
  db: PotionDb,
  tokenHash: string,
): Promise<ShareTokenRow | null> {
  const rows = await db
    .select()
    .from(shareTokens)
    .where(eq(shareTokens.tokenHash, tokenHash))
    .limit(1);
  return rows[0] ?? null;
}

/** Revoke a live token (admin). Atomic: only updates a row that belongs to
 * the org AND is still live, so a double-revoke or a cross-org id returns
 * null (both surface as 404 — neither leaks the row's existence). */
export async function revokeShareToken(
  db: PotionDb,
  orgId: string,
  id: string,
): Promise<ShareTokenRow | null> {
  const updated = await db
    .update(shareTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(eq(shareTokens.id, id), eq(shareTokens.orgId, orgId), isNull(shareTokens.revokedAt)),
    )
    .returning();
  return updated[0] ?? null;
}
