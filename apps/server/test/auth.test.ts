// Magic-link auth + RBAC tests (M2 Wave 2, ROADMAP #14) — THE auth gate proof.
// Driven end-to-end via app.inject; zero network. Covers: auto-provisioning,
// single-use + expiry on magic links, the invite flow (admin-only), session
// resolution order (api key → session bearer/cookie → dev bypass → 401), the
// RBAC matrix on /api/* routes, and logout revocation.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256 } from '@potion/core';
import {
  DEFAULT_ORG_ID,
  createMagicLink,
  createMembership,
  createOrg,
  createSession,
  createUser,
  getMembershipRole,
  getOrgById,
  getUserByEmail,
  insertApiKey,
  listMembershipsByUser,
  listOrgs,
} from '@potion/db';
import { buildServer } from '../src/server.js';

let app: FastifyInstance;
const db = () => app.potion.db.db;

/** Extract the ml_ token from a devLink URL. */
function tokenFromLink(link: string): string {
  return new URL(link).searchParams.get('token')!;
}

async function requestLink(email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/request-link',
    headers: { 'content-type': 'application/json' },
    payload: { email },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.devLink).toMatch(/\/auth\/verify\?token=ml_/);
  return tokenFromLink(body.devLink);
}

async function verify(linkToken: string) {
  return app.inject({ method: 'GET', url: `/auth/verify?token=${encodeURIComponent(linkToken)}` });
}

/** Full magic-link sign-in → raw session token (ps_…). */
async function signIn(email: string): Promise<string> {
  const res = await verify(await requestLink(email));
  expect(res.statusCode).toBe(200);
  return res.json().token;
}

function withSession(method: 'GET' | 'POST', url: string, token: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

beforeAll(async () => {
  app = await buildServer({ seed: false });
}, 90_000);

afterAll(async () => {
  delete process.env.POTION_DEV_AUTH;
  await app.close();
});

// ---------- magic-link sign-in + auto-provisioning ----------

describe('magic-link sign-in', () => {
  it('first signup auto-provisions a solo org (domain-named) + admin membership', async () => {
    const sessionToken = await signIn('ada@acme.com');

    const user = await getUserByEmail(db(), 'ada@acme.com');
    expect(user).not.toBeNull();
    const memberships = await listMembershipsByUser(db(), user!.id);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]!.role).toBe('admin');
    const org = await getOrgById(db(), memberships[0]!.orgId);
    expect(org!.name).toBe('acme.com'); // solo org named after the email domain

    // verify response: httpOnly cookie (dashboard) + bearer token (API)
    const res = await verify(await requestLink('ada@acme.com'));
    const setCookie = res.headers['set-cookie'] as string;
    expect(setCookie).toContain('potion_session=ps_');
    expect(setCookie).toContain('HttpOnly');
    expect(res.json().token).toMatch(/^ps_/);

    // the session authenticates /api/* via bearer AND cookie
    const viaBearer = await withSession('GET', '/api/frontiers', sessionToken);
    expect(viaBearer.statusCode).toBe(200);
    const viaCookie = await app.inject({
      method: 'GET',
      url: '/api/frontiers',
      headers: { cookie: `potion_session=${sessionToken}` },
    });
    expect(viaCookie.statusCode).toBe(200);
  });

  it('sign-in is not sign-up: an existing user keeps their org (no re-provision)', async () => {
    const before = (await listOrgs(db())).map((o) => o.id);
    await signIn('ada@acme.com'); // already provisioned above
    const after = (await listOrgs(db())).map((o) => o.id);
    expect(after).toEqual(before); // no new org created
  });

  it('request-link response shape hides account existence; devLink is dev-only', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/request-link',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'fresh@example.org' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, email: 'fresh@example.org' });

    process.env.POTION_DEV_AUTH = '0';
    try {
      const prod = await app.inject({
        method: 'POST',
        url: '/auth/request-link',
        headers: { 'content-type': 'application/json' },
        payload: { email: 'fresh@example.org' },
      });
      expect(prod.statusCode).toBe(200);
      expect(prod.json().devLink).toBeUndefined(); // never leaks in prod mode
    } finally {
      delete process.env.POTION_DEV_AUTH;
    }
  });

  it('magic links are single-use', async () => {
    const linkToken = await requestLink('single@use.dev');
    expect((await verify(linkToken)).statusCode).toBe(200);
    const replay = await verify(linkToken);
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe('invalid_token');
  });

  it('expired magic links are rejected', async () => {
    const raw = 'ml_expired_test_token';
    await createUser(db(), { id: 'usr_exp', email: 'expired@link.dev', name: 'expired' });
    await createMembership(db(), { orgId: DEFAULT_ORG_ID, userId: 'usr_exp', role: 'member' });
    await createMagicLink(db(), {
      tokenHash: sha256(raw),
      email: 'expired@link.dev',
      orgId: DEFAULT_ORG_ID,
      expiresAt: new Date(Date.now() - 1000), // already expired
    });
    const res = await verify(raw);
    expect(res.statusCode).toBe(401);
  });

  it('garbage tokens and missing tokens are rejected', async () => {
    expect((await verify('ml_garbage')).statusCode).toBe(401);
    const missing = await app.inject({ method: 'GET', url: '/auth/verify' });
    expect(missing.statusCode).toBe(400);
  });
});

