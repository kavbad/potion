// Key lifecycle + BYOK serving tests (M2 Wave 2, ROADMAP #15/#16) — driven
// end-to-end via app.inject with an INJECTED provider-factory spy (zero
// network):
//   · POST /api/keys encrypts + stores (servingEnabled: true), never leaks raw
//   · per-org serving: org with an active key is served by a provider built
//     from its DECRYPTED key (spy evidence); orgs without keys get the
//     platform boot set; every decrypt is audited
//   · revoke stops serving IMMEDIATELY (cache-busted, not TTL-bound)
//   · rotate swaps key material (key_version bump, audit) and serving follows
//   · validate probes through the provider with the decrypted key and records
//     last_validated_at (+ audit)
//   · api_keys lifecycle: named/scoped keys, revoke + expiry → 401 in the
//     auth hot path, scope check on admin mutations
//   · RBAC + tenant isolation on key mutations
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256, type Policy, type ProviderId } from '@potion/core';
import {
  DEFAULT_ORG_ID,
  createMembership,
  createOrg,
  createSession,
  createUser,
  getProviderKeyById,
  insertApiKey,
  insertPolicy,
  listCustodyAudit,
} from '@potion/db';
import type { Provider, ProviderFactoryOptions } from '@potion/providers';
import { buildServer } from '../src/server.js';

const ORG_A = DEFAULT_ORG_ID;
const ORG_B = 'org_b';

// serving keys (chat) — 'serve' scope is the default
const RAW_A = 'pk_keys_test_serve_a';
const RAW_B = 'pk_keys_test_serve_b';
// org-B ADMIN key (scope 'serve+admin') for mutation/isolation tests
const RAW_B_ADMIN = 'pk_keys_test_admin_b';

const POLICY: Policy = { type: 'max_quality', costCeilingPer1K: 100 };

// BYOK material (provider 'mock' — the injected factory honors apiKeys.mock)
const BYOK_RAW_V1 = 'byok-org-secret-v1-aaaaaaaaaaaa';
const BYOK_RAW_V2 = 'byok-org-secret-v2-bbbbbbbbbbbb';

const PROMPT = 'Write a python function that reverses a string';

// G2.4: BYOK fixtures use a REAL provider id ('openai') — 'mock' is no
// longer an accepted BYOK provider (a mock key validated ok:true and then
// served mock text under a live server). The injected spy factory below
// keeps every provider id network-free.
// ---- injected provider-factory spy ----
const factoryCalls: Array<Partial<Record<ProviderId, string>>> = [];
function spyFactory(opts: ProviderFactoryOptions): Record<ProviderId, Provider> {
  factoryCalls.push({ ...(opts.apiKeys ?? {}) });
  const make = (id: ProviderId): Provider => ({
    id,
    complete: async (req) => ({
      text: `spy:${id}:${opts.apiKeys?.[id] ?? 'nokey'}:${req.model}`,
      usage: { inputTokens: 3, outputTokens: 5 },
      latencyMs: 1,
      modelVersion: 'spy-v1',
    }),
  });
  return {
    anthropic: make('anthropic'),
    openai: make('openai'),
    google: make('google'),
    openrouter: make('openrouter'),
    mock: make('mock'),
  };
}

let app: FastifyInstance;
const db = () => app.potion.db.db;

