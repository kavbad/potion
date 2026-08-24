// R7 (2026-08-24): a pin freezes what an org is SERVED, and the changelog
// says what the pin is holding back. The load-bearing claim is the first
// test: publishing a new version must not move a pinned org.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256, type FrontierPoint } from '@potion/core';
import { createOrg, getServingFrontier, insertApiKey, listFrontierPins } from '@potion/db';
import { saveFrontier } from '@potion/pareto';
import { buildServer } from '../src/server.js';

const ORG = 'org-pins';
const OTHER = 'org-pins-other';
const ADMIN_KEY = 'pk_pins_admin';
const SERVE_KEY = 'pk_pins_serve';
const CLUSTER = 'code-gen';
let app: FastifyInstance;

function point(model: string, quality: number, cost: number): FrontierPoint {
  return {
    clusterId: CLUSTER,
    strategyHash: `hash-${model}`,
    strategyConfig: { type: 'single', model },
    quality,
    costPer1K: cost,
    latencyP95: 1000,
    providerMode: 'live',
  } as FrontierPoint;
}

beforeAll(async () => {
  app = await buildServer({ seed: false });
  const db = app.potion.db.db;
  for (const id of [ORG, OTHER]) await createOrg(db, { id, name: id });
  await insertApiKey(db, { id: 'key-pins-admin', keyHash: sha256(ADMIN_KEY), name: 'admin', orgId: ORG, scopes: 'serve+admin' });
  await insertApiKey(db, { id: 'key-pins-serve', keyHash: sha256(SERVE_KEY), name: 'serve', orgId: ORG, scopes: 'serve' });
  // v1: the version the org will pin.
  await saveFrontier(db, CLUSTER, [point('model-a', 0.90, 1.0)], 'import', 'v-test', { orgId: ORG });
});
afterAll(async () => {
  await app.close();
});

const admin = { authorization: `Bearer ${ADMIN_KEY}` };

describe('frontier pins (R7)', () => {
  it('a serve-scoped key may not pin', async () => {
    const res = await app.inject({ method: 'PUT', url: `/api/pins/${CLUSTER}`, headers: { authorization: `Bearer ${SERVE_KEY}` }, payload: {} });
    expect(res.statusCode).toBe(403);
  });

  it('pinning an unmeasured cluster 404s rather than pinning nothing', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/pins/rag-answer', headers: admin, payload: {} });
    expect(res.statusCode).toBe(404);
  });

  it('an admin pins the version they are served', async () => {
    const res = await app.inject({ method: 'PUT', url: `/api/pins/${CLUSTER}`, headers: admin, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().pinned).toMatchObject({ clusterId: CLUSTER, version: 1, instrument: 'default' });
  });

  it('THE POINT: a newly published version does not move a pinned org', async () => {
    const db = app.potion.db.db;
    await saveFrontier(db, CLUSTER, [point('model-b', 0.99, 0.5)], 'recompute', 'v-test', { orgId: ORG });
    const served = await getServingFrontier(db, CLUSTER, ORG);
    expect(served?.version).toBe(1); // still v1 — the pin held
    expect(served?.points[0]!.strategyConfig).toMatchObject({ model: 'model-a' });
    // an UNPINNED org on the same cluster gets the newest, as always
    const otherServed = await getServingFrontier(db, CLUSTER, OTHER);
    expect(otherServed?.version ?? null).not.toBe(1);
  });

  it('the pins surface reports the movement it is holding back', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/pins', headers: admin });
    expect(res.statusCode).toBe(200);
    const row = (res.json().pins as Array<Record<string, unknown>>).find((r) => r.clusterId === CLUSTER)!;
    expect(row).toMatchObject({ servedVersion: 1, latestVersion: 2, holdingBack: true });
  });

  it('the changelog says what changed, in words', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/frontier-changelog', headers: admin });
    expect(res.statusCode).toBe(200);
    const entry = (res.json().entries as Array<Record<string, unknown>>).find((e) => e.clusterId === CLUSTER)!;
    expect(entry).toMatchObject({ kind: 'held-back', fromVersion: 1, toVersion: 2 });
    expect(String(entry.narrative).length).toBeGreaterThan(0);
  });

  it('releasing lets the newest serve again, and is idempotent-safe', async () => {
    const db = app.potion.db.db;
    const res = await app.inject({ method: 'DELETE', url: `/api/pins/${CLUSTER}`, headers: admin });
    expect(res.statusCode).toBe(200);
    const served = await getServingFrontier(db, CLUSTER, ORG);
    expect(served?.version).toBe(2);
    expect(await listFrontierPins(db, ORG)).toHaveLength(0);
    const again = await app.inject({ method: 'DELETE', url: `/api/pins/${CLUSTER}`, headers: admin });
    expect(again.statusCode).toBe(404);
  });
});
