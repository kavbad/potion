// Request auth (SPEC §8 + M2 Wave 2, ROADMAP #14) — resolution order:
//
//   1. Bearer api key (`Authorization: Bearer pk_…`, existing) → sha256 →
//      api_keys row → bound policy + its ORG. Role: 'admin' (Wave-1
//      semantics — org keys carry full org power; Wave-2 #15 adds scopes).
//   2. Session (new, #14): `potion_session` httpOnly cookie (dashboard) OR a
//      `ps_…` bearer token (API clients) → sessions row (unexpired,
//      unrevoked) → resolveOrgContext's session path (org pinned at verify
//      time, role from memberships).
//   3. 401 — EXCEPT the documented dev-mode bypass below.
//
// Tenant contract: authentication IS tenant resolution. Every credential
// resolves to exactly one OrgContext (orgId, userId?, role) and every scoped
// read/write downstream MUST use it. Frontiers/clusters/taxonomy stay
// shared-global by design (ROADMAP #13) and never take orgId.
//
// RBAC (ROADMAP #14): the role comes from OrgContext. Mapping applied to the
// dashboard surface (enforced in routes/dashboard.ts + routes/auth.ts):
//   viewer — read-only: all GET /api/* routes
//   member — + writes: POST /api/keys (key metadata), POST /api/policies,
//            POST /api/workloads
//   admin  — + org administration: POST /auth/invite (and key revoke/rotate,
//            Wave-2 #15). requireRole() below is the route guard helper.
//
// DEV-MODE BYPASS (documented): when the bypass is enabled, an UNAUTHENTICATED
// /api/* request resolves to the default demo org with role 'admin' — this
// keeps the pre-auth local-tool behavior (and the existing tests/walkthrough)
// alive. Enabled when POTION_DEV_AUTH=1, OR when POTION_DEV_AUTH is unset and
// NODE_ENV !== 'production' (tests, local dev). PRODUCTION: set
// NODE_ENV=production and never set POTION_DEV_AUTH=1 — the bypass is then
// OFF by default and /api/* demands a session.
import { sha256, type Policy } from '@potion/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  DEFAULT_ORG_ID,
  findSessionByTokenHash,
  getApiKeyByKeyHash,
  getPolicyById,
  orgContextForApiKey,
  resolveOrgContext,
  type ApiKeyRow,
  type OrgContext,
  type PotionDb,
  type Role,
  type SessionRow,
} from '@potion/db';

export interface AuthResult {
  key: ApiKeyRow;
  /** null when the key has no policy bound (serving is refused with 403). */
  policy: Policy | null;
  policyId: string | null;
  /** Tenant context resolved from the key (M2 #13). */
  org: OrgContext;
}

/** Extract the bearer token, or null. */
export function bearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return m?.[1]?.trim() || null;
}

/** Resolve a bearer token to its key row + bound policy + org. Returns null
 * when the token is missing/unknown — OR when the key is REVOKED or EXPIRED
 * (M2 Wave 2 #15, migration 0005: revoked_at / expires_at enforced here in
 * the auth hot path, so a revoked/expired key 401s everywhere it is used).
 * The policy read is scoped to the key's org, so a key can never resolve
 * another org's policy row. */
export async function authenticate(db: PotionDb, token: string | null): Promise<AuthResult | null> {
  if (!token) return null;
  const key = await getApiKeyByKeyHash(db, sha256(token));
  if (!key) return null;
  // Lifecycle enforcement (hot path): revoked or expired → the credential is
  // dead everywhere (chat AND dashboard surface), indistinguishable from an
  // unknown key (no existence oracle).
  if (key.revokedAt) return null;
  if (key.expiresAt && key.expiresAt.getTime() <= Date.now()) return null;
  const org = orgContextForApiKey(key);
  const row = key.policyId ? await getPolicyById(db, org.orgId, key.policyId) : null;
  return { key, policy: row?.config ?? null, policyId: row?.id ?? null, org };
}

// ---------------------------------------------------------------------------
// Sessions (M2 Wave 2, ROADMAP #14)
// ---------------------------------------------------------------------------

/** httpOnly cookie carrying the dashboard session token (`ps_…`). */
export const SESSION_COOKIE = 'potion_session';

/** Parse a Cookie header into a name → value map (lenient; last wins). */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (name) out[name] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export interface SessionAuthResult {
  session: SessionRow;
  /** Tenant context resolved via resolveOrgContext's session path (org
   * pinned to session.orgId; role from memberships — a membership removal
   * instantly invalidates the session's context). */
  org: OrgContext;
}

