// OIDC SSO client (M4, ROADMAP #34, SPEC §13.6) — authorization-code flow
// with PKCE (S256) against any OIDC-compliant IdP (Okta / Entra / Google
// Workspace — see docs/ENTERPRISE.md). ZERO added dependencies: discovery +
// token + JWKS are raw fetch(); id_token verification is RS256 via
// node:crypto (JWK → KeyObject via crypto.createPublicKey({format:'jwk'}),
// signature via crypto.verify). `jose` was evaluated and is NOT needed —
// Node ≥20 imports RSA JWKs natively.
//
// Security checklist (all enforced here + routes/oidc.ts):
//   · state   — 128-bit random, carried in a SHORT-LIVED (10 min) SIGNED
//               cookie (HMAC-SHA256 keyed by sha256 of the client secret —
//               no extra env secret required; the cookie is integrity-only,
//               it carries no secrets itself). Callback REQUIRES an exact
//               state match → 400 otherwise (login-CSRF protection).
//   · nonce   — 128-bit random, same cookie; callback REQUIRES the id_token
//               nonce claim to match → 401 (replay protection).
//   · PKCE    — S256 code challenge; the raw verifier never leaves the
//               signed cookie and goes ONLY to the token endpoint.
//   · JWKS    — fetched from the issuer's discovered jwks_uri, cached 10
//               min in-process; one refetch on unknown kid (rotation);
//               alg pinned to RS256 (minimum per contract).
//   · claims  — iss (exact issuer match), aud (must contain client id),
//               exp (60 s leeway) all verified before any session is minted.
//
// Env gating: ALL of POTION_OIDC_ISSUER / POTION_OIDC_CLIENT_ID /
// POTION_OIDC_CLIENT_SECRET / POTION_OIDC_REDIRECT_URI must be set or the
// /auth/oidc/* routes are never registered (404 — magic-link auth is the
// byte-identical M2 default).
import {
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify,
  type JsonWebKey,
} from 'node:crypto';

// ---------------------------------------------------------------------------
// Config + errors
// ---------------------------------------------------------------------------

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** Read the OIDC config from env; null unless ALL four vars are set. */
export function oidcConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OidcConfig | null {
  const issuer = env.POTION_OIDC_ISSUER?.trim();
  const clientId = env.POTION_OIDC_CLIENT_ID?.trim();
  const clientSecret = env.POTION_OIDC_CLIENT_SECRET?.trim();
  const redirectUri = env.POTION_OIDC_REDIRECT_URI?.trim();
  if (!issuer || !clientId || !clientSecret || !redirectUri) return null;
  return { issuer: issuer.replace(/\/$/, ''), clientId, clientSecret, redirectUri };
}

/** OIDC failures carry the HTTP status the callback should answer with. */
export class OidcError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 403 | 502,
  ) {
    super(message);
    this.name = 'OidcError';
  }
}

// ---------------------------------------------------------------------------
// Discovery + JWKS (raw fetch, in-process caches)
// ---------------------------------------------------------------------------

export const OIDC_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes (per contract)

interface DiscoveryDoc {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const discoveryCache = new Map<string, CacheEntry<DiscoveryDoc>>();
const jwksCache = new Map<string, CacheEntry<{ keys: JsonWebKey[] }>>();

/** Test hook: drop the in-process discovery/JWKS caches. */
export function clearOidcCaches(): void {
  discoveryCache.clear();
  jwksCache.clear();
}

async function fetchJson<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: 'application/json' } });
  } catch (cause) {
    throw new OidcError(`OIDC fetch failed for ${url}: ${String(cause)}`, 502);
  }
  if (!res.ok) {
    throw new OidcError(`OIDC fetch ${url} → HTTP ${res.status}`, 502);
  }
  return (await res.json()) as T;
}

