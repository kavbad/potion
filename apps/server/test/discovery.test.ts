// G2 rung 1 — discovered-workloads routes: org-scoped reads, admin-gated
// refresh, observed-only DTO (centroids never leave the server).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256 } from '@potion/core';
import { createOrg, insertApiKey, insertPolicy, replaceOrgWorkloads } from '@potion/db';
import { buildServer } from '../src/server.js';

const ORG = 'org-discovery';
const KEY = 'pk_discovery';
const KEY_SERVE = 'pk_discovery_serve';

let app: FastifyInstance;
const db = () => app.potion.db.db;

beforeAll(async () => {
  app = await buildServer({ seed: false });
  await createOrg(db(), { id: ORG, name: 'Discovery' });
  await insertPolicy(db(), { id: 'pol-disc', orgId: ORG, name: 'd', config: { type: 'min_cost', qualityFloor: 0.7 } });
  await insertApiKey(db(), { id: 'key-disc', keyHash: sha256(KEY), name: 'admin', orgId: ORG, policyId: 'pol-disc', scopes: 'serve+admin' });
  await insertApiKey(db(), { id: 'key-disc-s', keyHash: sha256(KEY_SERVE), name: 'serve', orgId: ORG, policyId: 'pol-disc' });
});
afterAll(async () => {
  await app.close();
});

describe('discovered workloads', () => {
  it('empty until discovery runs — an absent structure is absent, not zeros', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/workloads/discovered', headers: { authorization: `Bearer ${KEY}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ workloads: [] });
  });

  it('lists observed rows without centroids', async () => {
    await replaceOrgWorkloads(db(), ORG, [
      {
        id: 'wl-abc123-classification-1', orgId: ORG, parentCluster: 'classification',
        sampleCount: 8, cohesion: 0.91, exemplarText: 'Is this ticket urgent or routine?',
        centroid: [0.1, 0.2], status: 'observed', windowDays: 30,
      },
    ]);
    const res = await app.inject({ method: 'GET', url: '/api/workloads/discovered', headers: { authorization: `Bearer ${KEY}` } });
    const body = res.json() as { workloads: Array<Record<string, unknown>> };
    expect(body.workloads).toHaveLength(1);
    expect(body.workloads[0]).toMatchObject({
      id: 'wl-abc123-classification-1', parentCluster: 'classification',
      sampleCount: 8, cohesion: 0.91, status: 'observed', windowDays: 30,
    });
    expect(body.workloads[0]).not.toHaveProperty('centroid');
  });

  it('refresh is admin-gated and enqueues', async () => {
    const forbidden = await app.inject({ method: 'POST', url: '/api/workloads/discover', headers: { authorization: `Bearer ${KEY_SERVE}` } });
    expect(forbidden.statusCode).toBeGreaterThanOrEqual(403);
    const res = await app.inject({ method: 'POST', url: '/api/workloads/discover', headers: { authorization: `Bearer ${KEY}` } });
    expect(res.statusCode).toBe(202);
    const jobId = (res.json() as { jobId: string }).jobId;
    expect(jobId).toBeTruthy();
    // Drain the job before teardown (it also proves the worker path runs
    // end-to-end on the server's own context: embedder wired, no throw).
    const q = app.potion.queue;
    let state: string | undefined;
    const deadline = Date.now() + 9000;
    while (q !== undefined && Date.now() < deadline) {
      const j = await q.getJob(jobId);
      state = j?.state;
      if (state === 'completed' || state === 'failed') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(state).toBe('completed');
  });
});
