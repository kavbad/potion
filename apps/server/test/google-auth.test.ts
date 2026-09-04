// SIGN IN WITH GOOGLE (2026-09-04) — the full begin/complete flow against a
// LOCAL mock IdP that speaks real OIDC: discovery, JWKS, RS256 id_tokens.
//
// The security properties are inherited from src/oidc.ts and already pinned
// by oidc.test.ts, so this file tests what is NEW and what could plausibly
// rot:
//   · begin hands back an authorize URL with state/nonce/S256 challenge and
//     a signed flow value the SERVER minted (the dashboard only carries it)
//   · complete: happy path → session token + auth_events row with method
//     'google' (not 'oidc' — the audit trail names the door)
//   · complete: state mismatch → 400; nonce mismatch → 401
//   · complete: email_verified missing or false → 403, EVEN THOUGH the
//     id_token signature is perfectly valid. This is the one rule Google's
//     path adds over the enterprise path, and the one an unverified account
//     would otherwise walk through.
//   · ONE ROOM, TWO DOORS: an account created by the magic link is the SAME
//     account when its owner later signs in with Google
//   · env unset → both routes 404 and /auth/providers says google:false, so
//     the login page never draws a button that leads nowhere
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { getUserByEmail, listAuthEvents } from '@potion/db';
import { buildServer } from '../src/server.js';
import { clearOidcCaches, decodeStateCookie, pkceChallenge } from '../src/oidc.js';

const CLIENT_ID = 'potion-google-test';
const CLIENT_SECRET = 'google-test-secret';
const REDIRECT = 'https://withpotion.com/api/auth/google/callback';

let idp: Server;
let idpBase = '';
let privateKey: KeyObject;
let jwk: Record<string, unknown>;
/** Knobs the tests set before a /complete. */
let nextNonce = '';
let nextEmail = 'gsignin@example.com';
let nextEmailVerified: unknown = true;
let lastTokenForm: Record<string, string> = {};

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url');
}

function mintIdToken(claims: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', kid: 'g-key-1', typ: 'JWT' }));
  const payload = b64url(JSON.stringify(claims));
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), privateKey);
  return `${header}.${payload}.${b64url(signature)}`;
}

beforeAll(async () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = pair.privateKey;
  const pub = pair.publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  jwk = { ...pub, kid: 'g-key-1', alg: 'RS256', use: 'sig' };

  idp = createServer((req, res) => {
    const url = req.url ?? '';
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.startsWith('/.well-known/openid-configuration')) {
      return json(200, {
        issuer: idpBase,
        authorization_endpoint: `${idpBase}/o/oauth2/v2/auth`,
        token_endpoint: `${idpBase}/token`,
        jwks_uri: `${idpBase}/jwks`,
      });
    }
    if (url.startsWith('/jwks')) return json(200, { keys: [jwk] });
    if (url.startsWith('/token') && req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        lastTokenForm = Object.fromEntries(
          new URLSearchParams(Buffer.concat(chunks).toString()).entries(),
        );
        const now = Math.floor(Date.now() / 1000);
        const claims: Record<string, unknown> = {
          iss: idpBase,
          aud: CLIENT_ID,
          sub: 'google-sub-1',
          email: nextEmail,
          nonce: nextNonce,
          iat: now,
          exp: now + 600,
        };
        // undefined means "Google sent no email_verified claim at all",
        // which is a distinct case from sending it as false.
        if (nextEmailVerified !== undefined) claims.email_verified = nextEmailVerified;
        return json(200, { id_token: mintIdToken(claims), token_type: 'Bearer', expires_in: 3600 });
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => idp.listen(0, '127.0.0.1', resolve));
  idpBase = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => idp.close((err) => (err ? reject(err) : resolve())));
});

