// G2.4 Leg D — regression pins for the isolation defects the exhaustive sweep
// surfaced. Each test FAILED before its fix and names the defect.
//
// The load-bearing test-design decision: ORG_A is NOT DEFAULT_ORG_ID. Every
// pre-G2.4 isolation test set ORG_A = DEFAULT_ORG_ID, which is exactly what
// hid D1 — a bearer-only resolver that falls back to org_demo looks correct
// when the org under test IS org_demo.
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
  insertResearchCycle,
  listUsageDaily,
  usageDaily,
} from '@potion/db';
import { buildServer } from '../src/server.js';

const ORG_A = 'org_g24_a'; // deliberately NOT org_demo — see header
const ORG_B = 'org_g24_b';
const KEY_A = 'pk_g24_a';
const KEY_B = 'pk_g24_b';
const COOKIE_A = 'potion_session=ps_g24_a';
const COOKIE_B = 'potion_session=ps_g24_b';
const POLICY: Policy = { type: 'min_cost', qualityFloor: 0 };

let app: FastifyInstance;
let devAuthBefore: string | undefined;
const db = () => app.potion.db.db;

async function seedOrg(orgId: string, rawKey: string, sessionToken: string, userId: string) {
  await createOrg(db(), { id: orgId, name: orgId });
  await insertPolicy(db(), { id: `pol-${orgId}`, orgId, name: 'p', config: POLICY });
  await insertApiKey(db(), {
    id: `key-${orgId}`,
    keyHash: sha256(rawKey),
    name: 'k',
    orgId,
    policyId: `pol-${orgId}`,
    scopes: 'serve+admin', // admin probes must reach the TENANCY check, not 403 on role
  });
  await createUser(db(), { id: userId, email: `${userId}@g24.dev`, name: userId });
  await createMembership(db(), { orgId, userId, role: 'admin' });
  await createSession(db(), {
    id: `ses-${orgId}`,
    userId,
    tokenHash: sha256(sessionToken),
    orgId,
    expiresAt: new Date(Date.now() + 3600_000),
  });
}

beforeAll(async () => {
  devAuthBefore = process.env.POTION_DEV_AUTH;
  process.env.POTION_DEV_AUTH = '0'; // no bypass — credentials are the only way in
  app = await buildServer({ seed: false });
  await seedOrg(ORG_A, KEY_A, 'ps_g24_a', 'usr_g24_a');
  await seedOrg(ORG_B, KEY_B, 'ps_g24_b', 'usr_g24_b');
  // The demo org exists in production as the unauth-log fallback; give it
  // distinctive spend so a fallback to it is unmistakable.
  await createOrg(db(), { id: DEFAULT_ORG_ID, name: 'Demo' });
  await insertRequestLog(db(), {
    orgId: DEFAULT_ORG_ID,
    clusterId: 'code-gen',
    status: 'ok',
    usage: { inputTokens: 999, outputTokens: 999, costUsd: 9.99, latencyMs: 1 },
  });
  // ORG_A's own, smaller spend.
  await insertRequestLog(db(), {
    orgId: ORG_A,
    clusterId: 'code-gen',
    status: 'ok',
    usage: { inputTokens: 10, outputTokens: 10, costUsd: 0.11, latencyMs: 1 },
  });
}, 30000);

afterAll(async () => {
  if (devAuthBefore === undefined) delete process.env.POTION_DEV_AUTH;
  else process.env.POTION_DEV_AUTH = devAuthBefore;
  await app.close();
});

describe('D1 — session-cookie callers must read THEIR org, never the demo fallback', () => {
  // Pre-fix: routes/usage.ts resolveRequestOrg was bearer-only and returned
  // {orgId: DEFAULT_ORG_ID} for cookie callers — i.e. every dashboard user
  // read org_demo's usage, invoices and savings.
  for (const [label, url] of [
    ['GET /api/usage/current', '/api/usage/current'],
    ['GET /api/usage', '/api/usage'],
    ['GET /api/usage/export.csv', '/api/usage/export.csv'],
    ['GET /api/reports/savings', '/api/reports/savings'],
    ['GET /api/reports/savings.csv', '/api/reports/savings.csv'],
  ] as const) {
    it(`${label} scopes to the COOKIE caller's org`, async () => {
      const res = await app.inject({ method: 'GET', url, headers: { cookie: COOKIE_A } });
      expect(res.statusCode).toBe(200);
      const body = res.body;
      // org_demo's 9.99 must never appear for an ORG_A caller.
      expect(body).not.toContain('9.99');
      expect(body).not.toContain(DEFAULT_ORG_ID);
    });
  }

  it('GET /api/usage/invoice bills the cookie caller org, not the demo org', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/usage/invoice?period=' + new Date().toISOString().slice(0, 7),
      headers: { cookie: COOKIE_A },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().orgId).toBe(ORG_A);
  });

  it('an unauthenticated caller is refused, never silently widened to the demo org', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/usage/current' });
    expect([401, 403]).toContain(res.statusCode);
  });
});

