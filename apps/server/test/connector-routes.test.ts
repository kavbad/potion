// Step 10 connector routes — the OAuth flow proven against a MOCK provider
// (the oidc.test.ts fake-IdP discipline): PKCE S256 on the wire, the
// org-bound state cookie as the tenancy anchor, the token sealed at the
// callback (never in any response), revoke as a typed cut + best-effort
// provider job. Endpoint overrides ride the EXPLICIT opt-in env.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { sha256 } from '@potion/core';
import {
  createMembership,
  createOrg,
  createSession,
  createUser,
  getLabGrant,
  insertPolicy,
  readGrantEnvelopes,
} from '@potion/db';
import { MockMcpServer } from '@potion/lab-mcp/mock-server';
import { buildServer } from '../src/server.js';
import { CONNECTOR_STATE_COOKIE } from '../src/connector-oauth.js';

const ORG_X = 'org_connx';
const ORG_Y = 'org_conny';
const LIVE_TOKEN = 'gho_flowTESTaccess4X9mQ2vL7pK8rT3sW6zE1y';
const ENV_KEYS = [
  'POTION_CONNECTOR_ENDPOINT_OVERRIDES',
  'POTION_CONNECTOR_GITHUB_TOKEN_URL',
  'POTION_CONNECTOR_GITHUB_AUTH_URL',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'POTION_DEV_AUTH',
] as const;

let app: FastifyInstance;
let provider: MockMcpServer;
const envBefore: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const tokenRequests: Array<Record<string, string>> = [];

function cookieFor(org: 'x' | 'y'): string {
  return `potion_session=ps_conn${org}`;
}

beforeAll(async () => {
  for (const k of ENV_KEYS) envBefore[k] = process.env[k];
  process.env.POTION_DEV_AUTH = '0';
  provider = await MockMcpServer.start({
    tools: [],
    tokenEndpoint: (form) => {
      tokenRequests.push(form);
      if (form.code !== 'good-code') return { status: 400, body: { error: 'bad_verification_code' } };
      return {
        status: 200,
        body: { access_token: LIVE_TOKEN, token_type: 'bearer', scope: '' },
      };
    },
  });
  process.env.POTION_CONNECTOR_ENDPOINT_OVERRIDES = '1';
  process.env.POTION_CONNECTOR_GITHUB_TOKEN_URL = provider.tokenUrl;
  process.env.POTION_CONNECTOR_GITHUB_AUTH_URL = `${provider.url}/authorize`;
  process.env.GITHUB_CLIENT_ID = 'Iv1.mockclient';
  process.env.GITHUB_CLIENT_SECRET = 'mock-client-secret-0123456789abcdef';

  app = await buildServer({ seed: false });
  const db = app.potion.db.db;
  for (const [org, user, token] of [
    [ORG_X, 'usr_connx', 'ps_connx'],
    [ORG_Y, 'usr_conny', 'ps_conny'],
  ] as const) {
    await createOrg(db, { id: org, name: org });
    await insertPolicy(db, { id: `pol-${org}`, orgId: org, name: 'p', config: { type: 'min_cost', qualityFloor: 0 } });
    await createUser(db, { id: user, email: `${user}@conn.dev`, name: user });
    await createMembership(db, { orgId: org, userId: user, role: 'admin' });
    await createSession(db, {
      id: `ses-${org}`,
      userId: user,
      tokenHash: sha256(token),
      orgId: org,
      expiresAt: new Date(Date.now() + 3600_000),
    });
  }
}, 120_000);

afterAll(async () => {
  await app.close();
  await provider.close();
  for (const k of ENV_KEYS) {
    if (envBefore[k] === undefined) delete process.env[k];
    else process.env[k] = envBefore[k];
  }
});

function extractCookie(setCookie: string | string[] | undefined): string {
  const all = Array.isArray(setCookie) ? setCookie : setCookie === undefined ? [] : [setCookie];
  const raw = all.find((c) => c.startsWith(`${CONNECTOR_STATE_COOKIE}=`));
  expect(raw, 'state cookie must be set').toBeDefined();
  return raw!.split(';')[0]!;
}

async function startFlow(sessionCookie: string): Promise<{ url: URL; flowCookie: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/lab/connectors/github/oauth/start',
    headers: { cookie: sessionCookie },
    payload: {},
  });
  expect(res.statusCode).toBe(200);
  const url = new URL((res.json() as { authorizationUrl: string }).authorizationUrl);
  return { url, flowCookie: extractCookie(res.headers['set-cookie']) };
}

