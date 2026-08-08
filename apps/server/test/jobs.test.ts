// Jobs routes tests (M3 #28, SPEC §12.2):
//   · POST /api/evals → 202 { jobId } (inline strategies registered by hash)
//   · GET /api/jobs/:id → state transitions queued/active → completed with a
//     RunSummary-shaped result (memory driver, REAL default handler, mock
//     providers, authored suite — 50 items post-G0.5 scaling)
//   · org scoping: cross-org reads 404; unknown ids 404
//   · validation: no strategies → 400; unknown strategy hash → job fails
//     with a typed error surfaced via GET
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256 } from '@potion/core';
import { evalResults, insertApiKey } from '@potion/db';
import { buildServer } from '../src/server.js';
// G2.4 carryover: cross-tenant suites use TWO DISTINCT NON-DEFAULT orgs from the
// shared fixture — the demo org must never be the probed subject (see the
// fixture header; that assumption is what hid tenancy defect D1).
import { ORG_A, ORG_B, seedIsolationOrgs } from './fixtures/orgs.js';

const RAW_A = 'pk_jobs_org_a';
const RAW_B = 'pk_jobs_org_b';

let app: FastifyInstance;
const db = () => app.potion.db.db;

function post(url: string, rawKey: string, body: unknown) {
  return app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${rawKey}`, 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
}
function get(url: string, rawKey: string) {
  return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${rawKey}` } });
}

interface JobView {
  id: string;
  state: string;
  progress: number;
  result?: { runId?: string; executed?: number; artifactKey?: string | null };
  error?: string;
}

async function pollJob(jobId: string, rawKey: string, timeoutMs = 30_000): Promise<JobView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await get(`/api/jobs/${jobId}`, rawKey);
    expect(res.statusCode).toBe(200);
    const view = res.json() as JobView;
    if (view.state === 'completed' || view.state === 'failed') return view;
    if (Date.now() > deadline) throw new Error(`job ${jobId} stuck in state ${view.state}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  app = await buildServer({ seed: false });
  await seedIsolationOrgs(db());
  await insertApiKey(db(), { id: 'key-jobs-a', keyHash: sha256(RAW_A), name: 'a', orgId: ORG_A });
  await insertApiKey(db(), { id: 'key-jobs-b', keyHash: sha256(RAW_B), name: 'b', orgId: ORG_B });
});

afterAll(async () => {
  await app.close();
});

describe('M3 #28 jobs endpoints', () => {
  it('POST /api/evals → 202 { jobId }; GET transitions to completed', async () => {
    const res = await post('/api/evals', RAW_A, {
      suiteIds: ['classification'],
      strategies: [{ type: 'single', model: 'mock-mid' }],
      capUsd: 1,
    });
    expect(res.statusCode).toBe(202);
    const { jobId } = res.json() as { jobId: string };
    expect(typeof jobId).toBe('string');

    const view = await pollJob(jobId, RAW_A);
    expect(view.state).toBe('completed');
    expect(view.progress).toBe(100);
    expect(view.result?.runId).toBeTruthy();
    expect(view.result?.executed).toBe(50); // 50 authored items × 1 strategy (G0.5 scaling)
    expect(view.result?.artifactKey).toBeNull(); // no store configured (M2 default)

    // results persisted by the real handler
    const rows = await db().select().from(evalResults);
    expect(rows.filter((r) => r.runId === view.result?.runId).length).toBe(50);
  });

  it('GET /api/jobs/:id is org-scoped (404 cross-org) and 404s unknown ids', async () => {
    const res = await post('/api/evals', RAW_A, {
      suiteIds: ['classification'],
      strategies: [{ type: 'single', model: 'mock-mid' }],
    });
    expect(res.statusCode).toBe(202);
    const { jobId } = res.json() as { jobId: string };
    await pollJob(jobId, RAW_A);

    const crossOrg = await get(`/api/jobs/${jobId}`, RAW_B);
    expect(crossOrg.statusCode).toBe(404);
    const unknown = await get('/api/jobs/no-such-job', RAW_A);
    expect(unknown.statusCode).toBe(404);
  });

  it('POST /api/evals validates the body (400 without strategies)', async () => {
    const res = await post('/api/evals', RAW_A, { suiteIds: ['classification'] });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('invalid_body');
  });

  it('unknown strategy hash → job fails with a typed error via GET', async () => {
    const res = await post('/api/evals', RAW_A, {
      suiteIds: ['classification'],
      strategyHashes: ['deadbeef'],
    });
    expect(res.statusCode).toBe(202);
    const { jobId } = res.json() as { jobId: string };
    const view = await pollJob(jobId, RAW_A);
    expect(view.state).toBe('failed');
    expect(view.error).toMatch(/unknown strategy hash/);
  });
});
