// SIGN IN WITH GOOGLE (2026-09-04) — the consumer front door.
//
// WHY THIS IS NOT JUST routes/oidc.ts WITH A GOOGLE ISSUER
// -------------------------------------------------------
// /auth/oidc/* does the whole authorization-code dance in the browser
// against THIS server and plants potion_session on its own origin. That is
// correct for a deployment where the API and the dashboard share a host. It
// is wrong for ours: the browser lives on withpotion.com and this server
// answers on api.withpotion.com (deploy/Caddyfile — two vhosts, deliberately),
// so a cookie set here is a cookie the dashboard can never read. A visitor
// would complete the Google consent, be told "signed in", and land back on
// the landing page still signed out.
//
// So the flow is SPLIT exactly the way the magic link already is:
//
//   the dashboard owns the BROWSER half — it redirects to Google, holds the
//   flow cookie on its own origin, and plants potion_session there
//   (app/api/auth/google/{start,callback});
//
//   this server owns the CREDENTIAL half — everything that needs the client
//   secret, the JWKS, or the database.
//
// Two endpoints, both public, both stateless between calls (the flow state
// travels in the signed cookie the dashboard carries for us):
//
//   POST /auth/google/begin
//     Mint state + nonce + PKCE verifier, sign them into the flow cookie
//     value, and return it alongside the Google authorize URL. Returns no
//     secret: the verifier is worthless without a code and the code is
//     worthless without the verifier.
//   POST /auth/google/complete {code, state, flow}
//     Verify the flow cookie (HMAC + expiry) and the EXACT state match,
//     exchange the code (PKCE), verify the id_token (RS256/JWKS + iss/aud/
//     exp + nonce), REQUIRE email_verified, then provision + mint a session
//     through the identical path the magic link uses, and hand the raw
//     token back for the dashboard to plant.
//
// Registered only when POTION_GOOGLE_CLIENT_ID + POTION_GOOGLE_CLIENT_SECRET
// are set; otherwise both are a plain 404 and GET /auth/providers reports
// google:false so the login page never draws a button that cannot work.
import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sha256 } from '@potion/core';
import { createSession, getUserByEmail, listMembershipsByUser } from '@potion/db';
import { openAiError } from '../auth.js';
import type { PotionContext } from '../context.js';
import {
  OidcError,
  decodeStateCookie,
  discoverOidc,
  encodeStateCookie,
  exchangeCode,
  googleConfigFromEnv,
  newOidcFlowState,
  pkceChallenge,
  verifyIdToken,
  type IdTokenClaims,
  type OidcConfig,
} from '../oidc.js';
import { SESSION_TTL_MS, provisionForEmail, recordAuthEvent, selfServeEnabled } from './auth.js';

/** The cookie the DASHBOARD sets on its own origin to carry the flow. Named
 * here because both halves must agree on it and this is the half that
 * defines the format. */
export const GOOGLE_FLOW_COOKIE = 'potion_google';

/** openid+email+profile only. Potion asks for identity, never for a
 * customer's mail, files, or calendar — which is also why this client needs
 * no Google verification review to go live. */
const GOOGLE_SCOPE = 'openid email profile';

const CompleteBodySchema = z.object({
  code: z.string().min(1).max(4096),
  state: z.string().min(1).max(512),
  flow: z.string().min(1).max(8192),
});

/**
 * The email claim, but only when Google says it verified it.
 *
 * The enterprise OIDC path trusts the IdP's email claim outright, and that
 * is defensible there: the org runs the IdP. Google is a public issuer, so
 * an unverified address on a Google account would otherwise be a way to
 * take over a Potion account by claiming someone else's email. Google sets
 * email_verified true for Gmail and Workspace identities; anything else is
 * refused with a message that says what to do.
 */
export function verifiedEmailFromClaims(claims: IdTokenClaims): string {
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  if (!email) {
    throw new OidcError('Google returned no email for this account', 401);
  }
  if (claims.email_verified !== true) {
    throw new OidcError(
      `Google has not verified ${email} — verify the address with Google, or sign in with an email link instead`,
      403,
    );
  }
  return email;
}

