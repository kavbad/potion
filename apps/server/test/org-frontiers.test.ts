// G1.6 per-org frontier route tests — seeded PGlite server, zero network.
//   · GET /api/frontiers/:clusterId — cross-org agent cluster → uniform 404
//     (pre-G1.6 a guessed agent-<hash>-<sig> id returned another tenant's
//     points); own agent cluster → the ORG frontier, org-preferred
//   · /api/leaderboard — org clusters excluded even with live-quality points
//   · share mint + public read — PLATFORM frontier even when an org frontier
//     exists on the same cluster; public DTO carries no `evidence`
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256, type FrontierPoint } from '@potion/core';
import {
  clusters,
  createMembership,
  createOrg,
  createSession,
  createUser,
  DEFAULT_ORG_ID,
} from '@potion/db';
import { saveFrontier } from '@potion/pareto';
import { buildServer } from '../src/server.js';

let app: FastifyInstance;

const ADMIN = { cookie: 'potion_session=ps_of_admin' };
const B_ADMIN = { cookie: 'potion_session=ps_of_b' };

const ORG_B = 'org_of_b';
const AGENT_CLUSTER = 'agent-aaaaaa-bbbbbb';

function point(over: Partial<FrontierPoint> = {}): FrontierPoint {
  return {
    clusterId: AGENT_CLUSTER,
    strategyHash: 'h-of-1',
    strategyConfig: { type: 'single', model: 'mock-mid' },
    quality: 0.95,
    costPer1K: 1,
    latencyP95: 500,
    providerMode: 'live', // deliberately live: the leaderboard must exclude
    // it by ORG, not merely by provenance
    evidence: { cacheKeys: ['ck-of-1'], runIds: ['run-of'], n: 3, qualityCi95: 0.02 },
    ...over,
  };
}

