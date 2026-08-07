// Operator surface tests (G2.7) — fail-closed credential, org lifecycle
// (create 201 + working magic link, existing 409, org_demo delete 409,
// unknown 404, delete 202 → job → org gone), and the self-serve gate.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { getOrgById, getUserByEmail, DEFAULT_ORG_ID } from '@potion/db';
import { buildServer } from '../src/server.js';

let app: FastifyInstance;
const TOKEN = 'op_test_token_1234567890';
const OP = { authorization: `Bearer ${TOKEN}` };
const OP_JSON = { ...OP, 'content-type': 'application/json' };

async function waitJob(jobId: string, timeoutMs = 120_000): Promise<{ state: string; result?: unknown }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await app.inject({ method: 'GET', url: `/operator/jobs/${jobId}`, headers: OP });
    const body = res.json() as { state: string; result?: unknown };
    if (body.state === 'completed' || body.state === 'failed') return body;
    if (Date.now() > deadline) throw new Error(`job ${jobId} did not settle`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

beforeAll(async () => {
  process.env.POTION_OPERATOR_TOKEN = TOKEN;
  app = await buildServer();
}, 120_000);

afterAll(async () => {
  delete process.env.POTION_OPERATOR_TOKEN;
  delete process.env.POTION_SELF_SERVE;
  await app.close();
});

afterEach(() => {
  process.env.POTION_OPERATOR_TOKEN = TOKEN;
  delete process.env.POTION_SELF_SERVE;
});

describe('operator credential (fail-closed)', () => {
  it('unset env → 401 for a correct-looking token; wrong token → 401; no token → 401', async () => {
    delete process.env.POTION_OPERATOR_TOKEN;
    const unset = await app.inject({ method: 'GET', url: '/operator/orgs', headers: OP });
    expect(unset.statusCode).toBe(401);
    process.env.POTION_OPERATOR_TOKEN = TOKEN;
    const wrong = await app.inject({
      method: 'GET',
      url: '/operator/orgs',
      headers: { authorization: 'Bearer nope' },
    });
    expect(wrong.statusCode).toBe(401);
    const none = await app.inject({ method: 'GET', url: '/operator/orgs' });
    expect(none.statusCode).toBe(401);
    const right = await app.inject({ method: 'GET', url: '/operator/orgs', headers: OP });
    expect(right.statusCode).toBe(200);
  });
});

describe('operator org lifecycle', () => {
  it('create 201 + magic link verifies to a working admin session; duplicate id 409', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/operator/orgs',
      headers: OP_JSON,
      payload: { id: 'org-optest', name: 'Op Test Org', adminEmail: 'partner@optest.dev' },
    });
    expect(create.statusCode).toBe(201);
    const body = create.json() as { orgId: string; magicLink: string };
    expect(body.orgId).toBe('org-optest');
    expect(body.magicLink).toContain('/auth/verify?token=');
    // the link is a REAL magic link → session cookie for the new org
    const url = new URL(body.magicLink);
    const verify = await app.inject({ method: 'GET', url: url.pathname + url.search });
    expect([200, 302]).toContain(verify.statusCode);
    const setCookie = String(verify.headers['set-cookie'] ?? '');
    expect(setCookie).toContain('potion_session=');
    const token = /potion_session=([^;]+)/.exec(setCookie)![1]!;
    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: `potion_session=${token}` },
    });
    expect(me.statusCode).toBe(200);
    const meBody = me.json() as { org: { id: string }; role: string };
    expect(meBody.org.id).toBe('org-optest');
    expect(meBody.role).toBe('admin');

    const dup = await app.inject({
      method: 'POST',
      url: '/operator/orgs',
      headers: OP_JSON,
      payload: { id: 'org-optest', name: 'Again', adminEmail: 'partner@optest.dev' },
    });
    expect(dup.statusCode).toBe(409);
  });

  it('delete: org_demo 409, unknown 404, real org 202 → job completes → org gone, repeat 404', async () => {
    const demo = await app.inject({ method: 'DELETE', url: `/operator/orgs/${DEFAULT_ORG_ID}`, headers: OP });
    expect(demo.statusCode).toBe(409);
    const unknown = await app.inject({ method: 'DELETE', url: '/operator/orgs/org-nope', headers: OP });
    expect(unknown.statusCode).toBe(404);

    const create = await app.inject({
      method: 'POST',
      url: '/operator/orgs',
      headers: OP_JSON,
      payload: { id: 'org-doomed', name: 'Doomed', adminEmail: 'doomed@optest.dev' },
    });
    expect(create.statusCode).toBe(201);
    const del = await app.inject({ method: 'DELETE', url: '/operator/orgs/org-doomed', headers: OP });
    expect(del.statusCode).toBe(202);
    const job = await waitJob((del.json() as { jobId: string }).jobId);
    expect(job.state).toBe('completed');
    const report = job.result as { deleted: Record<string, number>; usersErased: number };
    expect(report.deleted.orgs).toBe(1);
    expect(await getOrgById(app.potion.db.db, 'org-doomed')).toBeNull();
    const again = await app.inject({ method: 'DELETE', url: '/operator/orgs/org-doomed', headers: OP });
    expect(again.statusCode).toBe(404);
  }, 120_000);
});

describe('self-serve gate (G2.7)', () => {
  it('OFF: unknown email → neutral 200, ZERO rows; existing user still gets a link; ON restores provisioning', async () => {
    process.env.POTION_SELF_SERVE = '0';
    const unknown = await app.inject({
      method: 'POST',
      url: '/auth/request-link',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'stranger@nowhere.dev' },
    });
    expect(unknown.statusCode).toBe(200);
    expect((unknown.json() as { ok: boolean }).ok).toBe(true);
    expect((unknown.json() as { devLink?: string }).devLink).toBeUndefined();
    expect(await getUserByEmail(app.potion.db.db, 'stranger@nowhere.dev')).toBeNull();

    // existing member (seeded demo user) still gets a link
    const existing = await app.inject({
      method: 'POST',
      url: '/auth/request-link',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'demo@potion.dev' },
    });
    expect(existing.statusCode).toBe(200);
    expect((existing.json() as { devLink?: string }).devLink).toBeTruthy();

    // gate ON → stranger provisioning works again
    process.env.POTION_SELF_SERVE = '1';
    const nowOn = await app.inject({
      method: 'POST',
      url: '/auth/request-link',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'stranger@nowhere.dev' },
    });
    expect(nowOn.statusCode).toBe(200);
    expect(await getUserByEmail(app.potion.db.db, 'stranger@nowhere.dev')).not.toBeNull();
  });
});
