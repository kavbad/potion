// OIDC SSO routes (M4, ROADMAP #34, SPEC §13.6) — authorization-code flow
// with PKCE for the dashboard. Registered ONLY when the OIDC env quartet is
// set (server.ts gates on oidcConfigFromEnv) — when unset, /auth/oidc/* is
// a plain 404 and magic-link auth stays the byte-identical M2 default.
//
//   GET /auth/oidc/login
//     Mint state + nonce + PKCE verifier into a 10-min signed cookie
//     (potion_oidc — see ../oidc.ts for the security checklist) and 302 to
//     the IdP's discovered authorization_endpoint.
//   GET /auth/oidc/callback?code&state
//     Verify the state cookie (HMAC + expiry + exact state match → 400),
//     exchange the code at the token endpoint (PKCE verifier,
//     client_secret_post), verify the id_token (RS256 via JWKS + iss/aud/exp
//     + nonce → 401), then map the email claim to a user via the SAME
//     create-or-get + solo-org auto-provisioning the magic-link flow uses
//     (provisionForEmail in ./auth.ts), mint the SAME potion_session cookie,
//     record the auth_events login row (method 'oidc'), and 302 to the
//     dashboard.
//
// SAML + SCIM are deliberately DEFERRED (SPEC §13.6; docs/ENTERPRISE.md):
// OIDC covers the IdPs that matter first. /auth/saml/* and /scim/* stay
// RESERVED (unregistered → 404) so a later build can claim them without
// breaking this contract.
import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { sha256 } from '@potion/core';
import { createSession } from '@potion/db';
import { openAiError } from '../auth.js';
import type { PotionContext } from '../context.js';
import {
  OIDC_STATE_COOKIE,
  OidcError,
  decodeStateCookie,
  discoverOidc,
  encodeStateCookie,
  exchangeCode,
  newOidcFlowState,
  oidcConfigFromEnv,
  pkceChallenge,
  verifyIdToken,
  type OidcConfig,
} from '../oidc.js';
import { SESSION_TTL_MS, provisionForEmail, recordAuthEvent } from './auth.js';
import { SESSION_COOKIE } from '../auth.js';

const OIDC_SCOPE = 'openid email profile';

export interface OidcRouteOptions {
  /** Redirect target after a successful callback (default: request origin
   * root — the dashboard is served same-origin behind the deploy proxy;
   * set POTION_DASHBOARD_URL when it lives on another origin). */
  dashboardUrl?: string;
  /** Test seam: inject a config instead of reading env. */
  config?: OidcConfig;
}

export function registerOidcRoutes(
  app: FastifyInstance,
  ctx: PotionContext,
  opts: OidcRouteOptions = {},
): void {
  const config = opts.config ?? oidcConfigFromEnv();
  if (!config) return; // env unset → routes stay unregistered (404)
  const db = ctx.db.db;

  // ---------- GET /auth/oidc/login ----------
  app.get('/auth/oidc/login', async (req, reply) => {
    const discovery = await discoverOidc(config.issuer);
    const flow = newOidcFlowState();
    reply.header(
      'set-cookie',
      `${OIDC_STATE_COOKIE}=${encodeStateCookie(flow, config.clientSecret)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(
        (flow.expiresAt - Date.now()) / 1000,
      )}`,
    );
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      scope: OIDC_SCOPE,
      state: flow.state,
      nonce: flow.nonce,
      code_challenge: pkceChallenge(flow.verifier),
      code_challenge_method: 'S256',
    });
    return reply.redirect(`${discovery.authorization_endpoint}?${params.toString()}`, 302);
  });

  // ---------- GET /auth/oidc/callback ----------
  app.get('/auth/oidc/callback', async (req, reply) => {
    const clearFlowCookie = () =>
      reply.header(
        'set-cookie',
        `${OIDC_STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
      );
    try {
      const query = req.query as { code?: string; state?: string };
      // State cookie: HMAC + expiry, then the EXACT state match (login-CSRF).
      const flow = decodeStateCookie(req.headers.cookie
        ? parseOidcCookie(req.headers.cookie)
        : undefined, config.clientSecret);
      if (!query.state || query.state !== flow.state) {
        throw new OidcError('OIDC state mismatch — restart the sign-in', 400);
      }
      if (!query.code) {
        throw new OidcError('missing authorization code', 400);
      }
      const discovery = await discoverOidc(config.issuer);
      const idToken = await exchangeCode(config, discovery.token_endpoint, query.code, flow.verifier);
      const claims = await verifyIdToken(idToken, config, discovery.jwks_uri);
      // Nonce: replay protection — must match the value we sent.
      if (claims.nonce !== flow.nonce) {
        throw new OidcError('id_token nonce mismatch', 401);
      }
      const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
      if (!email) {
        throw new OidcError('id_token carries no email claim — enable the email scope at the IdP', 401);
      }

      // SAME provisioning + session semantics as the magic-link verify.
      const { userId, orgId } = await provisionForEmail(db, email);
      const sessionToken = `ps_${randomBytes(32).toString('hex')}`; // identical to magic-link minting
      const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
      await createSession(db, {
        id: `ses-${randomUUID().slice(0, 8)}`,
        userId,
        tokenHash: sha256(sessionToken),
        orgId,
        expiresAt,
      });
      await recordAuthEvent(db, req, {
        orgId,
        kind: 'login',
        method: 'oidc',
        actor: email,
      });

      reply.header('set-cookie', [
        `${OIDC_STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
        `${SESSION_COOKIE}=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
      ]);
      const target =
        opts.dashboardUrl ??
        process.env.POTION_DASHBOARD_URL ??
        `${req.protocol}://${req.headers.host ?? 'localhost:3000'}/`;
      return reply.redirect(target, 302);
    } catch (err) {
      clearFlowCookie();
      if (err instanceof OidcError) {
        return reply
          .code(err.status)
          .send(openAiError(err.message, 'invalid_request_error', err.status === 400 ? 'invalid_state' : 'invalid_token'));
      }
      throw err;
    }
  });
}

/** Extract the OIDC state cookie from a Cookie header. */
function parseOidcCookie(header: string): string | undefined {
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === OIDC_STATE_COOKIE) {
      return decodeURIComponent(part.slice(i + 1).trim());
    }
  }
  return undefined;
}