beforeAll(async () => {
  app = await buildServer();
  const db = app.potion.db.db;
  await createUser(db, { id: 'usr_of_admin', email: 'of@t.dev', name: 'a' });
  await createMembership(db, { orgId: DEFAULT_ORG_ID, userId: 'usr_of_admin', role: 'admin' });
  await createSession(db, {
    id: 'ses_of_admin',
    userId: 'usr_of_admin',
    tokenHash: sha256('ps_of_admin'),
    orgId: DEFAULT_ORG_ID,
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  await createOrg(db, { id: ORG_B, name: 'OF B' });
  await createUser(db, { id: 'usr_of_b', email: 'ofb@t.dev', name: 'b' });
  await createMembership(db, { orgId: ORG_B, userId: 'usr_of_b', role: 'admin' });
  await createSession(db, {
    id: 'ses_of_b',
    userId: 'usr_of_b',
    tokenHash: sha256('ps_of_b'),
    orgId: ORG_B,
    expiresAt: new Date(Date.now() + 3_600_000),
  });

  // org_demo owns an agent cluster with an ORG frontier carrying live-quality
  // points + evidence.
  await db.insert(clusters).values({
    id: AGENT_CLUSTER,
    name: 'agent: search (of)',
    description: 'test agent cluster',
    orgId: DEFAULT_ORG_ID,
  });
  await saveFrontier(db, AGENT_CLUSTER, [point()], 'recompute', 'test-prices', {
    orgId: DEFAULT_ORG_ID,
  });
}, 120_000);

afterAll(async () => {
  await app.close();
});

describe('G1.6 per-org frontier surfaces', () => {
  it('detail route: owner sees the org frontier with evidence; another org gets a uniform 404', async () => {
    const own = await app.inject({ method: 'GET', url: `/api/frontiers/${AGENT_CLUSTER}`, headers: ADMIN });
    expect(own.statusCode).toBe(200);
    const body = own.json() as { frontier: { points: Array<{ evidence?: unknown }> } };
    expect(body.frontier.points.length).toBe(1);
    // authed surface keeps evidence — that's the guarantee report
    expect(body.frontier.points[0]!.evidence).toBeDefined();
    expect(body.frontier.points[0]!.evidence).toMatchObject({ cacheKeys: ['ck-of-1'] });

    // cross-org: same 404 as a nonexistent cluster (no oracle)
    const cross = await app.inject({ method: 'GET', url: `/api/frontiers/${AGENT_CLUSTER}`, headers: B_ADMIN });
    expect(cross.statusCode).toBe(404);
    const missing = await app.inject({ method: 'GET', url: '/api/frontiers/agent-zzzzzz-yyyyyy', headers: B_ADMIN });
    expect(missing.statusCode).toBe(404);
    // same shape either way (the echoed id is the caller's own input — no
    // existence oracle)
    const shape = (r: typeof cross) => {
      const b = r.json() as { error: { code: string | null; type: string } };
      return { code: b.error.code, type: b.error.type };
    };
    expect(shape(cross)).toEqual(shape(missing));
  });

  it('platform detail (code-gen) still resolves for every org (fallback is load-bearing)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/frontiers/code-gen', headers: B_ADMIN });
    expect(res.statusCode).toBe(200);
  });

  it('leaderboard excludes org clusters even with live-quality points', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/leaderboard' });
    expect(res.statusCode).toBe(200);
    const { entries } = res.json() as { entries: Array<{ clusterId: string }> };
    expect(entries.some((e) => e.clusterId === AGENT_CLUSTER)).toBe(false);
  });

  it('G1.7 live-sweep route: viewer 403, cross-org/platform 404, owned 202 with auth-forced org', async () => {
    // viewer session for org_demo
    const db = app.potion.db.db;
    await createUser(db, { id: 'usr_of_v', email: 'ofv@t.dev', name: 'v' });
    await createMembership(db, { orgId: DEFAULT_ORG_ID, userId: 'usr_of_v', role: 'viewer' });
    await createSession(db, {
      id: 'ses_of_v',
      userId: 'usr_of_v',
      tokenHash: sha256('ps_of_v'),
      orgId: DEFAULT_ORG_ID,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const VIEWER = { cookie: 'potion_session=ps_of_v' };

    const forbidden = await app.inject({
      method: 'POST',
      url: '/api/frontiers/live-sweep',
      headers: { ...VIEWER, 'content-type': 'application/json' },
      payload: { clusterId: AGENT_CLUSTER },
    });
    expect(forbidden.statusCode).toBe(403);

    // other org's cluster and platform clusters both 404 (live sweeps are
    // for org-owned agent clusters only)
    const cross = await app.inject({
      method: 'POST',
      url: '/api/frontiers/live-sweep',
      headers: { ...B_ADMIN, 'content-type': 'application/json' },
      payload: { clusterId: AGENT_CLUSTER },
    });
    expect(cross.statusCode).toBe(404);
    const platform = await app.inject({
      method: 'POST',
      url: '/api/frontiers/live-sweep',
      headers: { ...ADMIN, 'content-type': 'application/json' },
      payload: { clusterId: 'code-gen' },
    });
    expect(platform.statusCode).toBe(404);

    // owner admin → 202 (the job itself will refuse without the live env
    // gate — the route's contract is enqueue-with-forced-org)
    const ok = await app.inject({
      method: 'POST',
      url: '/api/frontiers/live-sweep',
      headers: { ...ADMIN, 'content-type': 'application/json' },
      payload: { clusterId: AGENT_CLUSTER, capUsd: 2 },
    });
    expect(ok.statusCode).toBe(202);
    expect((ok.json() as { jobId: string }).jobId).toBeTruthy();
  });

  it('share mint on a cluster with BOTH frontiers serves the PLATFORM one; public DTO has no evidence', async () => {
    const db = app.potion.db.db;
    // give code-gen an ORG frontier too — share must still serve platform
    await saveFrontier(db, 'code-gen', [point({ clusterId: 'code-gen', quality: 0.111 })], 'recompute', 'test-prices', {
      orgId: DEFAULT_ORG_ID,
    });
    const mint = await app.inject({
      method: 'POST',
      url: '/api/share',
      headers: { ...ADMIN, 'content-type': 'application/json' },
      payload: { kind: 'frontier', clusterId: 'code-gen' },
    });
    expect(mint.statusCode).toBe(201);
    const { token } = mint.json() as { token: string };
    const pub = await app.inject({ method: 'GET', url: `/api/public/share/${token}/frontier` });
    expect(pub.statusCode).toBe(200);
    const raw = pub.body;
    // platform frontier, not the org one (quality 0.111 marker absent)
    expect(raw).not.toContain('0.111');
    // owner rule boundary: internal evidence ids never leave authed surfaces
    expect(raw).not.toContain('evidence');
    expect(raw).not.toContain('ck-of-1');
  });
});