export interface GoogleAuthRouteOptions {
  /** Test seam: inject a config instead of reading env. */
  config?: OidcConfig;
}

export function registerGoogleAuthRoutes(
  app: FastifyInstance,
  ctx: PotionContext,
  opts: GoogleAuthRouteOptions = {},
): void {
  const config = opts.config ?? googleConfigFromEnv();
  if (!config) return; // env unset → 404, and /auth/providers says google:false
  const db = ctx.db.db;

  // ---------- POST /auth/google/begin ----------
  app.post('/auth/google/begin', async (_req, reply) => {
    const discovery = await discoverOidc(config.issuer);
    const flow = newOidcFlowState();
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      scope: GOOGLE_SCOPE,
      state: flow.state,
      nonce: flow.nonce,
      code_challenge: pkceChallenge(flow.verifier),
      code_challenge_method: 'S256',
      // Google-specific, and both are UX rather than security: ask for a
      // stable account chooser rather than silently reusing whichever
      // Google session the browser happens to hold.
      prompt: 'select_account',
    });
    return reply.send({
      authorizeUrl: `${discovery.authorization_endpoint}?${params.toString()}`,
      cookieName: GOOGLE_FLOW_COOKIE,
      flow: encodeStateCookie(flow, config.clientSecret),
      maxAgeSeconds: Math.max(1, Math.floor((flow.expiresAt - Date.now()) / 1000)),
    });
  });

  // ---------- POST /auth/google/complete ----------
  app.post('/auth/google/complete', async (req, reply) => {
    const parsed = CompleteBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(openAiError('code, state and flow are required', 'invalid_request_error', 'invalid_state'));
    }
    try {
      // The flow cookie: HMAC + expiry, then the EXACT state match. Both
      // must hold before a single byte goes to Google (login-CSRF).
      const flow = decodeStateCookie(parsed.data.flow, config.clientSecret);
      if (parsed.data.state !== flow.state) {
        throw new OidcError('sign-in state mismatch — start the Google sign-in again', 400);
      }
      const discovery = await discoverOidc(config.issuer);
      const idToken = await exchangeCode(config, discovery.token_endpoint, parsed.data.code, flow.verifier);
      const claims = await verifyIdToken(idToken, config, discovery.jwks_uri);
      if (claims.nonce !== flow.nonce) {
        throw new OidcError('id_token nonce mismatch', 401);
      }
      const email = verifiedEmailFromClaims(claims);

      // The self-serve gate, identical to the OIDC path: Google verified
      // the address, so enumeration is moot and an unknown identity is
      // refused outright rather than neutrally.
      if (!selfServeEnabled()) {
        const existing = await getUserByEmail(db, email);
        const hasMembership =
          existing !== null && (await listMembershipsByUser(db, existing.id)).length > 0;
        if (!hasMembership) {
          throw new OidcError(
            'no Potion account for this Google address — ask whoever showed you Potion for an invite',
            403,
          );
        }
      }

      // Create-or-get BY EMAIL, which is what makes the two doors lead to
      // one room: someone who signed up with an email link and later clicks
      // Continue with Google lands in the same account, not a duplicate.
      // Both doors prove the same fact — control of that address.
      const { userId, orgId } = await provisionForEmail(db, email);
      const sessionToken = `ps_${randomBytes(32).toString('hex')}`;
      const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
      await createSession(db, {
        id: `ses-${randomUUID().slice(0, 8)}`,
        userId,
        tokenHash: sha256(sessionToken),
        orgId,
        expiresAt,
      });
      await recordAuthEvent(db, req, { orgId, kind: 'login', method: 'google', actor: email });
      return reply.send({ token: sessionToken, email, expiresAt: expiresAt.toISOString() });
    } catch (err) {
      if (err instanceof OidcError) {
        return reply
          .code(err.status)
          .send(
            openAiError(
              err.message,
              'invalid_request_error',
              err.status === 400 ? 'invalid_state' : 'invalid_token',
            ),
          );
      }
      throw err;
    }
  });
}
