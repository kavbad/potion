// Adversarial tenant-isolation tests (ROADMAP #29, SPEC §12.9 — M2 security
// follow-up). Where tenancy.test.ts proves the POSITIVE contract (each org
// sees its own assets), this file attacks the NEGATIVE space:
//   · forged org headers (x-org-id etc.) must be ignored — authentication IS
//     tenant resolution; no header ever overrides the credential's org
//   · cross-org id enumeration (keys/jobs/api-keys) → 404/403, never data
//   · tampered/forged session cookies → 401 (dev bypass disabled here)
//   · org A credentials can never read org B usage/reports/key material
//
// ALL cases run with POTION_DEV_AUTH=0 (the dev-mode bypass OFF) so a broken
// credential cannot silently fall through to the default org.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256, type Policy } from '@potion/core';
import {
  DEFAULT_ORG_ID,
  createMembership,
  createOrg,
  createSession,
  createUser,
  insertApiKey,
  insertPolicy,
  insertRequestLog,
  insertShadowResult,
  listApiKeys,
  listPolicies,
  listProviderKeys,
  utcDay,
} from '@potion/db';
import { buildServer } from '../src/server.js';

const ORG_A = DEFAULT_ORG_ID; // 'org_demo'
const ORG_B = 'org_iso_b';

const RAW_A = 'pk_iso_org_a';
const RAW_A_ADMIN = 'pk_iso_org_a_admin'; // scopes 'serve+admin' → reaches org-scoped lookups
const RAW_B = 'pk_iso_org_b';
const SESSION_A_RAW = 'ps_iso_session_a_token_0001';

const POLICY_A: Policy = { type: 'min_cost', qualityFloor: 0.1 };

let app: FastifyInstance;
const db = () => app.potion.db.db;
const SAVED_DEV_AUTH = process.env.POTION_DEV_AUTH;

function inject(opts: {
  method: 'GET' | 'POST';
  url: string;
  key?: string;
  cookie?: string;
  headers?: Record<string, string>;
  payload?: unknown;
}) {
  return app.inject({
    method: opts.method,
    url: opts.url,
    headers: {
      ...(opts.payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}),
      ...(opts.cookie ? { cookie: `potion_session=${opts.cookie}` } : {}),
      ...(opts.headers ?? {}),
    },
    ...(opts.payload !== undefined ? { payload: opts.payload as Record<string, unknown> } : {}),
  });
}

beforeAll(async () => {
  process.env.POTION_DEV_AUTH = '0'; // bypass OFF — bad credentials MUST 401
  app = await buildServer({ seed: false });

  await createOrg(db(), { id: ORG_B, name: 'Isolation Org B' });
  await createUser(db(), { id: 'usr_iso_a', email: 'a@iso.dev', name: 'A' });
  await createUser(db(), { id: 'usr_iso_b', email: 'b@iso.dev', name: 'B' });
  await createMembership(db(), { orgId: ORG_A, userId: 'usr_iso_a', role: 'member' });
  await createMembership(db(), { orgId: ORG_B, userId: 'usr_iso_b', role: 'member' });

  await insertPolicy(db(), { id: 'pol-iso-a', orgId: ORG_A, name: 'a', config: POLICY_A });
  await insertPolicy(db(), { id: 'pol-iso-b', orgId: ORG_B, name: 'b', config: { type: 'min_cost', qualityFloor: 0.2 } });
  await insertApiKey(db(), { id: 'key-iso-a', keyHash: sha256(RAW_A), name: 'a', orgId: ORG_A, policyId: 'pol-iso-a' });
  await insertApiKey(db(), {
    id: 'key-iso-a-admin',
    keyHash: sha256(RAW_A_ADMIN),
    name: 'a-admin',
    orgId: ORG_A,
    policyId: 'pol-iso-a',
    scopes: 'serve+admin',
  });
  await insertApiKey(db(), { id: 'key-iso-b', keyHash: sha256(RAW_B), name: 'b', orgId: ORG_B, policyId: 'pol-iso-b' });

  // A live dashboard session pinned to org A.
  await createSession(db(), {
    id: 'sess-iso-a',
    userId: 'usr_iso_a',
    orgId: ORG_A,
    tokenHash: sha256(SESSION_A_RAW),
    expiresAt: new Date(Date.now() + 3_600_000),
  });

  // Per-org provider keys (via the API, so custody rows are real).
  const aKey = await inject({
    method: 'POST',
    url: '/api/keys',
    key: RAW_A,
    payload: { provider: 'openai', apiKey: 'sk-iso-org-a-provider-key', name: 'a prov' },
  });
  expect(aKey.statusCode).toBe(201);
  const bKey = await inject({
    method: 'POST',
    url: '/api/keys',
    key: RAW_B,
    payload: { provider: 'openai', apiKey: 'sk-iso-org-b-provider-key', name: 'b prov' },
  });
  expect(bKey.statusCode).toBe(201);

  // Usage evidence for both orgs (live usage rollup reads request_logs).
  await insertRequestLog(db(), { orgId: ORG_A, apiKeyId: 'key-iso-a', model: 'mock-mid', usage: { inputTokens: 100, outputTokens: 50, costUsd: 1.5 } });
  await insertRequestLog(db(), { orgId: ORG_B, apiKeyId: 'key-iso-b', model: 'mock-mid', usage: { inputTokens: 777, outputTokens: 777, costUsd: 77.7 } });
  // Shadow evidence for org B only.
  await insertShadowResult(db(), {
    orgId: ORG_B,
    requestId: 'chatcmpl-iso-b',
    clusterId: 'code-gen',
    primaryHash: 'hp',
    candidateHash: 'hc',
    candidateModel: 'mock-cheap',
    quality: 0.5,
    costUsd: 0.01,
    latencyMs: 100,
  });
}, 90_000);

