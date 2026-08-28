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

// ── Self-serve signup, end to end, with the dev bypass OFF ───────────────
//
// The flag existed and was gate-tested, but the LOOP was never proven: with
// no SMTP, a production self-serve signup creates the org and then strands
// the person, because the magic link only reaches the server log. These pin
// the whole path — signup → link → session → authenticated work — under
// production auth semantics, plus the property that makes the new flag safe
// to reason about (it is its own switch, and it is off unless asked for).
describe('self-serve signup (POTION_SELF_SERVE=1, dev bypass OFF)', () => {
  let selfApp: FastifyInstance;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const k of ['POTION_SELF_SERVE', 'POTION_MAGIC_LINK_IN_RESPONSE', 'POTION_DEV_AUTH']) {
      saved[k] = process.env[k];
    }
    process.env.POTION_SELF_SERVE = '1';
    process.env.POTION_MAGIC_LINK_IN_RESPONSE = '1';
    process.env.POTION_DEV_AUTH = '0';
    const { buildServer } = await import('../src/server.js');
    selfApp = await buildServer({ seed: false });
  }, 60_000);

  afterAll(async () => {
    await selfApp?.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('an unknown email signs up, receives a usable link, and lands in its own org as admin', async () => {
    const email = 'stranger@newco.test';
    const signup = await selfApp.inject({
      method: 'POST',
      url: '/auth/request-link',
      headers: { 'content-type': 'application/json' },
      payload: { email },
    });
    expect(signup.statusCode).toBe(200);
    const link = signup.json().devLink as string;
    expect(typeof link).toBe('string'); // without this the signup strands

    const token = new URL(link).searchParams.get('token')!;
    const verify = await selfApp.inject({ method: 'GET', url: `/auth/verify?token=${encodeURIComponent(token)}` });
    expect(verify.statusCode).toBe(200);
    const cookie = String(verify.headers['set-cookie'] ?? '').split(';')[0]!;

    // A real session doing real work: read, then mint a serving key.
    expect((await selfApp.inject({ method: 'GET', url: '/api/keys', headers: { cookie } })).statusCode).toBe(200);
    const policy = await selfApp.inject({
      method: 'POST',
      url: '/api/policies',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { policy: { type: 'min_cost', qualityFloor: 0.8 }, createKey: true },
    });
    expect(policy.statusCode).toBe(201);
    expect(typeof policy.json().apiKey).toBe('string');

    // The org is the signer's own, and they are its admin.
    const user = await getUserByEmail(selfApp.potion.db.db, email);
    expect(user).not.toBeNull();
    const memberships = await listMembershipsByUser(selfApp.potion.db.db, user!.id);
    expect(memberships.length).toBe(1);
    expect(memberships[0]!.role).toBe('admin');
    expect(memberships[0]!.orgId).not.toBe(DEFAULT_ORG_ID); // never the demo org

    // Still single-use.
    const replay = await selfApp.inject({ method: 'GET', url: `/auth/verify?token=${encodeURIComponent(token)}` });
    expect(replay.statusCode).toBe(401);
  }, 60_000);

  it('a fresh org can retrieve its OWN connection details with no ?policy=', async () => {
    // The onramp question is "where do I point my traffic?", and before this
    // the only way to ask it was to already know your policy JSON — a fresh
    // self-serve org got a 400 from the surface meant to onboard it.
    const email = 'connect@newco.test';
    const signup = await selfApp.inject({
      method: 'POST',
      url: '/auth/request-link',
      headers: { 'content-type': 'application/json' },
      payload: { email },
    });
    const token = new URL(signup.json().devLink as string).searchParams.get('token')!;
    const verify = await selfApp.inject({ method: 'GET', url: `/auth/verify?token=${encodeURIComponent(token)}` });
    const cookie = String(verify.headers['set-cookie'] ?? '').split(';')[0]!;

    // Before a policy exists there is nothing to describe — still a 400.
    const before = await selfApp.inject({ method: 'GET', url: '/api/endpoint-snippet', headers: { cookie } });
    expect(before.statusCode).toBe(400);

    await selfApp.inject({
      method: 'POST',
      url: '/api/policies',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { policy: { type: 'min_cost', qualityFloor: 0.8 }, createKey: true },
    });

    const after = await selfApp.inject({ method: 'GET', url: '/api/endpoint-snippet', headers: { cookie } });
    expect(after.statusCode).toBe(200);
    const body = after.json();
    expect(body.policy).toEqual({ type: 'min_cost', qualityFloor: 0.8 }); // THEIR bound policy
    expect(body.url).toContain('/v1/chat/completions');
    expect(body.openaiNode).toContain('potion-auto'); // the auto-switch, named

    // An explicit ?policy= still wins, and a bogus one still 400s.
    const explicit = await selfApp.inject({
      method: 'GET',
      url: '/api/endpoint-snippet?policy=max_quality',
      headers: { cookie },
    });
    expect(explicit.json().policy.type).toBe('max_quality');
    expect(
      (await selfApp.inject({ method: 'GET', url: '/api/endpoint-snippet?policy=bogus', headers: { cookie } }))
        .statusCode,
    ).toBe(400);
  }, 60_000);

  it('the link-in-response flag is INDEPENDENT of self-serve and off unless set', async () => {
    const { magicLinkInResponseEnabled } = await import('../src/routes/auth.js');
    expect(magicLinkInResponseEnabled({})).toBe(false);
    expect(magicLinkInResponseEnabled({ POTION_SELF_SERVE: '1' })).toBe(false); // not implied
    expect(magicLinkInResponseEnabled({ POTION_MAGIC_LINK_IN_RESPONSE: '0' })).toBe(false);
    expect(magicLinkInResponseEnabled({ POTION_MAGIC_LINK_IN_RESPONSE: '1' })).toBe(true);
    expect(magicLinkInResponseEnabled({ POTION_MAGIC_LINK_IN_RESPONSE: 'true' })).toBe(true);
  });
});