describe('D2 — platform sweep jobs (no orgId payload) are invisible on /api/jobs/:id', () => {
  // Pre-fix: jobs.ts only 404'd when payload.orgId was a STRING mismatch, so
  // the platform sweeps enqueued with {} returned cross-tenant result bodies
  // (per-org breaches, budgets, cluster and purge rows) to any viewer.
  it('a job enqueued with an orgId-less payload 404s for every org caller', async () => {
    const jobId = await app.potion.queue!.enqueue('guarantee:evaluate', {});
    for (const headers of [{ authorization: `Bearer ${KEY_A}` }, { cookie: COOKIE_B }]) {
      const res = await app.inject({ method: 'GET', url: `/api/jobs/${jobId}`, headers });
      expect(res.statusCode).toBe(404);
    }
  });

  it("an org's OWN job stays visible (the guard is scoping, not a blanket block)", async () => {
    const jobId = await app.potion.queue!.enqueue('guarantee:evaluate', { orgId: ORG_A });
    const mine = await app.inject({
      method: 'GET',
      url: `/api/jobs/${jobId}`,
      headers: { authorization: `Bearer ${KEY_A}` },
    });
    expect(mine.statusCode).toBe(200);
    const theirs = await app.inject({
      method: 'GET',
      url: `/api/jobs/${jobId}`,
      headers: { authorization: `Bearer ${KEY_B}` },
    });
    expect(theirs.statusCode).toBe(404);
  });
});

describe('D5 — the viewer-reachable invoice must not rewrite every org’s usage rollup', () => {
  // Pre-fix: GET /api/usage/invoice called the GLOBAL aggregateUsage(db, range)
  // — a full usage_daily rewrite triggered by any viewer, for every tenant.
  it('generating ORG_B’s invoice leaves other orgs’ usage_daily untouched', async () => {
    const period = new Date().toISOString().slice(0, 7);
    // Plant a deliberately WRONG rollup row for ORG_A: a global re-aggregate
    // would correct it, an org-scoped one must not touch it.
    await db()
      .insert(usageDaily)
      .values({
        orgId: ORG_A,
        day: `${period}-01`,
        clusterId: 'sentinel',
        requests: 4242,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        platformCostUsd: 0,
      })
      .onConflictDoNothing();
    const res = await app.inject({
      method: 'GET',
      url: `/api/usage/invoice?period=${period}`,
      headers: { authorization: `Bearer ${KEY_B}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().orgId).toBe(ORG_B);
    const aRows = await listUsageDaily(db(), ORG_A, { fromDay: `${period}-01`, toDay: `${period}-28` });
    const sentinel = aRows.find((r) => r.clusterId === 'sentinel');
    expect(sentinel, 'ORG_A sentinel row was rewritten by ORG_B’s invoice call').toBeTruthy();
    expect(sentinel!.requests).toBe(4242);
  });
});

describe('recipes lineage — research cycles must be org-scoped (the third reader)', () => {
  // G1.8 scoped listResearchCycles at two of three call sites; the /api/recipes
  // lineage reader stayed global, leaking other tenants' cycle ids/focus aliases.
  it("ORG_A's cycle does not appear in ORG_B's /api/recipes lineage", async () => {
    // The lineage reader joins cycles to eval rows by strategy hash; the
    // cycle row alone is enough to prove the leak (its id/focusAlias are what
    // surfaced cross-tenant).
    await insertResearchCycle(db(), {
      trigger: 'scan',
      status: 'completed',
      focusAlias: 'secret-alias-org-a',
      orgId: ORG_A,
      provenance: 'mock',
      candidates: [],
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/recipes',
      headers: { authorization: `Bearer ${KEY_B}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('secret-alias-org-a');
    // ORG_A sees its own cycle (scoping, not blanket suppression).
    const mine = await app.inject({
      method: 'GET',
      url: '/api/research/cycles',
      headers: { authorization: `Bearer ${KEY_A}` },
    });
    expect(mine.body).toContain('secret-alias-org-a');
  });
});