afterAll(async () => {
  await app.close();
  if (SAVED_DEV_AUTH === undefined) delete process.env.POTION_DEV_AUTH;
  else process.env.POTION_DEV_AUTH = SAVED_DEV_AUTH;
});

// ---------- forged org headers ----------

describe('forged org headers (x-org-id & friends are ignored)', () => {
  it('1. x-org-id: <org B> with an org A key does NOT cross tenants (/auth/me)', async () => {
    const res = await inject({ method: 'GET', url: '/auth/me', key: RAW_A, headers: { 'x-org-id': ORG_B } });
    expect(res.statusCode).toBe(200);
    expect(res.json().org.id).toBe(ORG_A);
  });

  it('2. x-org-id alone (no credential, bypass OFF) → 401, not org B', async () => {
    const res = await inject({ method: 'GET', url: '/api/usage/current', headers: { 'x-org-id': ORG_B } });
    expect(res.statusCode).toBe(401);
  });

  it('3. x-org-id + x-potion-org + org_id query param combined — usage still scoped to the key’s org', async () => {
    const res = await inject({
      method: 'GET',
      url: '/api/usage/current?org_id=org_iso_b',
      key: RAW_A,
      headers: { 'x-org-id': ORG_B, 'x-potion-org': ORG_B },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().orgId).toBe(ORG_A);
    // and org B's usage (77.7 cost) is nowhere in the payload
    expect(res.json().mtd.costUsd).toBeLessThan(77);
  });

  it('4. valid org A session cookie + forged x-org-id: org B — session org wins', async () => {
    const res = await inject({ method: 'GET', url: '/auth/me', cookie: SESSION_A_RAW, headers: { 'x-org-id': ORG_B } });
    expect(res.statusCode).toBe(200);
    expect(res.json().org.id).toBe(ORG_A);
    expect(res.json().user.id).toBe('usr_iso_a');
  });

  it('5. GET /v1/policies with a forged org header returns the CREDENTIAL’s policy', async () => {
    const res = await inject({ method: 'GET', url: '/v1/policies', key: RAW_A, headers: { 'x-org-id': ORG_B } });
    expect(res.statusCode).toBe(200);
    expect(res.json().policy.id).toBe('pol-iso-a');
  });
});

// ---------- cross-org id enumeration ----------

describe('cross-org id enumeration → 404/403, never data', () => {
  it('6. GET /api/keys/<org-B-provider-key>/audit with org A key → 404, no metadata leak', async () => {
    const bProvId = (await listProviderKeys(db(), ORG_B))[0]!.id;
    const res = await inject({ method: 'GET', url: `/api/keys/${bProvId}/audit`, key: RAW_A });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('sk-iso-org-b');
    expect(res.body).not.toContain('b prov');
  });

  it('7. POST /api/keys/<org-B-key>/rotate with org A admin key → 404; org B row untouched', async () => {
    const bProvId = (await listProviderKeys(db(), ORG_B))[0]!.id;
    const res = await inject({
      method: 'POST',
      url: `/api/keys/${bProvId}/rotate`,
      key: RAW_A_ADMIN,
      payload: { apiKey: 'sk-attacker-controlled-new-key' },
    });
    expect(res.statusCode).toBe(404);
    const after = (await listProviderKeys(db(), ORG_B))[0]!;
    expect(after.name).toBe('b prov'); // unchanged
  });

  it('8. GET /api/jobs/<org-B-job> with org A key → 404 (existence not leaked); org B reads it fine', async () => {
    const enq = await inject({
      method: 'POST',
      url: '/api/evals',
      key: RAW_B,
      payload: { suiteIds: ['iso-suite'], strategies: [{ type: 'single', model: 'mock-cheap' }] },
    });
    expect(enq.statusCode).toBe(202);
    const jobId = enq.json().jobId as string;

    const cross = await inject({ method: 'GET', url: `/api/jobs/${jobId}`, key: RAW_A });
    expect(cross.statusCode).toBe(404);

    const own = await inject({ method: 'GET', url: `/api/jobs/${jobId}`, key: RAW_B });
    expect(own.statusCode).toBe(200);
    expect(own.json().id).toBe(jobId);
  });

  it('9. POST /api/api-keys/<org-B-key-id>/revoke with org A admin key → 404; org B key still authenticates', async () => {
    const res = await inject({ method: 'POST', url: '/api/api-keys/key-iso-b/revoke', key: RAW_A_ADMIN });
    expect([403, 404]).toContain(res.statusCode);
    // org B's key is still live — it resolves and serves
    const me = await inject({ method: 'GET', url: '/auth/me', key: RAW_B });
    expect(me.statusCode).toBe(200);
    expect(me.json().org.id).toBe(ORG_B);
  });

  it('10. POST /api/policies mass-assignment: body orgId is ignored — the policy lands in the CALLER’s org', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/policies',
      key: RAW_A,
      payload: { policy: { type: 'min_cost', qualityFloor: 0.9 }, createKey: true, name: 'iso-massassign', orgId: ORG_B },
    });
    expect(res.statusCode).toBe(201);
    const policyId = res.json().policy.id as string;
    expect((await listPolicies(db(), ORG_A)).map((p) => p.id)).toContain(policyId);
    expect((await listPolicies(db(), ORG_B)).map((p) => p.id)).not.toContain(policyId);
  });
});

