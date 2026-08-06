// OIDC SSO tests (M4, ROADMAP #34, SPEC §13.6) — full authorization-code +
// PKCE flow against a LOCAL mock IdP (discovery, token endpoint, JWKS), with
// real RS256 id_token minting/verification.
//   · /auth/oidc/login → 302 to the discovered authorization_endpoint with
//     state/nonce/PKCE challenge + signed state cookie
//   · callback: state mismatch → 400; bad signature / nonce mismatch → 401;
//     happy path → potion_session minted (magic-link-identical semantics),
//     auth_events login row (method 'oidc'), user+org auto-provisioned
//   · PKCE proof: the code_verifier posted to /token matches the login
//     challenge (S256)
//   · env unset → /auth/oidc/* unregistered (404; magic-link stays default)
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { listAuthEvents } from '@potion/db';
import { buildServer } from '../src/server.js';
import { clearOidcCaches, decodeStateCookie, pkceChallenge } from '../src/oidc.js';

// ---- mock IdP ----
let idp: Server;
let idpBase = '';
let privateKey: KeyObject;
let jwk: Record<string, unknown>;
/** Mutable knobs the tests set before a callback. */
let nextNonce = '';
let nextEmail = 'sso-user@example.com';
let tamperSignature = false;
let lastTokenForm: Record<string, string> = {};

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url');
}

function mintIdToken(claims: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', kid: 'test-key-1', typ: 'JWT' }));
  const payload = b64url(JSON.stringify(claims));
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), privateKey);
  return `${header}.${payload}.${tamperSignature ? b64url(Buffer.from('bogus-signature-padding-bogus-signature-padding-bogus!')) : b64url(signature)}`;
}

function validClaims(nonce: string, email: string): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: idpBase,
    aud: 'potion-test',
    sub: 'idp-sub-1',
    email,
    nonce,
    iat: now,
    exp: now + 600,
  };
}

beforeAll(async () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = pair.privateKey;
  const pub = pair.publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  jwk = { ...pub, kid: 'test-key-1', alg: 'RS256', use: 'sig' };

  idp = createServer((req, res) => {
    const url = req.url ?? '';
    const json = (status: number, body: unknown) => {
      const data = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(data);
    };
    if (url.startsWith('/.well-known/openid-configuration')) {
      return json(200, {
        issuer: idpBase,
        authorization_endpoint: `${idpBase}/authorize`,
        token_endpoint: `${idpBase}/token`,
        jwks_uri: `${idpBase}/jwks`,
      });
    }
    if (url.startsWith('/jwks')) {
      return json(200, { keys: [jwk] });
    }
    if (url.startsWith('/token') && req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        lastTokenForm = Object.fromEntries(
          new URLSearchParams(Buffer.concat(chunks).toString()).entries(),
        );
        return json(200, {
          id_token: mintIdToken(validClaims(nextNonce, nextEmail)),
          access_token: 'at-mock',
          token_type: 'Bearer',
          expires_in: 3600,
        });
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => idp.listen(0, '127.0.0.1', resolve));
  idpBase = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    idp.close((err) => (err ? reject(err) : resolve())),
  );
});

