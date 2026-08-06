// Thin typed repositories for api_keys + policies (SPEC §7/§8, Phase 5
// additive; ORG-SCOPED since M2 Wave 1 / ROADMAP #13). A policy is "per api
// key": every key owns its policy row(s) and api_keys.policy_id points at the
// currently bound one.
//
// Tenant contract (breaking, documented for Wave 2): every read/write EXCEPT
// the auth identity anchor (getApiKeyByKeyHash — bearer tokens resolve
// globally to find their org) takes orgId explicitly. There are NO unscoped
// list/get/update queries; insert rows carry org_id NOT NULL via NewApiKey /
// NewPolicy.
import { and, asc, eq, isNotNull, or } from 'drizzle-orm';
import type { PotionDb } from '../db.js';
import {
  apiKeys,
  policies,
  type ApiKeyRow,
  type NewApiKey,
  type NewPolicy,
  type PolicyRow,
} from '../schema.js';

// ---- api_keys ----

/** Insert a key row (row.orgId is required by the schema). */
export async function insertApiKey(db: PotionDb, key: NewApiKey): Promise<void> {
  await db.insert(apiKeys).values(key);
}

/** AUTH IDENTITY ANCHOR — intentionally NOT org-scoped: a bearer token is
 * resolved globally (key_hash is globally unique) and the resulting row's
 * org_id IS the tenant. Everything downstream of auth must use that orgId. */
export async function getApiKeyByKeyHash(
  db: PotionDb,
  keyHash: string,
): Promise<ApiKeyRow | null> {
  const rows = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash)).limit(1);
  return rows[0] ?? null;
}

export async function getApiKeyById(
  db: PotionDb,
  orgId: string,
  id: string,
): Promise<ApiKeyRow | null> {
  const rows = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.orgId, orgId), eq(apiKeys.id, id)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listApiKeys(db: PotionDb, orgId: string): Promise<ApiKeyRow[]> {
  return db.select().from(apiKeys).where(eq(apiKeys.orgId, orgId)).orderBy(asc(apiKeys.createdAt));
}

/** First key IN THIS ORG with a policy bound (creation order) — the
 * dashboard's default "customer" when no bearer token is supplied. */
export async function getFirstApiKeyWithPolicy(
  db: PotionDb,
  orgId: string,
): Promise<ApiKeyRow | null> {
  const rows = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.orgId, orgId), isNotNull(apiKeys.policyId)))
    .orderBy(asc(apiKeys.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/** Bind a policy row to an api key (org-scoped: a cross-org key id no-ops). */
export async function updateApiKeyPolicy(
  db: PotionDb,
  orgId: string,
  apiKeyId: string,
  policyId: string | null,
): Promise<void> {
  await db
    .update(apiKeys)
    .set({ policyId })
    .where(and(eq(apiKeys.orgId, orgId), eq(apiKeys.id, apiKeyId)));
}

/** Revoke an api key (M2 Wave 2, ROADMAP #15): sets revoked_at — the auth
 * hot path (apps/server/src/auth.ts authenticate) 401s it immediately.
 * Org-scoped: a cross-org key id no-ops. */
export async function revokeApiKey(
  db: PotionDb,
  orgId: string,
  apiKeyId: string,
  at: Date,
): Promise<void> {
  await db
    .update(apiKeys)
    .set({ revokedAt: at })
    .where(and(eq(apiKeys.orgId, orgId), eq(apiKeys.id, apiKeyId)));
}

// ---- policies ----

/** Insert a policy row (row.orgId is required by the schema). */
export async function insertPolicy(db: PotionDb, policy: NewPolicy): Promise<void> {
  await db.insert(policies).values(policy);
}

export async function getPolicyById(
  db: PotionDb,
  orgId: string,
  id: string,
): Promise<PolicyRow | null> {
  const rows = await db
    .select()
    .from(policies)
    .where(and(eq(policies.orgId, orgId), eq(policies.id, id)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listPolicies(db: PotionDb, orgId: string): Promise<PolicyRow[]> {
  return db.select().from(policies).where(eq(policies.orgId, orgId)).orderBy(asc(policies.createdAt));
}

/** Resolve an X-Potion-Policy override reference (M4 #30, SPEC §13.1): a
 * policy ID *or* a policy NAME, always scoped to the caller's org — a ref
 * that only exists in another org resolves to null (no existence oracle).
 * Id match wins over name match; name collisions resolve to the earliest
 * created row (deterministic). */
export async function resolvePolicyRef(
  db: PotionDb,
  orgId: string,
  ref: string,
): Promise<PolicyRow | null> {
  const rows = await db
    .select()
    .from(policies)
    .where(
      and(eq(policies.orgId, orgId), or(eq(policies.id, ref), eq(policies.name, ref))),
    )
    .orderBy(asc(policies.createdAt));
  return rows.find((r) => r.id === ref) ?? rows[0] ?? null;
}