// ---------- session cookie tampering ----------

describe('session cookie tampering → 401 (bypass OFF)', () => {
  it('11. flipping bytes in a valid session token → 401 on every /api/* surface', async () => {
    // sanity: the untampered token works
    const good = await inject({ method: 'GET', url: '/api/usage/current', cookie: SESSION_A_RAW });
    expect(good.statusCode).toBe(200);

    const tampered = SESSION_A_RAW.split('').map((c, i) => (i % 7 === 3 ? (c === 'a' ? 'b' : 'a') : c)).join('');
    expect(tampered).not.toBe(SESSION_A_RAW);
    for (const url of ['/api/usage/current', '/api/keys', '/api/reports/savings?from=2020-01-01&to=2020-01-02', '/api/api-keys']) {
      const res = await inject({ method: 'GET', url, cookie: tampered });
      expect(res.statusCode).toBe(401);
    }
  });

  it('12. a fully forged session token (valid ps_ shape, unknown) → 401', async () => {
    const res = await inject({ method: 'GET', url: '/auth/me', cookie: 'ps_forged_token_that_never_existed_000' });
    expect(res.statusCode).toBe(401);
  });

  it('13. a session pinned to an org the user is NOT a member of → 401 (no cross-tenant pinning)', async () => {
    // usr_iso_a has NO membership in org B — a session pinning them there
    // (e.g. minted before a membership removal) must be dead on arrival.
    await createSession(db(), {
      id: 'sess-iso-cross',
      userId: 'usr_iso_a',
      orgId: ORG_B,
      tokenHash: sha256('ps_iso_session_cross_0001'),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const res = await inject({ method: 'GET', url: '/api/usage/current', cookie: 'ps_iso_session_cross_0001' });
    expect(res.statusCode).toBe(401);
  });
});

// ---------- cross-org reads on metering / reports / key surfaces ----------

describe('org A credentials never read org B data', () => {
  it('14. GET /api/usage/current with org A key → org A scope + totals, never org B’s 77.7', async () => {
    const res = await inject({ method: 'GET', url: '/api/usage/current', key: RAW_A });
    expect(res.statusCode).toBe(200);
    expect(res.json().orgId).toBe(ORG_A);
    expect(res.body).not.toContain('77.7');
  });

  it('15. GET /api/reports/savings with org A key → report scoped to org A, org B shadow evidence absent', async () => {
    const today = utcDay();
    const res = await inject({ method: 'GET', url: `/api/reports/savings?from=${today}&to=${today}`, key: RAW_A });
    expect(res.statusCode).toBe(200);
    expect(res.json().scope?.orgId ?? res.json().orgId).toBe(ORG_A);
    expect(res.body).not.toContain('chatcmpl-iso-b');
  });

  it('16. GET /api/api-keys with org A key lists ONLY org A key ids', async () => {
    const res = await inject({ method: 'GET', url: '/api/api-keys', key: RAW_A });
    expect(res.statusCode).toBe(200);
    const ids = (await listApiKeys(db(), ORG_B)).map((k) => k.id);
    expect(ids).toContain('key-iso-b'); // sanity: org B keys exist
    expect(res.body).not.toContain('key-iso-b');
    for (const id of ids) expect(res.body).not.toContain(id);
  });

  it('17. org A session cookie cannot list org B provider keys', async () => {
    const res = await inject({ method: 'GET', url: '/api/keys', cookie: SESSION_A_RAW });
    expect(res.statusCode).toBe(200);
    const names = res.json().keys.map((k: { name: string }) => k.name);
    expect(names).toContain('a prov');
    expect(names).not.toContain('b prov');
  });

  it('18. malformed bearer (key material of org B with one char flipped) → 401, no existence oracle', async () => {
    const mid = Math.floor(RAW_B.length / 2);
    const forged = `${RAW_B.slice(0, mid)}${RAW_B[mid] === 'x' ? 'y' : 'x'}${RAW_B.slice(mid + 1)}`;
    expect(forged).not.toBe(RAW_B);
    expect(forged).not.toBe(RAW_A);
    const res = await inject({ method: 'GET', url: '/api/usage/current', key: forged });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain(ORG_B);
  });
});