// ---------- logout ----------

describe('logout', () => {
  it('revokes the session: the token dies immediately', async () => {
    const token = await signIn('logout@acme.com');
    expect((await withSession('GET', '/api/frontiers', token)).statusCode).toBe(200);

    const out = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie: `potion_session=${token}` },
    });
    expect(out.statusCode).toBe(200);
    expect(out.headers['set-cookie']).toContain('Max-Age=0');

    // the revoked bearer is dead (fail-loud even though the dev bypass is on)
    expect((await withSession('GET', '/api/frontiers', token)).statusCode).toBe(401);
    expect((await withSession('GET', '/auth/me', token)).statusCode).toBe(401);
    // logout is idempotent
    expect(
      (await app.inject({ method: 'POST', url: '/auth/logout' })).statusCode,
    ).toBe(200);
  });
});

// ---------- session resolution order ----------

describe('resolution order: api key → session → dev bypass → 401', () => {
  it('a valid api-key bearer resolves the KEY org even when a session cookie rides along', async () => {
    await createOrg(db(), { id: 'org_key', name: 'Key Org' });
    await insertApiKey(db(), {
      id: 'key-ro',
      keyHash: sha256('pk_resolution_order'),
      name: 'ro',
      orgId: 'org_key',
      policyId: null,
    });
    const sessionToken = await signIn('ada@acme.com'); // org: acme.com
    const res = await app.inject({
      method: 'GET',
      url: '/api/keys',
      headers: {
        authorization: 'Bearer pk_resolution_order',
        cookie: `potion_session=${sessionToken}`,
      },
    });
    expect(res.statusCode).toBe(200);
    // key org wins: the row was created in org_key, not acme.com's org
    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: 'Bearer pk_resolution_order' },
    });
    expect(me.json().org.id).toBe('org_key');
    expect(me.json().kind).toBe('apiKey');
    // G2.3 key role split: a default 'serve' key resolves to member.
    expect(me.json().role).toBe('member');
  });

  it('a session pinned to an org resolves THAT org with the membership role', async () => {
    // bob is admin of his solo org and viewer of org_shared (pinned below)
    await createOrg(db(), { id: 'org_shared', name: 'Shared' });
    const bobToken = await signIn('bob@work.io');
    const bob = await getUserByEmail(db(), 'bob@work.io');
    await createMembership(db(), { orgId: 'org_shared', userId: bob!.id, role: 'viewer' });

    const pinned = 'ps_pinned_shared';
    await createSession(db(), {
      id: 'ses-pinned',
      userId: bob!.id,
      tokenHash: sha256(pinned),
      orgId: 'org_shared',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const me = await withSession('GET', '/auth/me', pinned);
    expect(me.json()).toMatchObject({ org: { id: 'org_shared' }, role: 'viewer', kind: 'session' });
    // and the unpinned session resolves bob's FIRST membership (his solo org, admin)
    const me2 = await withSession('GET', '/auth/me', bobToken);
    expect(me2.json().role).toBe('admin');
  });

  it('an invalid bearer fails loudly (401) — no silent downgrade to cookie/bypass', async () => {
    const sessionToken = await signIn('ada@acme.com');
    const res = await app.inject({
      method: 'GET',
      url: '/api/frontiers',
      headers: { authorization: 'Bearer ps_nonsense', cookie: `potion_session=${sessionToken}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('dev bypass OFF (POTION_DEV_AUTH=0) → unauthenticated /api/* is 401', async () => {
    process.env.POTION_DEV_AUTH = '0';
    try {
      for (const url of ['/api/frontiers', '/api/keys', '/api/endpoint-snippet?policy=min_cost']) {
        const res = await app.inject({ method: 'GET', url });
        expect(res.statusCode).toBe(401);
        expect(res.json().error.code).toBe('authentication_required');
      }
      const post = await app.inject({
        method: 'POST',
        url: '/api/policies',
        headers: { 'content-type': 'application/json' },
        payload: { policy: { type: 'min_cost', qualityFloor: 0.5 } },
      });
      expect(post.statusCode).toBe(401);
      // a valid session still works with the bypass off (minted directly —
      // request-link's devLink is off too in this mode)
      const ada = await getUserByEmail(db(), 'ada@acme.com');
      const adaOrg = (await listMembershipsByUser(db(), ada!.id))[0]!.orgId;
      const raw = 'ps_bypass_off_session';
      await createSession(db(), {
        id: 'ses-bypass-off',
        userId: ada!.id,
        tokenHash: sha256(raw),
        orgId: adaOrg,
        expiresAt: new Date(Date.now() + 60_000),
      });
      expect((await withSession('GET', '/api/frontiers', raw)).statusCode).toBe(200);
    } finally {
      delete process.env.POTION_DEV_AUTH;
    }
  });

  it('chat /v1/chat/completions stays API-KEY only (sessions do not serve)', async () => {
    const sessionToken = await signIn('ada@acme.com');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${sessionToken}`, 'content-type': 'application/json' },
      payload: { model: 'potion-auto', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('invalid_api_key');
  });
});

// ---------- invite flow (admin-only) ----------

describe('invite flow', () => {
  it('admin invites → membership in the INVITER org + link signs the invitee into that org', async () => {
    const adminToken = await signIn('owner@corp.co'); // solo org 'corp.co', admin
    const res = await withSession('POST', '/auth/invite', adminToken, { email: 'newhire@corp.co' });
    expect(res.statusCode).toBe(200);
    const { devLink, orgId, role } = res.json();
    expect(role).toBe('member'); // default invite role

    const invitee = await getUserByEmail(db(), 'newhire@corp.co');
    expect(invitee).not.toBeNull();
    expect(await getMembershipRole(db(), orgId, invitee!.id)).toBe('member');

    // the invite link signs the invitee into the inviter's org (no solo org)
    const sessionToken = await (async () => {
      const v = await verify(tokenFromLink(devLink));
      expect(v.statusCode).toBe(200);
      return v.json().token as string;
    })();
    const me = await withSession('GET', '/auth/me', sessionToken);
    expect(me.json()).toMatchObject({
      user: { email: 'newhire@corp.co' },
      org: { id: orgId },
      role: 'member',
    });
    const orgs = (await listOrgs(db())).map((o) => o.name);
    expect(orgs).not.toContain('corp.co'.replace('corp', 'newhire')); // no solo org for invitee
  });

  it('invite is ADMIN-only: member and viewer are 403', async () => {
    const adminToken = await signIn('owner@corp.co');
    const memberToken = await signIn('newhire@corp.co'); // member in corp.co (above)
    for (const [label, token] of [
      ['member', memberToken],
    ] as const) {
      const res = await withSession('POST', '/auth/invite', token, { email: `x-${label}@corp.co` });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('insufficient_role');
    }
    // unauthenticated invite with the bypass OFF → 401
    process.env.POTION_DEV_AUTH = '0';
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/invite',
        headers: { 'content-type': 'application/json' },
        payload: { email: 'nobody@corp.co' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      delete process.env.POTION_DEV_AUTH;
    }
    // sanity: admin still invites fine
    const ok = await withSession('POST', '/auth/invite', adminToken, {
      email: 'second@corp.co',
      role: 'viewer',
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().role).toBe('viewer');
  });
});

// ---------- RBAC matrix on /api/* ----------

describe('RBAC matrix (viewer=read, member=+write, admin=+invite)', () => {
  const tokens: Record<'viewer' | 'member' | 'admin', string> = {
    viewer: '',
    member: '',
    admin: '',
  };

  beforeAll(async () => {
    await createOrg(db(), { id: 'org_rbac', name: 'RBAC Org' });
    for (const role of ['viewer', 'member', 'admin'] as const) {
      await createUser(db(), { id: `usr_${role}`, email: `${role}@rbac.dev`, name: role });
      await createMembership(db(), { orgId: 'org_rbac', userId: `usr_${role}`, role });
      const raw = `ps_rbac_${role}`;
      await createSession(db(), {
        id: `ses_${role}`,
        userId: `usr_${role}`,
        tokenHash: sha256(raw),
        orgId: 'org_rbac',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });
      tokens[role] = raw;
    }
  });

  it('viewer: GET yes, every write no', async () => {
    expect((await withSession('GET', '/api/frontiers', tokens.viewer)).statusCode).toBe(200);
    expect((await withSession('GET', '/api/keys', tokens.viewer)).statusCode).toBe(200);
    expect(
      (await withSession('GET', '/api/endpoint-snippet?policy=min_cost', tokens.viewer)).statusCode,
    ).toBe(200);
    const pol = await withSession('POST', '/api/policies', tokens.viewer, {
      policy: { type: 'min_cost', qualityFloor: 0.5 },
    });
    expect(pol.statusCode).toBe(403);
    expect(pol.json().error.code).toBe('insufficient_role');
    expect(
      (
        await withSession('POST', '/api/keys', tokens.viewer, {
          provider: 'openai',
          apiKey: 'sk-viewer-attempt-0001',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await withSession('POST', '/auth/invite', tokens.viewer, { email: 'v@rbac.dev' })).statusCode,
    ).toBe(403);
  });

  it('member: GET + policy/key writes yes, invite no', async () => {
    expect((await withSession('GET', '/api/frontiers', tokens.member)).statusCode).toBe(200);
    const pol = await withSession('POST', '/api/policies', tokens.member, {
      policy: { type: 'min_cost', qualityFloor: 0.5 },
    });
    expect(pol.statusCode).toBe(201);
    const key = await withSession('POST', '/api/keys', tokens.member, {
      provider: 'openai',
      apiKey: 'sk-member-write-0001',
    });
    expect(key.statusCode).toBe(201);
    expect(
      (await withSession('POST', '/auth/invite', tokens.member, { email: 'm@rbac.dev' })).statusCode,
    ).toBe(403);
  });

  it('admin: everything yes (read, write, invite)', async () => {
    expect((await withSession('GET', '/api/frontiers', tokens.admin)).statusCode).toBe(200);
    expect(
      (
        await withSession('POST', '/api/policies', tokens.admin, {
          policy: { type: 'max_quality', costCeilingPer1K: 5 },
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (await withSession('POST', '/auth/invite', tokens.admin, { email: 'a@rbac.dev' })).statusCode,
    ).toBe(200);
  });
});
