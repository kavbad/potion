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
import { and, asc, eq, isNotNull, isNull as colIsNull, or } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
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

// ─── Internal-row discipline (2026-08-28) ───────────────────────────────
// The Lab materializes ORG-SCOPED policy rows (lab-io at floor ZERO, dial
// pins 'lab-…') and ephemeral keys ('lab-io-…', 'lab-run-…'). Every
// consumer that reached for "the org's policy/keys" via [0] could pick one
// up: the operator's own org showed "quality at or above 0.00" as its rule
// and key minting would have BOUND it. Internal rows are infrastructure —
// these helpers are the one place that knows their shapes, and every
// customer-facing consumer goes through them.

export function isInternalPolicyRow(row: Pick<PolicyRow, 'id' | 'name'>): boolean {
  return (
    row.id.startsWith('pol-lab-') ||
    // The onboarding interpret call's ephemeral-key policy (floor ZERO) —
    // the row that actually hit the operator: EVERY org that described its
    // product minted one as its FIRST policy, and router page, connection
    // page and key mint all read it as the org's rule.
    row.id.startsWith('pol-onb-') ||
    row.name === 'lab-io' ||
    row.name === 'onboarding-io' ||
    row.name.startsWith('lab-')
  );
}

export function isInternalApiKey(row: Pick<ApiKeyRow, 'id' | 'name'>): boolean {
  return (
    row.name.startsWith('lab-') ||
    row.name.startsWith('onb-') ||
    row.id.startsWith('key-lab') ||
    row.id.startsWith('key-onb-')
  );
}

/** The org's CUSTOMER policies, oldest first — internal rows excluded. */
export async function listServingPolicies(db: PotionDb, orgId: string): Promise<PolicyRow[]> {
  return (await listPolicies(db, orgId)).filter((p) => !isInternalPolicyRow(p));
}

/** The org's CUSTOMER keys — internal (lab) keys excluded. */
export async function listServingApiKeys(db: PotionDb, orgId: string): Promise<ApiKeyRow[]> {
  return (await listApiKeys(db, orgId)).filter((k) => !isInternalApiKey(k));
}

/** The org's policy anchor: the earliest LIVE customer key with a policy —
 * internal keys excluded, revoked and expired excluded (a dead onboarding
 * ephemeral must not speak for the org: it printed "floor 0.00" on the
 * first receipt a customer ever sees). */
export async function getFirstServingApiKeyWithPolicy(
  db: PotionDb,
  orgId: string,
): Promise<ApiKeyRow | null> {
  const now = Date.now();
  const rows = await listServingApiKeys(db, orgId);
  return rows
    .filter((k) => k.policyId !== null && k.revokedAt === null && (k.expiresAt === null || k.expiresAt.getTime() > now))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0] ?? null;
}

/** One-shot boot repair: CUSTOMER keys bound to an INTERNAL policy row —
 * the damage the discipline above prevents going forward — are rebound to
 * the org's first serving policy, minting the given default when the org
 * has none. Returns what it repaired so the boot log says it plainly. */
export async function repairInternalPolicyBindings(
  db: PotionDb,
  defaultPolicyConfig: unknown,
): Promise<Array<{ orgId: string; keyId: string; from: string; to: string }>> {
  const repaired: Array<{ orgId: string; keyId: string; from: string; to: string }> = [];
  const allKeys = await db.select().from(apiKeys).where(colIsNull(apiKeys.revokedAt));
  const byOrg = new Map<string, ApiKeyRow[]>();
  for (const k of allKeys as ApiKeyRow[]) {
    if (isInternalApiKey(k) || k.policyId === null) continue;
    const list = byOrg.get(k.orgId) ?? [];
    list.push(k);
    byOrg.set(k.orgId, list);
  }
  for (const [orgId, keys] of byOrg) {
    const policyRows = await listPolicies(db, orgId);
    const internalIds = new Set(policyRows.filter(isInternalPolicyRow).map((p) => p.id));
    const damaged = keys.filter((k) => internalIds.has(k.policyId!));
    if (damaged.length === 0) continue;
    let target = policyRows.find((p) => !isInternalPolicyRow(p)) ?? null;
    if (target === null) {
      const id = `pol-${randomUUID().slice(0, 8)}`;
      await insertPolicy(db, { id, orgId, name: 'default', config: defaultPolicyConfig as PolicyRow['config'] });
      target = (await listPolicies(db, orgId)).find((p) => p.id === id) ?? null;
    }
    if (target === null) continue;
    for (const k of damaged) {
      await updateApiKeyPolicy(db, orgId, k.id, target.id);
      repaired.push({ orgId, keyId: k.id, from: k.policyId!, to: target.id });
    }
  }
  return repaired;
}
