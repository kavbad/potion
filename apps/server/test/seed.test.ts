// Boot-seed test: a fresh PGlite boot with seed ENABLED must produce the
// demo dataset (demo key + 3 policies + harness/pareto-computed frontiers
// for code-gen + extraction) and serve requests end to end — zero network.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  DEFAULT_ORG_ID,
  getMembershipRole,
  getOrgById,
  getUserByEmail,
  listApiKeys,
  listPolicies,
} from '@potion/db';
import { buildServer } from '../src/server.js';
import { DEMO_API_KEY, DEMO_USER_EMAIL, DEMO_USER_ID } from '../src/seed.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer(); // seed: true (default)
}, 120_000);

afterAll(async () => {
  await app.close();
});

describe('demo seed', () => {
  it('seeds the demo tenant (org_demo + usr_demo admin membership)', async () => {
    const db = app.potion.db.db;
    expect(await getOrgById(db, DEFAULT_ORG_ID)).toMatchObject({ id: 'org_demo', name: 'Demo Org' });
    expect(await getUserByEmail(db, DEMO_USER_EMAIL)).toMatchObject({ id: DEMO_USER_ID });
    expect(await getMembershipRole(db, DEFAULT_ORG_ID, DEMO_USER_ID)).toBe('admin');
  });

  it('seeds 1 demo key + 3 policies (one of each type), all org_demo-scoped', async () => {
    expect(app.potion.seeded).toBe(true);
    const keys = await listApiKeys(app.potion.db.db, DEFAULT_ORG_ID);
    const policies = await listPolicies(app.potion.db.db, DEFAULT_ORG_ID);
    expect(keys).toHaveLength(1);
    expect(keys[0]!.orgId).toBe(DEFAULT_ORG_ID);
    expect(keys[0]!.policyId).toBe('pol-demo-max-quality');
    expect(new Set(policies.map((p) => p.orgId))).toEqual(new Set([DEFAULT_ORG_ID]));
    expect(new Set(policies.map((p) => p.config.type))).toEqual(
      new Set(['max_quality', 'min_cost', 'latency_bound']),
    );
  });

  it('computes frontiers for code-gen + extraction via harness+pareto', async () => {
    for (const clusterId of ['code-gen', 'extraction']) {
      const res = await app.inject({ method: 'GET', url: `/api/frontiers/${clusterId}` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.frontier.version).toBe(1);
      expect(body.frontier.points.length).toBeGreaterThanOrEqual(2);
      for (const p of body.frontier.points) expect(p.dominated).toBe(false);
      expect(body.operatingPoint).not.toBeNull();
    }
  });

  it('serves a real request on the seeded frontier', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${DEMO_API_KEY}`, 'content-type': 'application/json' },
      payload: {
        model: 'potion-auto',
        messages: [{ role: 'user', content: 'Write a python function that reverses a string' }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-frontier-trace']).toMatch(
      /^cluster=code-gen;strategy=[0-9a-f]{8};frontier=v1;policy=max_quality;fallback=[01];provenance=mock$/,
    );
    expect(res.json().choices[0].message.content.length).toBeGreaterThan(0);
  });
});
