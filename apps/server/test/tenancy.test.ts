// Org-isolation tests (M2 Wave 1, ROADMAP #13) — THE tenant gate proof.
// Two orgs (the default org_demo + org_b) each with their own api key,
// policy, provider key, and request logs: org A can NEVER read org B's
// assets through any route. Driven end-to-end via app.inject; zero network.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256, type Policy } from '@potion/core';
import {
  createUser,
  createMembership,
  DEFAULT_ORG_ID,
  getMembershipRole,
  insertApiKey,
  insertPolicy,
  listApiKeys,
  listPolicies,
  listProviderKeys,
  listRequestLogs,
  resolveOrgContext,
} from '@potion/db';
import { saveFrontier } from '@potion/pareto';
import { buildServer } from '../src/server.js';
// G2.4 carryover: cross-tenant suites use TWO DISTINCT NON-DEFAULT orgs from the
// shared fixture — the demo org must never be the probed subject (see the
// fixture header; that assumption is what hid tenancy defect D1).
import { ORG_A, ORG_B, seedIsolationOrgs } from './fixtures/orgs.js';


const RAW_A = 'pk_tenancy_org_a';
const RAW_B = 'pk_tenancy_org_b';

const POLICY_A: Policy = { type: 'max_quality', costCeilingPer1K: 100 };
const POLICY_B: Policy = { type: 'min_cost', qualityFloor: 0.1 };

const CODE_PROMPT = 'Write a python function that reverses a string';

let app: FastifyInstance;
const db = () => app.potion.db.db;