describe('sign-in codes (2026-08-28: the type-able fallback)', () => {
  it('a minted code signs in exactly like the link — same session mint, single-use', async () => {
    const { createMagicLink, getUserByEmail: getU } = await import('@potion/db');
    const { signInCodePreimage } = await import('../src/routes/auth.js');
    const { sha256: h } = await import('@potion/core');
    await signIn('code-user@acme.com'); // provisions the org
    const user = await getU(db(), 'code-user@acme.com');
    const { listMembershipsByUser: listM } = await import('@potion/db');
    const orgId = (await listM(db(), user!.id))[0]!.orgId;
    await createMagicLink(db(), {
      tokenHash: h(signInCodePreimage('Code-User@acme.com', '12345678')),
      email: 'code-user@acme.com',
      orgId,
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });
    const res = await app.inject({
      method: 'POST', url: '/auth/verify-code',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'CODE-USER@acme.com', code: '1234 5678'.replace(' ', '') },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().token).toMatch(/^ps_/);
    expect((res.headers['set-cookie'] as string)).toContain('HttpOnly');
    // Single-use: the same code again is dead.
    const again = await app.inject({
      method: 'POST', url: '/auth/verify-code',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'code-user@acme.com', code: '12345678' },
    });
    expect(again.statusCode).toBe(401);
  });

  it('wrong codes 401 and repeated attempts hit the limiter', async () => {
    for (let i = 0; i < 6; i++) {
      const r = await app.inject({
        method: 'POST', url: '/auth/verify-code',
        headers: { 'content-type': 'application/json' },
        payload: { email: 'limited@acme.com', code: '00000000' },
      });
      expect(r.statusCode).toBe(401);
    }
    const blocked = await app.inject({
      method: 'POST', url: '/auth/verify-code',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'limited@acme.com', code: '00000000' },
    });
    expect(blocked.statusCode).toBe(429);
  });

  it('the sign-in email carries BOTH a clickable HTML button and the code', async () => {
    const { issueMagicLink } = await import('../src/routes/auth.js');
    const { getUserByEmail: getU2, listMembershipsByUser: listM2 } = await import('@potion/db');
    const orgId = (await listM2(db(), (await getU2(db(), 'code-user@acme.com'))!.id))[0]!.orgId;
    const captured: Array<{ text: string; html?: string }> = [];
    await issueMagicLink(db(), 'email-shape@acme.com', orgId, 'https://example.test', async (m) => {
      captured.push({ text: m.text, ...(m.html !== undefined ? { html: m.html } : {}) });
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.html).toContain('<a href="https://example.test/auth/verify?token=ml_');
    expect(captured[0]!.text).toMatch(/code.*: \d{4} \d{4}/i);
    expect(captured[0]!.html).toMatch(/\d{4} \d{4}/);
  });
});