describe('Sign in with Google (configured)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    clearOidcCaches();
    app = await buildServer({
      seed: false,
      googleAuth: {
        config: { issuer: idpBase, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT },
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  interface Flow {
    flow: string;
    state: string;
    nonce: string;
    verifier: string;
    authorizeUrl: string;
  }

  async function begin(): Promise<Flow> {
    const res = await app.inject({ method: 'POST', url: '/auth/google/begin', payload: {} });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { authorizeUrl: string; flow: string; cookieName: string; maxAgeSeconds: number };
    expect(body.cookieName).toBe('potion_google');
    expect(body.maxAgeSeconds).toBeGreaterThan(0);
    const decoded = decodeStateCookie(body.flow, CLIENT_SECRET);
    return {
      flow: body.flow,
      state: decoded.state,
      nonce: decoded.nonce,
      verifier: decoded.verifier,
      authorizeUrl: body.authorizeUrl,
    };
  }

  function complete(f: Flow, over: Partial<{ code: string; state: string; flow: string }> = {}) {
    nextNonce = f.nonce;
    return app.inject({
      method: 'POST',
      url: '/auth/google/complete',
      payload: { code: over.code ?? 'mock-code', state: over.state ?? f.state, flow: over.flow ?? f.flow },
    });
  }

  it('begin returns an authorize URL carrying state, nonce and an S256 PKCE challenge', async () => {
    const f = await begin();
    const params = new URL(f.authorizeUrl).searchParams;
    expect(f.authorizeUrl.startsWith(`${idpBase}/o/oauth2/v2/auth?`)).toBe(true);
    expect(params.get('client_id')).toBe(CLIENT_ID);
    expect(params.get('redirect_uri')).toBe(REDIRECT);
    expect(params.get('scope')).toBe('openid email profile');
    expect(params.get('state')).toBe(f.state);
    expect(params.get('nonce')).toBe(f.nonce);
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('code_challenge')).toBe(pkceChallenge(f.verifier));
  });

  it('the scope asks for identity ONLY — never mail, files or calendar', async () => {
    const scope = new URL((await begin()).authorizeUrl).searchParams.get('scope') ?? '';
    // Restricted/sensitive scopes are what drag a client into Google's
    // weeks-long verification review; asking for none is why this ships now.
    for (const sensitive of ['gmail', 'drive', 'calendar', 'contacts', 'spreadsheets']) {
      expect(scope).not.toContain(sensitive);
    }
    expect(scope.split(' ').sort()).toEqual(['email', 'openid', 'profile']);
  });

  it('happy path: session minted, user provisioned, PKCE verifier posted, audit says google', async () => {
    nextEmail = 'gsignin@example.com';
    nextEmailVerified = true;
    const f = await begin();
    const res = await complete(f);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { token: string; email: string };
    expect(body.token.startsWith('ps_')).toBe(true);
    expect(body.email).toBe('gsignin@example.com');

    // The token is a REAL session: it authenticates a subsequent call.
    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: `potion_session=${body.token}` },
    });
    expect(me.statusCode).toBe(200);
    expect((me.json() as { user: { email: string } }).user.email).toBe('gsignin@example.com');

    // PKCE: the verifier posted to /token is the one behind the challenge.
    expect(lastTokenForm.code_verifier).toBe(f.verifier);
    expect(lastTokenForm.grant_type).toBe('authorization_code');
    expect(lastTokenForm.redirect_uri).toBe(REDIRECT);

    const db = app.potion.db.db;
    const user = await getUserByEmail(db, 'gsignin@example.com');
    expect(user).not.toBeNull();
    const orgId = (me.json() as { org: { id: string } }).org.id;
    const events = await listAuthEvents(db, orgId, 10);
    const login = events.find((e) => e.kind === 'login');
    expect(login?.method).toBe('google');
    expect(login?.actor).toBe('gsignin@example.com');
  });

  it('ONE ROOM, TWO DOORS: the email-link account is the SAME account under Google', async () => {
    const shared = 'both-doors@example.com';
    // Door one: the magic link, all the way to a session.
    const asked = await app.inject({
      method: 'POST',
      url: '/auth/request-link',
      payload: { email: shared },
    });
    expect(asked.statusCode).toBe(200);
    const db = app.potion.db.db;
    const viaLink = await getUserByEmail(db, shared);
    expect(viaLink).not.toBeNull();

    // Door two: Google, same address.
    nextEmail = shared;
    nextEmailVerified = true;
    const f = await begin();
    const res = await complete(f);
    expect(res.statusCode).toBe(200);
    const viaGoogle = await getUserByEmail(db, shared);
    // Same row — not a second account with a duplicate address.
    expect(viaGoogle?.id).toBe(viaLink?.id);
  });

  it('an UNVERIFIED Google email is refused 403 — a valid signature is not proof of the address', async () => {
    nextEmail = 'unverified@example.com';
    nextEmailVerified = false;
    const f = await begin();
    const res = await complete(f);
    expect(res.statusCode).toBe(403);
    expect(String(res.json().error.message)).toContain('has not verified');
    // And no account was created for it.
    expect(await getUserByEmail(app.potion.db.db, 'unverified@example.com')).toBeNull();
  });

  it('a MISSING email_verified claim is refused too — absent is not true', async () => {
    nextEmail = 'noclaim@example.com';
    nextEmailVerified = undefined;
    const f = await begin();
    expect((await complete(f)).statusCode).toBe(403);
    expect(await getUserByEmail(app.potion.db.db, 'noclaim@example.com')).toBeNull();
  });

  it('state mismatch → 400 invalid_state', async () => {
    nextEmail = 'gsignin@example.com';
    nextEmailVerified = true;
    const f = await begin();
    const res = await complete(f, { state: 'not-the-state' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_state');
  });

  it('a tampered flow value fails the HMAC → 400, before anything reaches Google', async () => {
    const f = await begin();
    const [payload, sig] = f.flow.split('.');
    const res = await complete(f, { flow: `${payload}.${(sig ?? '').slice(0, -2)}xx` });
    expect(res.statusCode).toBe(400);
  });

  it('nonce mismatch → 401', async () => {
    nextEmail = 'gsignin@example.com';
    nextEmailVerified = true;
    const f = await begin();
    nextNonce = 'a-different-nonce';
    const res = await app.inject({
      method: 'POST',
      url: '/auth/google/complete',
      payload: { code: 'mock-code', state: f.state, flow: f.flow },
    });
    expect(res.statusCode).toBe(401);
  });

  it('/auth/providers reports google:true when the client is configured', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/providers' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { providers: { google: boolean; magicLink: boolean } }).providers).toMatchObject({
      google: true,
      magicLink: true,
    });
  });
});

describe('Google routes unregistered when unconfigured', () => {
  let app: FastifyInstance;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const k of ['POTION_GOOGLE_CLIENT_ID', 'POTION_GOOGLE_CLIENT_SECRET']) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    clearOidcCaches();
    app = await buildServer({ seed: false });
  });

  afterAll(async () => {
    await app.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('both endpoints are a plain 404 — the email link stays the default', async () => {
    expect((await app.inject({ method: 'POST', url: '/auth/google/begin', payload: {} })).statusCode).toBe(404);
    expect(
      (await app.inject({ method: 'POST', url: '/auth/google/complete', payload: { code: 'c', state: 's', flow: 'f' } }))
        .statusCode,
    ).toBe(404);
  });

  it('/auth/providers says google:false, so the login page draws no dead button', async () => {
    const providers = (await app.inject({ method: 'GET', url: '/auth/providers' })).json() as {
      providers: { google: boolean; magicLink: boolean };
    };
    expect(providers.providers.google).toBe(false);
    expect(providers.providers.magicLink).toBe(true);
  });
});