/** Discover the IdP endpoints (cached 10 min per issuer). */
export async function discoverOidc(issuer: string): Promise<DiscoveryDoc> {
  const hit = discoveryCache.get(issuer);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const doc = await fetchJson<DiscoveryDoc>(`${issuer}/.well-known/openid-configuration`);
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
    throw new OidcError('OIDC discovery doc is missing required endpoints', 502);
  }
  discoveryCache.set(issuer, { value: doc, expiresAt: Date.now() + OIDC_CACHE_TTL_MS });
  return doc;
}

/** Fetch the IdP's JWKS (cached 10 min per jwks_uri). */
async function fetchJwks(jwksUri: string): Promise<{ keys: JsonWebKey[] }> {
  const hit = jwksCache.get(jwksUri);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const jwks = await fetchJson<{ keys: JsonWebKey[] }>(jwksUri);
  if (!Array.isArray(jwks.keys)) {
    throw new OidcError('OIDC JWKS document is malformed', 502);
  }
  jwksCache.set(jwksUri, { value: jwks, expiresAt: Date.now() + OIDC_CACHE_TTL_MS });
  return jwks;
}

// ---------------------------------------------------------------------------
// id_token verification (RS256 via node:crypto — no deps)
// ---------------------------------------------------------------------------

export interface IdTokenClaims {
  iss: string;
  aud: string | string[];
  exp: number;
  nonce?: string;
  email?: string;
  [claim: string]: unknown;
}

const CLOCK_LEEWAY_S = 60;

function b64urlDecode(seg: string): Buffer {
  return Buffer.from(seg, 'base64url');
}

/**
 * Verify an id_token: RS256 signature against the IdP's JWKS (kid match,
 * one refetch on miss for rotation), then iss/aud/exp claim checks. Returns
 * the validated claims; throws OidcError(401) on ANY verification failure —
 * failures are deliberately indistinguishable beyond the message.
 */
export async function verifyIdToken(
  idToken: string,
  config: OidcConfig,
  jwksUri: string,
): Promise<IdTokenClaims> {
  const parts = idToken.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new OidcError('malformed id_token', 401);
  }
  let header: { alg?: string; kid?: string };
  let claims: IdTokenClaims;
  try {
    header = JSON.parse(b64urlDecode(parts[0]).toString('utf8')) as { alg?: string; kid?: string };
    claims = JSON.parse(b64urlDecode(parts[1]).toString('utf8')) as IdTokenClaims;
  } catch {
    throw new OidcError('malformed id_token', 401);
  }
  // alg pinned to RS256 (contract minimum; no HS*/none downgrade path).
  if (header.alg !== 'RS256') {
    throw new OidcError(`unsupported id_token alg '${header.alg ?? '(none)'}' — RS256 required`, 401);
  }

  let jwks = await fetchJwks(jwksUri);
  let jwk = jwks.keys.find((k) => k.kty === 'RSA' && (header.kid === undefined || k.kid === header.kid));
  if (!jwk) {
    // Unknown kid → ONE refetch (IdP key rotation), then fail.
    jwksCache.delete(jwksUri);
    jwks = await fetchJwks(jwksUri);
    jwk = jwks.keys.find((k) => k.kty === 'RSA' && (header.kid === undefined || k.kid === header.kid));
  }
  if (!jwk) {
    throw new OidcError('no matching RSA key in the IdP JWKS', 401);
  }

  let keyObject;
  try {
    keyObject = createPublicKey({ key: jwk, format: 'jwk' });
  } catch {
    throw new OidcError('unusable RSA JWK from the IdP', 401);
  }
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii');
  const ok = verify('sha256', signed, keyObject, b64urlDecode(parts[2]));
  if (!ok) {
    throw new OidcError('id_token signature verification failed', 401);
  }

  if (claims.iss !== config.issuer) {
    throw new OidcError('id_token iss mismatch', 401);
  }
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(config.clientId)) {
    throw new OidcError('id_token aud does not include this client', 401);
  }
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_LEEWAY_S <= Date.now() / 1000) {
    throw new OidcError('id_token expired', 401);
  }
  return claims;
}