function authed(method: 'GET' | 'POST', url: string, rawKey: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${rawKey}`, 'content-type': 'application/json' },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

beforeAll(async () => {
  app = await buildServer({ seed: false });

  // ---- tenant B (org_demo already exists from the migration) ----
  await seedIsolationOrgs(db());
  await createUser(db(), { id: 'usr_b', email: 'b@tenant.dev', name: 'B User' });
  await createMembership(db(), { orgId: ORG_B, userId: 'usr_b', role: 'member' });

  // ---- per-org keys + policies ----
  await insertPolicy(db(), { id: 'pol-a', orgId: ORG_A, name: 'a', config: POLICY_A });
  await insertApiKey(db(), {
    id: 'key-a',
    keyHash: sha256(RAW_A),
    name: 'a',
    orgId: ORG_A,
    policyId: 'pol-a',
    // G2.3: these fixtures probe admin-grade actions (key rebinding) —
    // explicit admin scope, per the never-soften-the-gate rule.
    scopes: 'serve+admin',
  });
  await insertPolicy(db(), { id: 'pol-b', orgId: ORG_B, name: 'b', config: POLICY_B });
  await insertApiKey(db(), {
    id: 'key-b',
    keyHash: sha256(RAW_B),
    name: 'b',
    orgId: ORG_B,
    policyId: 'pol-b',
    scopes: 'serve+admin',
  });
}, 90_000);

afterAll(async () => {
  await app.close();
});

describe('tenant resolution (auth hook → OrgContext)', () => {
  it('each api key resolves to ITS org (admin role, no userId)', async () => {
    expect(await resolveOrgContext(db(), { kind: 'apiKey', apiKey: RAW_A })).toEqual({
      orgId: ORG_A,
      role: 'admin',
    });
    expect(await resolveOrgContext(db(), { kind: 'apiKey', apiKey: RAW_B })).toEqual({
      orgId: ORG_B,
      role: 'admin',
    });
    // session path (Wave-2 contract) resolves via memberships
    expect(await resolveOrgContext(db(), { kind: 'session', userId: 'usr_b', orgId: ORG_B }))
      .toEqual({ orgId: ORG_B, userId: 'usr_b', role: 'member' });
    expect(await getMembershipRole(db(), ORG_A, 'usr_b')).toBeNull();
  });
});

describe('org isolation via inject', () => {
  it('GET /v1/policies: each key sees only ITS org’s policy', async () => {
    const a = await authed('GET', '/v1/policies', RAW_A);
    expect(a.statusCode).toBe(200);
    expect(a.json().policy).toMatchObject({ id: 'pol-a', config: POLICY_A });

    const b = await authed('GET', '/v1/policies', RAW_B);
    expect(b.statusCode).toBe(200);
    expect(b.json().policy).toMatchObject({ id: 'pol-b', config: POLICY_B });
  });

  it('POST /v1/policies: a new policy lands in the CALLER’s org only', async () => {
    const res = await authed('POST', '/v1/policies', RAW_B, {
      type: 'latency_bound',
      p95Ms: 900,
      name: 'b-fast',
    });
    expect(res.statusCode).toBe(201);
    const newId = res.json().policy.id as string;
    expect((await listPolicies(db(), ORG_B)).map((p) => p.id)).toContain(newId);
    expect((await listPolicies(db(), ORG_A)).map((p) => p.id)).not.toContain(newId);
  });

  it('POST+GET /api/keys: provider keys are per-org (A invisible to B)', async () => {
    const created = await authed('POST', '/api/keys', RAW_A, {
      provider: 'openai',
      apiKey: 'sk-org-a-secret-key-0001',
      name: 'a openai',
    });
    expect(created.statusCode).toBe(201);

    const aList = await authed('GET', '/api/keys', RAW_A);
    expect(aList.json().keys.map((k: { name: string }) => k.name)).toContain('a openai');

    const bList = await authed('GET', '/api/keys', RAW_B);
    expect(bList.json().keys.map((k: { name: string }) => k.name)).not.toContain('a openai');

    expect((await listProviderKeys(db(), ORG_A)).map((k) => k.name)).toContain('a openai');
    expect((await listProviderKeys(db(), ORG_B))).toHaveLength(0);

    // the SAME raw key may be re-registered by org B (per-org custody)
    const bCopy = await authed('POST', '/api/keys', RAW_B, {
      provider: 'openai',
      apiKey: 'sk-org-a-secret-key-0001',
      name: 'b copy',
    });
    expect(bCopy.statusCode).toBe(201);
    expect(bCopy.json().id).not.toBe(created.json().id);
  });

  it('POST /api/policies: binding a key id from ANOTHER org 404s', async () => {
    const before = (await authed('GET', '/v1/policies', RAW_B)).json().policy.id as string;
    const res = await authed('POST', '/api/policies', RAW_A, {
      policy: { type: 'min_cost', qualityFloor: 0.5 },
      keyId: 'key-b', // belongs to org B
    });
    expect(res.statusCode).toBe(404);
    // org B's key is untouched
    const b = await authed('GET', '/v1/policies', RAW_B);
    expect(b.json().policy.id).toBe(before);
  });

  it('POST /api/policies createKey: the fresh key belongs to the caller’s org', async () => {
    const res = await authed('POST', '/api/policies', RAW_B, {
      policy: { type: 'max_quality', costCeilingPer1K: 5 },
      createKey: true,
      name: 'b-extra',
    });
    expect(res.statusCode).toBe(201);
    const { boundKeyId, apiKey } = res.json();
    expect((await listApiKeys(db(), ORG_B)).map((k) => k.id)).toContain(boundKeyId);
    expect((await listApiKeys(db(), ORG_A)).map((k) => k.id)).not.toContain(boundKeyId);
    // and it authenticates into org B — MEMBER grade (G2.3): minted keys
    // default to the 'serve' scope; admin is an explicit choice.
    expect(await resolveOrgContext(db(), { kind: 'apiKey', apiKey })).toEqual({
      orgId: ORG_B,
      role: 'member',
    });
  });

  it('request_logs rows carry the caller’s org and are invisible cross-org', async () => {
    await saveFrontier(db(), 'code-gen', [
      {
        clusterId: 'code-gen',
        strategyHash: 'sh',
        strategyConfig: { type: 'single', model: 'mock-mid' },
        quality: 0.9,
        costPer1K: 1,
        latencyP95: 900,
      },
    ], 'manual', '2026-08-04');

    const aChat = await authed('POST', '/v1/chat/completions', RAW_A, {
      model: 'potion-auto',
      messages: [{ role: 'user', content: CODE_PROMPT }],
    });
    expect(aChat.statusCode).toBe(200);
    const bChat = await authed('POST', '/v1/chat/completions', RAW_B, {
      model: 'potion-auto',
      messages: [{ role: 'user', content: CODE_PROMPT }],
    });
    expect(bChat.statusCode).toBe(200);

    const aLogs = await listRequestLogs(db(), ORG_A, 100);
    const bLogs = await listRequestLogs(db(), ORG_B, 100);
    expect(aLogs.length).toBeGreaterThan(0);
    expect(bLogs).toHaveLength(1);
    for (const row of aLogs) expect(row.orgId).toBe(ORG_A);
    expect(bLogs[0]!.orgId).toBe(ORG_B);
    expect(bLogs[0]!.apiKeyId).toBe('key-b');
    // org A's log for this request is keyed by key-a, not visible to B
    expect(aLogs.some((l) => l.apiKeyId === 'key-b')).toBe(false);
    expect(bLogs.some((l) => l.apiKeyId === 'key-a')).toBe(false);
  });

  it('unauthenticated dashboard traffic is scoped to the default org', async () => {
    // No bearer → the DEFAULT org (documented local-tool surface until Wave-2
    // #14). G2.4 carryover: this used to assert 'a openai' is visible, which
    // only held because ORG_A *was* the default org — the coincidence that hid
    // tenancy defect D1. With distinct subjects the real claim is visible: the
    // fallback lands on the demo org and sees NEITHER tenant's rows.
    const res = await app.inject({ method: 'GET', url: '/api/keys' });
    expect(res.statusCode).toBe(200);
    const names = res.json().keys.map((k: { name: string }) => k.name);
    expect(names).not.toContain('a openai'); // org A is a real tenant, not the fallback
    expect(names).not.toContain('b copy'); // org B's copy stays hidden
    expect(await listProviderKeys(db(), DEFAULT_ORG_ID)).toEqual([]);
  });
});