describe('POST /oauth/start', () => {
  it('builds the authorization URL with PKCE S256 + state, and sets the signed flow cookie', async () => {
    const { url } = await startFlow(cookieFor('x'));
    expect(url.origin + url.pathname).toBe(`${provider.url}/authorize`);
    expect(url.searchParams.get('client_id')).toBe('Iv1.mockclient');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{22}$/);
    // zero-scope grant: the MINIMUM the handshake allows — no scope param
    expect(url.searchParams.get('scope')).toBeNull();
  });

  it('refuses below admin and unknown connectors', async () => {
    const viewer = await app.inject({
      method: 'POST',
      url: '/api/lab/connectors/github/oauth/start',
      headers: { authorization: 'Bearer pk_not_a_real_admin' },
      payload: {},
    });
    expect([401, 403]).toContain(viewer.statusCode);
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/lab/connectors/nonexistent/oauth/start',
      headers: { cookie: cookieFor('x') },
      payload: {},
    });
    expect(unknown.statusCode).toBe(404);
  });
});

describe('GET /oauth/callback', () => {
  it('exchanges the code with the PKCE verifier, seals the grant, and never echoes the token', async () => {
    tokenRequests.length = 0;
    const { url, flowCookie } = await startFlow(cookieFor('x'));
    const state = url.searchParams.get('state')!;
    const challenge = url.searchParams.get('code_challenge')!;
    const res = await app.inject({
      method: 'GET',
      url: `/api/lab/connectors/github/oauth/callback?code=good-code&state=${state}`,
      headers: { cookie: `${cookieFor('x')}; ${flowCookie}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(LIVE_TOKEN);
    // PKCE proof: the verifier we sent hashes to the challenge we showed
    const form = tokenRequests.at(-1)!;
    expect(createHash('sha256').update(form.code_verifier!, 'ascii').digest('base64url')).toBe(challenge);
    // The grant landed sealed in ORG_X — status derived connected, envelope ≠ token
    const db = app.potion.db.db;
    const grant = (await getLabGrant(db, ORG_X, 'github'))!;
    expect(grant.status).toBe('active');
    const envelopes = (await readGrantEnvelopes(db, ORG_X, 'github'))!;
    expect(envelopes.tokenEnvelope).not.toContain(LIVE_TOKEN);
    expect(envelopes.tokenEnvelope.startsWith('v1.')).toBe(true);
    expect(await getLabGrant(db, ORG_Y, 'github')).toBeNull();
  });

  it('refuses a state mismatch, a missing cookie, and a FOREIGN org session (the tenancy anchor)', async () => {
    const { url, flowCookie } = await startFlow(cookieFor('x'));
    const state = url.searchParams.get('state')!;
    const badState = await app.inject({
      method: 'GET',
      url: '/api/lab/connectors/github/oauth/callback?code=good-code&state=WRONG',
      headers: { cookie: `${cookieFor('x')}; ${flowCookie}` },
    });
    expect(badState.statusCode).toBe(400);
    const noCookie = await app.inject({
      method: 'GET',
      url: `/api/lab/connectors/github/oauth/callback?code=good-code&state=${state}`,
      headers: { cookie: cookieFor('x') },
    });
    expect(noCookie.statusCode).toBe(400);
    // org B's admin session presenting org A's flow cookie: 403, no grant
    const { url: urlA, flowCookie: cookieA } = await startFlow(cookieFor('x'));
    const cross = await app.inject({
      method: 'GET',
      url: `/api/lab/connectors/github/oauth/callback?code=good-code&state=${urlA.searchParams.get('state')}`,
      headers: { cookie: `${cookieFor('y')}; ${cookieA}` },
    });
    expect(cross.statusCode).toBe(403);
    expect(await getLabGrant(app.potion.db.db, ORG_Y, 'github')).toBeNull();
  });
});

describe('POST /revoke', () => {
  it('marks the typed cut immediately and enqueues the best-effort provider job', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/lab/connectors/github/revoke',
      headers: { cookie: cookieFor('x') },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; providerRevocationJobId: string };
    expect(body.status).toBe('revoked');
    expect(body.providerRevocationJobId).toBeTruthy();
    const grant = (await getLabGrant(app.potion.db.db, ORG_X, 'github'))!;
    expect(grant.status).toBe('revoked');
    expect(grant.revokedAt).not.toBeNull();
    // the connectors list shows the cut
    const list = await app.inject({
      method: 'GET',
      url: '/api/lab/connectors',
      headers: { cookie: cookieFor('x') },
    });
    const github = (list.json() as { connectors: Array<{ connectorId: string; status: string }> }).connectors.find(
      (c) => c.connectorId === 'github',
    )!;
    expect(github.status).toBe('revoked');
    // revoking an org with NO grant is the uniform 404
    const none = await app.inject({
      method: 'POST',
      url: '/api/lab/connectors/github/revoke',
      headers: { cookie: cookieFor('y') },
      payload: {},
    });
    expect(none.statusCode).toBe(404);
  });
});
