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

/** The api-key scope vocabulary (G2.3). Anything outside it is UNRECOGNIZED
 * and fails closed — a typo in the scopes column must never mint an admin
 * credential (the operator-token polarity). */
export const API_KEY_SCOPE_VOCABULARY = ['serve', 'admin'] as const;

/** Parse api_keys.scopes ('+' and whitespace both split, so 'serve+admin'
 * yields [serve, admin]). valid=false when empty or ANY token is outside the
 * vocabulary — callers must treat invalid as serve-only. */
export function parseApiKeyScopes(raw: string): { tokens: string[]; valid: boolean } {
  const tokens = raw.split(/[\s+]+/).filter(Boolean);
  const valid =
    tokens.length > 0 &&
    tokens.every((t) => (API_KEY_SCOPE_VOCABULARY as readonly string[]).includes(t));
  return { tokens, valid };
}

/**
 * G2.3 KEY ROLE SPLIT — the chokepoint. An api-key credential's role derives
 * FROM its scopes: 'admin' only for a VALID scope set carrying the 'admin'
 * token; everything else — the default 'serve', empty, malformed, or any
 * unrecognized token ('serve+admin+root' included) — resolves to 'member',
 * FAIL CLOSED. Member grade keeps serving + org reads + self-service
 * mutations (policy create, workloads, evals, share mint) working; every
 * inline roleAtLeast(org.role,'admin') check now excludes serve keys
 * (incident resolve, incumbent designation, budgets, rubric lifecycle,
 * spend-bearing live sweeps, …). Sessions/dev-bypass/operator are untouched.
 */
export function roleForApiKey(key: ApiKeyRow): Role {
  const { tokens, valid } = parseApiKeyScopes(key.scopes);
  return valid && tokens.includes('admin') ? 'admin' : 'member';
}

/** Pure helper for the hot path: build the OrgContext from an ALREADY
 * fetched api_keys row (auth.ts fetches the row once for policy binding —
 * no second query). */
export function orgContextForApiKey(key: ApiKeyRow): OrgContext {
  return { orgId: key.orgId, role: roleForApiKey(key) };
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