// ---------------------------------------------------------------------------
// Token exchange (authorization code + PKCE verifier, client_secret_post)
// ---------------------------------------------------------------------------

interface TokenResponse {
  id_token?: string;
  access_token?: string;
  [k: string]: unknown;
}

/** Exchange the authorization code at the token endpoint (raw fetch, form
 * body — client_secret_post, supported by Okta/Entra/Google). */
export async function exchangeCode(
  config: OidcConfig,
  tokenEndpoint: string,
  code: string,
  codeVerifier: string,
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.redirectUri,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code_verifier: codeVerifier,
      }).toString(),
    });
  } catch (cause) {
    throw new OidcError(`OIDC token endpoint unreachable: ${String(cause)}`, 502);
  }
  if (!res.ok) {
    throw new OidcError(`OIDC token exchange failed — HTTP ${res.status}`, 401);
  }
  const body = (await res.json().catch(() => null)) as TokenResponse | null;
  if (!body?.id_token) {
    throw new OidcError('OIDC token response carries no id_token', 401);
  }
  return body.id_token;
}

// ---------------------------------------------------------------------------
// state / nonce / PKCE + the short-lived signed state cookie
// ---------------------------------------------------------------------------

export const OIDC_STATE_COOKIE = 'potion_oidc';
export const OIDC_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export interface OidcFlowState {
  state: string;
  nonce: string;
  /** PKCE S256 verifier — goes ONLY to the token endpoint. */
  verifier: string;
  /** Epoch ms after which the flow state is dead. */
  expiresAt: number;
}

export function newOidcFlowState(): OidcFlowState {
  return {
    state: randomBytes(16).toString('base64url'),
    nonce: randomBytes(16).toString('base64url'),
    verifier: randomBytes(32).toString('base64url'),
    expiresAt: Date.now() + OIDC_STATE_TTL_MS,
  };
}

/** PKCE S256 challenge for a verifier. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** The cookie is INTEGRITY-protected only (it carries no secrets worth
 * hiding — the verifier is useless without a matching code, and the code
 * is useless without the verifier). HMAC key derived from the client
 * secret so no extra env secret is required. */
function cookieHmacKey(clientSecret: string): Buffer {
  return createHash('sha256').update(`potion-oidc-state:${clientSecret}`, 'utf8').digest();
}

function sign(value: string, clientSecret: string): string {
  return createHmac('sha256', cookieHmacKey(clientSecret)).update(value, 'utf8').digest('base64url');
}

/** Serialize flow state into the signed cookie value. */
export function encodeStateCookie(flow: OidcFlowState, clientSecret: string): string {
  const payload = Buffer.from(JSON.stringify(flow), 'utf8').toString('base64url');
  return `${payload}.${sign(payload, clientSecret)}`;
}

/** Parse + verify the state cookie: HMAC, expiry, then (in the route) the
 * state match. Throws OidcError(400) — state problems are client errors. */
export function decodeStateCookie(raw: string | undefined, clientSecret: string): OidcFlowState {
  if (!raw) throw new OidcError('missing OIDC flow cookie — restart the sign-in', 400);
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) throw new OidcError('malformed OIDC flow cookie', 400);
  const payload = raw.slice(0, dot);
  const expected = sign(payload, clientSecret);
  const got = raw.slice(dot + 1);
  const a = Buffer.from(got, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new OidcError('OIDC flow cookie signature mismatch', 400);
  }
  let flow: OidcFlowState;
  try {
    flow = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as OidcFlowState;
  } catch {
    throw new OidcError('malformed OIDC flow cookie', 400);
  }
  if (typeof flow.expiresAt !== 'number' || flow.expiresAt <= Date.now()) {
    throw new OidcError('OIDC flow expired — restart the sign-in', 400);
  }
  return flow;
}