/** Resolve a raw session token (`ps_…`) to its live session + org context.
 * Returns null when the token is unknown, expired, revoked, or the user lost
 * membership in the pinned org. */
export async function authenticateSession(
  db: PotionDb,
  token: string | null,
): Promise<SessionAuthResult | null> {
  if (!token) return null;
  const session = await findSessionByTokenHash(db, sha256(token));
  if (!session) return null;
  const org = await resolveOrgContext(db, {
    kind: 'session',
    userId: session.userId,
    orgId: session.orgId,
  });
  if (!org) return null;
  return { session, org };
}

// ---------------------------------------------------------------------------
// Unified request resolution + the dev-mode bypass
// ---------------------------------------------------------------------------

/** How a request authenticated. 'dev' is the dev-mode bypass (see header). */
export type RequestAuth =
  | ({ kind: 'apiKey' } & AuthResult)
  | ({ kind: 'session' } & SessionAuthResult)
  | { kind: 'dev'; org: OrgContext };

/** The documented dev-mode bypass (see file header). POTION_DEV_AUTH=1 forces
 * ON, =0 forces OFF; unset → ON outside production (tests/local dev), OFF in
 * production. */
export function devAuthBypassEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.POTION_DEV_AUTH;
  if (flag !== undefined && flag !== '') return flag === '1' || flag.toLowerCase() === 'true';
  return env.NODE_ENV !== 'production';
}

/**
 * Resolve a dashboard-surface request to its auth context (resolution order:
 * Bearer api key → session bearer/cookie → dev bypass → null). A PRESENT but
 * invalid bearer short-circuits to null (no silent downgrade to cookie/bypass
 * — an explicit credential that fails must fail loudly).
 */
export async function resolveRequestAuth(
  db: PotionDb,
  headers: { authorization?: string | undefined; cookie?: string | undefined },
): Promise<RequestAuth | null> {
  const bearer = bearerToken(headers.authorization);
  if (bearer) {
    const keyAuth = await authenticate(db, bearer);
    if (keyAuth) return { kind: 'apiKey', ...keyAuth };
    const sessionAuth = await authenticateSession(db, bearer);
    if (sessionAuth) return { kind: 'session', ...sessionAuth };
    return null;
  }
  const cookieToken = parseCookies(headers.cookie)[SESSION_COOKIE];
  if (cookieToken) {
    const sessionAuth = await authenticateSession(db, cookieToken);
    if (sessionAuth) return { kind: 'session', ...sessionAuth };
  }
  if (devAuthBypassEnabled()) {
    // Dev-mode bypass (documented): unauthenticated /api/* traffic behaves as
    // the pre-auth local tool — the default org with full power.
    return { kind: 'dev', org: { orgId: DEFAULT_ORG_ID, role: 'admin' } };
  }
  return null;
}

// ---------------------------------------------------------------------------
// RBAC (M2 Wave 2, ROADMAP #14)
// ---------------------------------------------------------------------------

/** Role power ranking: viewer < member < admin. */
export const ROLE_RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2 };

export function roleAtLeast(role: Role, required: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[required];
}

// ---------------------------------------------------------------------------
// Api-key scopes (M2 Wave 2, ROADMAP #15, migration 0005) — MINIMAL v1.
//
// Vocabulary (space-separated tokens in api_keys.scopes):
//   'serve'       (DEFAULT) — the key serves /v1/chat/completions and keeps
//                 the Wave-1 dashboard-surface behavior (org keys carry full
//                 org power there — unchanged, documented above).
//   'serve+admin' — additionally may perform key-LIFECYCLE admin mutations
//                 (provider-key rotate/revoke, api-key create/revoke) via
//                 requireRole('admin') routes.
//
// Enforcement point v1: requireRole('admin') only. Session/dev-bypass
// credentials are unaffected (their role comes from memberships / the
// bypass). Deliberately NOT enforced on the serving path — a 'serve' key
// must never lose chat access because of an admin-scoping change.
// ---------------------------------------------------------------------------

/** Parse api_keys.scopes into a token set ('+' and whitespace both split, so
 * 'serve+admin' yields {serve, admin}). */
export function apiKeyScopes(key: ApiKeyRow): Set<string> {
  return new Set(key.scopes.split(/[\s+]+/).filter(Boolean));
}

