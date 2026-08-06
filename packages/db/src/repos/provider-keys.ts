// Thin typed repository for provider_keys (SPEC §8, Phase 5 additive;
// ORG-SCOPED since M2 Wave 1 / ROADMAP #13; REAL CUSTODY since M2 Wave 2 /
// ROADMAP #16, migration 0005). Rows carry the envelope ciphertext (never
// plaintext — see apps/server/src/custody/), the masked display form and a
// sha256 dedup hash. Dedup is per-org: two orgs may register the same raw
// key (custody is per-org — ROADMAP #16).
import { and, asc, eq, isNotNull, ne, sql } from 'drizzle-orm';
import type { PotionDb } from '../db.js';
import {
  providerKeys,
  type NewProviderKey,
  type ProviderKeyRow,
  type ProviderKeyStatus,
} from '../schema.js';

/** Insert a provider-key row (row.orgId is required by the schema). */
export async function insertProviderKey(db: PotionDb, row: NewProviderKey): Promise<void> {
  await db.insert(providerKeys).values(row);
}

/** Dedup lookup by sha256 of the raw key, WITHIN the org. */
export async function getProviderKeyByHash(
  db: PotionDb,
  orgId: string,
  keyHash: string,
): Promise<ProviderKeyRow | null> {
  const rows = await db
    .select()
    .from(providerKeys)
    .where(and(eq(providerKeys.orgId, orgId), eq(providerKeys.keyHash, keyHash)))
    .limit(1);
  return rows[0] ?? null;
}

/** Org-scoped fetch by id — a cross-org id returns null (isolation). */
export async function getProviderKeyById(
  db: PotionDb,
  orgId: string,
  id: string,
): Promise<ProviderKeyRow | null> {
  const rows = await db
    .select()
    .from(providerKeys)
    .where(and(eq(providerKeys.orgId, orgId), eq(providerKeys.id, id)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listProviderKeys(db: PotionDb, orgId: string): Promise<ProviderKeyRow[]> {
  return db
    .select()
    .from(providerKeys)
    .where(eq(providerKeys.orgId, orgId))
    .orderBy(asc(providerKeys.createdAt));
}

/** Serving-eligible rows for an org: status 'active' AND a ciphertext
 * (legacy masked-only rows can never serve). THE serving-path query. */
export async function listServableProviderKeys(
  db: PotionDb,
  orgId: string,
): Promise<ProviderKeyRow[]> {
  return db
    .select()
    .from(providerKeys)
    .where(
      and(
        eq(providerKeys.orgId, orgId),
        eq(providerKeys.status, 'active'),
        isNotNull(providerKeys.ciphertext),
      ),
    )
    .orderBy(asc(providerKeys.createdAt));
}

/** All custodied (non-revoked, ciphertext-bearing) rows across ALL orgs —
 * the master-key rotation sweep set. Intentionally NOT org-scoped: rotation
 * is a platform operator action (apps/server/src/custody/). */
export async function listCustodiedProviderKeys(db: PotionDb): Promise<ProviderKeyRow[]> {
  return db
    .select()
    .from(providerKeys)
    .where(and(isNotNull(providerKeys.ciphertext), ne(providerKeys.status, 'revoked')))
    .orderBy(asc(providerKeys.createdAt));
}

/** Raw-key rotation: swap ciphertext + mask + dedup hash, atomically bump
 * key_version, (re)activate. Org-scoped (a cross-org id no-ops). */
export async function rotateProviderKey(
  db: PotionDb,
  orgId: string,
  id: string,
  next: { ciphertext: string; maskedKey: string; keyHash: string },
): Promise<void> {
  await db
    .update(providerKeys)
    .set({
      ciphertext: next.ciphertext,
      maskedKey: next.maskedKey,
      keyHash: next.keyHash,
      status: 'active',
      keyVersion: sql`${providerKeys.keyVersion} + 1`,
    })
    .where(and(eq(providerKeys.orgId, orgId), eq(providerKeys.id, id)));
}

/** Master-key re-wrap: replace ONLY the ciphertext (same raw key inside). */
export async function rewrapProviderKey(
  db: PotionDb,
  id: string,
  ciphertext: string,
): Promise<void> {
  await db.update(providerKeys).set({ ciphertext }).where(eq(providerKeys.id, id));
}

/** Set the lifecycle status ('active' | 'revoked' | 'rotating'). Org-scoped. */
export async function setProviderKeyStatus(
  db: PotionDb,
  orgId: string,
  id: string,
  status: ProviderKeyStatus,
): Promise<void> {
  await db
    .update(providerKeys)
    .set({ status })
    .where(and(eq(providerKeys.orgId, orgId), eq(providerKeys.id, id)));
}

/** Record a successful validation (POST /api/keys/:id/validate). Org-scoped. */
export async function touchProviderKeyValidation(
  db: PotionDb,
  orgId: string,
  id: string,
  at: Date,
): Promise<void> {
  await db
    .update(providerKeys)
    .set({ lastValidatedAt: at })
    .where(and(eq(providerKeys.orgId, orgId), eq(providerKeys.id, id)));
}
