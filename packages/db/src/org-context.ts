// Tenant request context (M2 Wave 1, ROADMAP #13) — the CONTRACT Wave-2
// agents (auth #14, key custody #15/#16, metering #17/#18) build on.
//
//   OrgContext         — { orgId, userId?, role } attached to every request
//   resolveOrgContext  — resolve an api key OR a session to an OrgContext
//   Role               — 'admin' | 'member' | 'viewer' (memberships.role)
//
// Resolution paths (union param — Wave-2 auth adds session-based resolution
// alongside api-key resolution; both are first-class here):
//   · apiKey:  raw bearer token → sha256 → api_keys row → its org.
//              Wave-1 semantics: org API keys carry FULL org power, so the
//              role is 'admin' and userId is absent (no human identity).
//              Wave-2 (#15) adds key scopes/roles — extend OrgCredential,
//              not the call sites.
//   · session: a user identity (Wave-2 #14 will mint sessions; the lookup
//              here is already real): membership (orgId, userId) → role, or
//              the user's first membership when orgId is not pinned.
import { sha256 } from '@potion/core';
import type { PotionDb } from './db.js';
import { getApiKeyByKeyHash } from './repos/api-keys.js';
import { getMembershipRole, listMembershipsByUser } from './repos/memberships.js';
import type { ApiKeyRow, Role } from './schema.js';

/** Tenant identity attached to every authenticated request. */
export interface OrgContext {
  orgId: string;
  /** Present only for user-backed resolution (sessions). Api keys have no
   * human identity in Wave 1. */
  userId?: string;
  role: Role;
}

/** Credential union accepted by resolveOrgContext. Wave-2 auth (#14) mints
 * sessions; today only the apiKey path is exercised in production. */
export type OrgCredential =
  | { kind: 'apiKey'; /** raw bearer token (pk_…) */ apiKey: string }
  | { kind: 'session'; userId: string; /** pin an org, else the user's first membership wins */ orgId?: string };

/** Wave-1 role for org API keys: full org power (documented — Wave-2 #15
 * introduces scoped key roles). */
export const API_KEY_ROLE: Role = 'admin';

/** Pure helper for the hot path: build the OrgContext from an ALREADY
 * fetched api_keys row (auth.ts fetches the row once for policy binding —
 * no second query). */
export function orgContextForApiKey(key: ApiKeyRow): OrgContext {
  return { orgId: key.orgId, role: API_KEY_ROLE };
}

/**
 * Resolve a credential (api key OR session) to its tenant context. Returns
 * null when the credential is unknown / has no org. This is THE canonical
 * tenant-resolution entry point exported for Wave 2.
 */
export async function resolveOrgContext(
  db: PotionDb,
  cred: OrgCredential,
): Promise<OrgContext | null> {
  if (cred.kind === 'apiKey') {
    const key = await getApiKeyByKeyHash(db, sha256(cred.apiKey));
    return key ? orgContextForApiKey(key) : null;
  }
  // Session path (Wave-2 #14 mints sessions; the membership lookup is real):
  if (cred.orgId !== undefined) {
    const role = await getMembershipRole(db, cred.orgId, cred.userId);
    return role ? { orgId: cred.orgId, userId: cred.userId, role } : null;
  }
  const first = (await listMembershipsByUser(db, cred.userId))[0];
  return first ? { orgId: first.orgId, userId: cred.userId, role: first.role } : null;
}