/** True when an api-key credential carries the 'admin' scope. */
export function apiKeyHasAdminScope(key: ApiKeyRow): boolean {
  return apiKeyScopes(key).has('admin');
}

/**
 * requireRole(required) — route guard helper (Fastify preHandler). Reads the
 * OrgContext the dashboard auth hook attached to the request
 * (req.potionOrg); 401 when no context, 403 when the role is below the
 * requirement. Mapping documented in the file header + routes/dashboard.ts.
 */
export function requireRole(required: Role) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const org = req.potionOrg ?? null;
    if (!org) {
      return reply
        .code(401)
        .send(openAiError('authentication required', 'invalid_request_error', 'authentication_required'));
    }
    if (!roleAtLeast(org.role, required)) {
      return reply.code(403).send(
        openAiError(
          `role '${org.role}' may not perform this action — requires '${required}'`,
          'invalid_request_error',
          'insufficient_role',
        ),
      );
    }
    // Api-key scope check (M2 #15, v1 — see apiKeyScopes above): admin-level
    // mutations additionally demand the 'admin' scope when the credential is
    // an org api key. Sessions/dev bypass are unaffected.
    if (required === 'admin' && req.potionAuth?.kind === 'apiKey') {
      if (!apiKeyHasAdminScope(req.potionAuth.key)) {
        return reply.code(403).send(
          openAiError(
            "api key scope 'serve' may not perform admin actions — mint a 'serve+admin' key",
            'invalid_request_error',
            'insufficient_scope',
          ),
        );
      }
    }
    return undefined;
  };
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Org context attached by the dashboard auth hook (server.ts) for /api/*
     * routes, or by an auth route's own resolution. null until resolved. */
    potionOrg: OrgContext | null;
    /** Full auth detail behind potionOrg (kind: apiKey | session | dev). */
    potionAuth: RequestAuth | null;
  }
}

/**
 * The dashboard-surface guard (M2 Wave 2, ROADMAP #14): every /api/* route
 * requires a resolved auth context (resolution order: Bearer api key →
 * session → dev bypass → 401) and attaches it to the request as
 * req.potionAuth / req.potionOrg. Write methods (non-GET/HEAD) additionally
 * require role ≥ member — viewer is read-only (route-level admin
 * requirements use requireRole). /v1/* and /auth/* are NOT touched: chat
 * stays api-key-only and auth routes do their own resolution.
 */
export function dashboardAuthHook(ctx: { db: { db: PotionDb } }) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    if (!req.url.startsWith('/api/')) return undefined;
    // ---- M4 #31 share (m4-playground) ----
    // Public share endpoints (SPEC §13.3) are session-free BY CONTRACT: the
    // share token IS the credential (sha256-hashed at rest, revocable, kind-
    // checked; unknown/revoked → uniform 404). Everything else under /api/
    // still demands a resolved auth context below.
    if (req.url.startsWith('/api/public/')) return undefined;
    // ---- end M4 #31 share exemption ----
    // ---- M4b #32 leaderboard (m4b-research) ----
    // The public leaderboard (SPEC §13.4) is session-free BY CONTRACT: it
    // carries only platform-level LIVE-provenance frontier recipes (never
    // org data, never mock numbers). Everything else under /api/ still
    // demands a resolved auth context below.
    if (req.url === '/api/leaderboard' || req.url.startsWith('/api/leaderboard?')) {
      return undefined;
    }
    // ---- end M4b #32 leaderboard exemption ----
    const auth = await resolveRequestAuth(ctx.db.db, req.headers);
    if (!auth) {
      return reply.code(401).send(
        openAiError(
          'authentication required — sign in via POST /auth/request-link (or set POTION_DEV_AUTH=1 in dev)',
          'invalid_request_error',
          'authentication_required',
        ),
      );
    }
    req.potionAuth = auth;
    req.potionOrg = auth.org;
    const write = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';
    if (write && !roleAtLeast(auth.org.role, 'member')) {
      return reply.code(403).send(
        openAiError(
          `role '${auth.org.role}' is read-only — writes require 'member' or 'admin'`,
          'invalid_request_error',
          'insufficient_role',
        ),
      );
    }
    return undefined;
  };
}

/** OpenAI-shaped error body: { error: { message, type, param, code } }
 * (M3 #25 added `param` for full parity — always present, null when n/a). */
export function openAiError(
  message: string,
  type: string,
  code: string | null = null,
  param: string | null = null,
): { error: { message: string; type: string; param: string | null; code: string | null } } {
  return { error: { message, type, param, code } };
}