function chat(rawKey: string) {
  return app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${rawKey}`, 'content-type': 'application/json' },
    payload: { model: 'potion-auto', messages: [{ role: 'user', content: PROMPT }] },
  });
}

function authed(method: 'GET' | 'POST', url: string, rawKey: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${rawKey}`,
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

beforeAll(async () => {
  app = await buildServer({ seed: false, providerFactory: spyFactory });

  await createOrg(db(), { id: ORG_B, name: 'Org B' });
  await insertPolicy(db(), { id: 'pol-a', orgId: ORG_A, name: 'a', config: POLICY });
  await insertApiKey(db(), {
    id: 'key-a',
    keyHash: sha256(RAW_A),
    name: 'a',
    orgId: ORG_A,
    policyId: 'pol-a',
  });
  await insertPolicy(db(), { id: 'pol-b', orgId: ORG_B, name: 'b', config: POLICY });
  await insertApiKey(db(), {
    id: 'key-b',
    keyHash: sha256(RAW_B),
    name: 'b',
    orgId: ORG_B,
    policyId: 'pol-b',
  });
  await insertApiKey(db(), {
    id: 'key-b-admin',
    keyHash: sha256(RAW_B_ADMIN),
    name: 'b-admin',
    orgId: ORG_B,
    scopes: 'serve+admin',
  });

  // a MEMBER session in org A (RBAC proof: member may not rotate/revoke)
  await createUser(db(), { id: 'usr_member', email: 'member@keys.dev', name: 'Member' });
  await createMembership(db(), { orgId: ORG_A, userId: 'usr_member', role: 'member' });
  await createSession(db(), {
    id: 'ses_member',
    userId: 'usr_member',
    tokenHash: sha256('ps_keys_member_token'),
    orgId: ORG_A,
    expiresAt: new Date(Date.now() + 3600_000),
  });
}, 90_000);

afterAll(async () => {
  await app.close();
});

describe('POST /api/keys — real custody registration', () => {
  it('encrypts + stores: servingEnabled TRUE, raw key never in response or db row', async () => {
    // dev bypass → org_demo admin (documented test path)
    const res = await app.inject({
      method: 'POST',
      url: '/api/keys',
      headers: { 'content-type': 'application/json' },
      payload: { provider: 'openai', apiKey: BYOK_RAW_V1, name: 'byok v1' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.servingEnabled).toBe(true); // the M1a honesty stub is GONE
    expect(body.maskedKey).toBe('byo…aaaa');
    expect(JSON.stringify(body)).not.toContain(BYOK_RAW_V1);

    const row = (await getProviderKeyById(db(), ORG_A, body.id))!;
    expect(row.ciphertext).toBeTruthy();
    expect(row.ciphertext).not.toContain(BYOK_RAW_V1);
    expect(row.ciphertext).not.toContain('byok-org-secret');
    expect(row.status).toBe('active');
    expect(row.keyVersion).toBe(1);

    // idempotent: same raw key → same row, 200, no second row
    const again = await app.inject({
      method: 'POST',
      url: '/api/keys',
      headers: { 'content-type': 'application/json' },
      payload: { provider: 'openai', apiKey: BYOK_RAW_V1, name: 'byok v1' },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(body.id);

    // audited
    const audit = await listCustodyAudit(db(), ORG_A, body.id);
    expect(audit.some((a) => a.action === 'encrypt')).toBe(true);
  });
});

describe('BYOK serving path (per-org provider resolution)', () => {
  it('org WITH an active key is served by a provider built from its DECRYPTED key', async () => {
    const before = factoryCalls.length;
    const res = await chat(RAW_A);
    expect(res.statusCode).toBe(200);
    const content = res.json().choices[0].message.content as string;
    // spy evidence: the mock provider was built with the ORG's raw key
    // The ORG's provider set answered (spy:*, not the boot providers) …
    expect(content).toContain('spy:');
    // … and it was built from the org's DECRYPTED key. (The served alias is
    // mock-priced, so the spy's mock transport answers; the BYOK evidence is
    // the factory call — G2.4 moved BYOK fixtures off the 'mock' provider id.)
    expect(factoryCalls.length).toBe(before + 1);
    expect(factoryCalls.at(-1)?.openai).toBe(BYOK_RAW_V1);

    // every decrypt is audited under the serving actor
    const keys = (await app.inject({ method: 'GET', url: '/api/keys' })).json().keys;
    const audit = await listCustodyAudit(db(), ORG_A, keys[0].id);
    expect(audit.some((a) => a.action === 'decrypt' && a.actor === 'system:serve')).toBe(true);
  });

  it('org WITHOUT keys keeps the platform boot providers (factory NOT called)', async () => {
    const before = factoryCalls.length;
    const res = await chat(RAW_B);
    expect(res.statusCode).toBe(200);
    const content = res.json().choices[0].message.content as string;
    expect(content).not.toContain('spy:'); // boot mock provider answered
    expect(factoryCalls.length).toBe(before);
  });

  it('revoke stops serving IMMEDIATELY (no TTL wait)', async () => {
    const keys = (await app.inject({ method: 'GET', url: '/api/keys' })).json().keys;
    const id = keys[0].id as string;
    const revoke = await app.inject({ method: 'POST', url: `/api/keys/${id}/revoke` });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json().status).toBe('revoked');
    expect(revoke.json().servingEnabled).toBe(false);

    const before = factoryCalls.length;
    const res = await chat(RAW_A);
    expect(res.statusCode).toBe(200);
    expect(res.json().choices[0].message.content as string).not.toContain('spy:');
    expect(factoryCalls.length).toBe(before); // org key NO LONGER served

    const audit = await listCustodyAudit(db(), ORG_A, id);
    expect(audit.some((a) => a.action === 'revoke')).toBe(true);
  });

  it('rotate swaps material: key_version bump, old key dead, serving uses the new key', async () => {
    // re-register (v1 was revoked; v2 is a new row — same provider, new raw)
    const reg = await app.inject({
      method: 'POST',
      url: '/api/keys',
      headers: { 'content-type': 'application/json' },
      payload: { provider: 'openai', apiKey: BYOK_RAW_V2, name: 'byok v2' },
    });
    expect(reg.statusCode).toBe(201);
    const id = reg.json().id as string;

    const rot = await app.inject({
      method: 'POST',
      url: `/api/keys/${id}/rotate`,
      headers: { 'content-type': 'application/json' },
      payload: { apiKey: 'byok-org-secret-v3-cccccccccccc' },
    });
    expect(rot.statusCode).toBe(200);
    expect(rot.json().keyVersion).toBe(2);
    expect(rot.json().maskedKey).toBe('byo…cccc');

    const res = await chat(RAW_A);
    expect(res.json().choices[0].message.content as string).toContain('spy:');
    expect(factoryCalls.at(-1)?.openai).toBe('byok-org-secret-v3-cccccccccccc');

    const audit = await listCustodyAudit(db(), ORG_A, id);
    const rotate = audit.find((a) => a.action === 'rotate');
    expect(rotate).toBeTruthy();
    expect((rotate!.metadata as Record<string, unknown>).toKeyVersion).toBe(2);
  });
});

describe('POST /api/keys/:id/validate', () => {
  it('probes through the provider with the DECRYPTED key + records last_validated_at', async () => {
    const keys = (await app.inject({ method: 'GET', url: '/api/keys' })).json().keys;
    const active = keys.find((k: { status: string }) => k.status === 'active');
    const res = await app.inject({ method: 'POST', url: `/api/keys/${active.id}/validate` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.modelVersion).toBe('spy-v1');
    expect(body.lastValidatedAt).toBeTruthy();

    const row = (await getProviderKeyById(db(), ORG_A, active.id))!;
    expect(row.lastValidatedAt).not.toBeNull();

    const audit = await listCustodyAudit(db(), ORG_A, active.id);
    const validate = audit.find((a) => a.action === 'validate');
    expect(validate).toBeTruthy();
    expect((validate!.metadata as Record<string, unknown>).ok).toBe(true);

    // the audit endpoint serves the trail to the dashboard
    const trail = await app.inject({ method: 'GET', url: `/api/keys/${active.id}/audit` });
    expect(trail.statusCode).toBe(200);
    const actions = trail.json().audit.map((a: { action: string }) => a.action);
    expect(actions).toContain('encrypt');
    expect(actions).toContain('validate');
  });

  it('refuses to validate a revoked key (409)', async () => {
    const keys = (await app.inject({ method: 'GET', url: '/api/keys' })).json().keys;
    const revoked = keys.find((k: { status: string }) => k.status === 'revoked');
    const res = await app.inject({ method: 'POST', url: `/api/keys/${revoked.id}/validate` });
    expect(res.statusCode).toBe(409);
  });
});

describe('RBAC + tenant isolation on key mutations', () => {
  it('member role may NOT rotate/revoke (403 insufficient_role)', async () => {
    const keys = (await app.inject({ method: 'GET', url: '/api/keys' })).json().keys;
    const id = keys[0].id as string;
    const cookie = { cookie: 'potion_session=ps_keys_member_token' };
    const rot = await app.inject({
      method: 'POST',
      url: `/api/keys/${id}/rotate`,
      headers: { ...cookie, 'content-type': 'application/json' },
      payload: { apiKey: 'whatever-raw-key-1234' },
    });
    expect(rot.statusCode).toBe(403);
    expect(rot.json().error.code).toBe('insufficient_role');
    const rev = await app.inject({ method: 'POST', url: `/api/keys/${id}/revoke`, headers: cookie });
    expect(rev.statusCode).toBe(403);
  });

  it("org B's admin key can NEVER touch org A's provider keys (404)", async () => {
    const keys = (await app.inject({ method: 'GET', url: '/api/keys' })).json().keys;
    const id = keys[0].id as string;
    const rot = await authed('POST', `/api/keys/${id}/rotate`, RAW_B_ADMIN, {
      apiKey: 'cross-org-attempt-1234',
    });
    expect(rot.statusCode).toBe(404);
    const rev = await authed('POST', `/api/keys/${id}/revoke`, RAW_B_ADMIN);
    expect(rev.statusCode).toBe(404);
  });
});

describe('api_keys lifecycle (named keys, scopes, revoke, expiry)', () => {
  it('mint → serve → revoke → 401 in the auth hot path', async () => {
    const mint = await app.inject({
      method: 'POST',
      url: '/api/api-keys',
      headers: { 'content-type': 'application/json' },
      payload: { name: 'lifecycle demo', env: 'test', policyId: 'pol-a' },
    });
    expect(mint.statusCode).toBe(201);
    const { id, apiKey: raw } = mint.json();
    expect(raw).toMatch(/^pk_/);
    expect(mint.json().scopes).toBe('serve'); // v1 default
    expect(mint.json().env).toBe('test');

    const ok = await chat(raw);
    expect(ok.statusCode).toBe(200);

    const revoke = await app.inject({ method: 'POST', url: `/api/api-keys/${id}/revoke` });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json().revokedAt).toBeTruthy();

    const dead = await chat(raw);
    expect(dead.statusCode).toBe(401);
    // … and on the dashboard surface too
    const deadDash = await authed('GET', '/api/keys', raw);
    expect(deadDash.statusCode).toBe(401);
  });

  it('expired keys 401 in the auth hot path', async () => {
    const mint = await app.inject({
      method: 'POST',
      url: '/api/api-keys',
      headers: { 'content-type': 'application/json' },
      payload: {
        name: 'already expired',
        policyId: 'pol-a',
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      },
    });
    expect(mint.statusCode).toBe(201);
    const res = await chat(mint.json().apiKey);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('invalid_api_key');
  });

  it("a 'serve'-scoped key may NOT perform admin mutations (403 insufficient_role)", async () => {
    const mint = await app.inject({
      method: 'POST',
      url: '/api/api-keys',
      headers: { 'content-type': 'application/json' },
      payload: { name: 'serve only', policyId: 'pol-a' },
    });
    const raw = mint.json().apiKey as string;
    const res = await authed('POST', '/api/api-keys', raw, { name: 'should fail' });
    expect(res.statusCode).toBe(403);
    // G2.3: the ROLE gate fires first now (serve keys resolve to member
    // before requireRole's scope stage is ever reached); the scope gate
    // remains as defense in depth behind it.
    expect(res.json().error.code).toBe('insufficient_role');
  });

  it('lists keys with lifecycle fields (raw keys never listed)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/api-keys' });
    expect(res.statusCode).toBe(200);
    const keys = res.json().keys as Array<Record<string, unknown>>;
    expect(keys.length).toBeGreaterThanOrEqual(3);
    const demo = keys.find((k) => k.name === 'lifecycle demo')!;
    expect(demo.env).toBe('test');
    expect(demo.revokedAt).toBeTruthy();
    expect(JSON.stringify(keys)).not.toContain('pk_');
  });
});