// ---- app WITH the OIDC env quartet ----
describe('OIDC flow (env configured)', () => {
  let app: FastifyInstance;
  const savedEnv: Record<string, string | undefined> = {};
  const ENV = {
    POTION_OIDC_ISSUER: () => idpBase,
    POTION_OIDC_CLIENT_ID: () => 'potion-test',
    POTION_OIDC_CLIENT_SECRET: () => 'test-secret',
    POTION_OIDC_REDIRECT_URI: () => 'http://localhost:3000/auth/oidc/callback',
  };

  beforeAll(async () => {
    for (const [k, v] of Object.entries(ENV)) {
      savedEnv[k] = process.env[k];
      process.env[k] = v();
    }
    clearOidcCaches();
    app = await buildServer({ seed: false });
  });

  afterAll(async () => {
    await app.close();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  interface Flow {
    cookie: string;
    state: string;
    nonce: string;
    verifier: string;
    location: string;
  }

  async function startFlow(): Promise<Flow> {
    const res = await app.inject({ method: 'GET', url: '/auth/oidc/login' });
    expect(res.statusCode).toBe(302);
    const location = res.headers.location as string;
    expect(location.startsWith(`${idpBase}/authorize?`)).toBe(true);
    const setCookie = res.headers['set-cookie'];
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0]! : setCookie!;
    const cookie = cookieHeader.split(';')[0]!.split('=').slice(1).join('=');
    const flow = decodeStateCookie(cookie, 'test-secret');
    return { cookie, state: flow.state, nonce: flow.nonce, verifier: flow.verifier, location };
  }

  function callback(flow: Flow, state: string, cookie?: string) {
    return app.inject({
      method: 'GET',
      url: `/auth/oidc/callback?code=mock-code&state=${encodeURIComponent(state)}`,
      headers: { cookie: `potion_oidc=${cookie ?? flow.cookie}` },
    });
  }

  it('login redirects to the IdP with state, nonce and an S256 PKCE challenge', async () => {
    const flow = await startFlow();
    const params = new URL(flow.location).searchParams;
    expect(params.get('client_id')).toBe('potion-test');
    expect(params.get('state')).toBe(flow.state);
    expect(params.get('nonce')).toBe(flow.nonce);
    expect(params.get('code_challenge_method')).toBe('S256');
    // The challenge is exactly the S256 of the sealed verifier.
    expect(params.get('code_challenge')).toBe(pkceChallenge(flow.verifier));
    expect(params.get('redirect_uri')).toBe('http://localhost:3000/auth/oidc/callback');
  });

  it('callback with a mismatched state → 400 invalid_state', async () => {
    const flow = await startFlow();
    const res = await callback(flow, 'not-the-state');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_state');
  });

  it('happy path: session minted, login recorded, user provisioned — PKCE verifier posted', async () => {
    const flow = await startFlow();
    nextNonce = flow.nonce;
    nextEmail = 'sso-user@example.com';
    tamperSignature = false;
    const res = await callback(flow, flow.state);
    expect(res.statusCode).toBe(302);

    // PKCE: the verifier posted to /token matches the login challenge.
    expect(lastTokenForm.code_verifier).toBe(flow.verifier);
    expect(lastTokenForm.client_secret).toBe('test-secret');
    expect(lastTokenForm.grant_type).toBe('authorization_code');

    // Session cookie: potion_session=ps_… minted (magic-link semantics).
    const setCookies = res.headers['set-cookie'];
    const cookieList = Array.isArray(setCookies) ? setCookies : [setCookies!];
    const sessionLine = cookieList.find((c) => c.startsWith('potion_session=ps_'));
    expect(sessionLine).toBeDefined();
    const sessionToken = sessionLine!.split(';')[0]!.split('=')[1]!;

    // The session serves /auth/me with the IdP email + auto-provisioned org.
    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: `potion_session=${sessionToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe('sso-user@example.com');

    // auth_events carries the oidc login row.
    const events = await listAuthEvents(app.potion.db.db, me.json().org.id);
    const login = events.find((e) => e.actor === 'sso-user@example.com');
    expect(login).toMatchObject({ kind: 'login', method: 'oidc' });
  });

  it('tampered id_token signature → 401 invalid_token', async () => {
    const flow = await startFlow();
    nextNonce = flow.nonce;
    tamperSignature = true;
    const res = await callback(flow, flow.state);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('invalid_token');
    tamperSignature = false;
  });

  it('nonce mismatch → 401', async () => {
    const flow = await startFlow();
    nextNonce = 'a-different-nonce';
    tamperSignature = false;
    const res = await callback(flow, flow.state);
    expect(res.statusCode).toBe(401);
  });
});

// ---- app WITHOUT the OIDC env quartet ----
describe('OIDC routes unregistered when env unset', () => {
  let app: FastifyInstance;
  const saved: Record<string, string | undefined> = {};
  const KEYS = [
    'POTION_OIDC_ISSUER',
    'POTION_OIDC_CLIENT_ID',
    'POTION_OIDC_CLIENT_SECRET',
    'POTION_OIDC_REDIRECT_URI',
  ];

  beforeAll(async () => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    app = await buildServer({ seed: false });
  });

  afterAll(async () => {
    await app.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('/auth/oidc/login is a plain 404 — magic-link stays the default', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/oidc/login' });
    expect(res.statusCode).toBe(404);
    // And the magic-link endpoint still answers (the M2 default flow).
    const ml = await app.inject({
      method: 'POST',
      url: '/auth/request-link',
      payload: { email: 'nobody@example.com' },
    });
    expect([200, 202]).toContain(ml.statusCode);
  });
});
