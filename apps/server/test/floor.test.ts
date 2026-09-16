// PUT /api/floor (P1-7): the org-wide quality floor from /settings/controls.
// A change mints a NEW policy row (immutable history) and rebinds every
// active key; per-kind floors and a latency bound survive the change.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256, strategyHash, type FrontierPoint } from '@potion/core';
import { saveFrontier } from '@potion/pareto';
import { createOrg, getApiKeyById, getPolicyById, insertApiKey, insertPolicy } from '@potion/db';
import { buildServer } from '../src/server.js';

const ORG = 'org-floor';
const ADMIN_KEY = 'pk_floor_admin';
const SERVE_KEY = 'pk_floor_serve';
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer({ seed: false });
  const db = app.potion.db.db;
  await createOrg(db, { id: ORG, name: 'Floor Co' });
  await insertPolicy(db, {
    id: 'pol-floor-old',
    orgId: ORG,
    name: 'old bar',
    config: { type: 'min_cost', qualityFloor: 0.9, clusterFloors: { extraction: 0.97 } },
  });
  await insertApiKey(db, { id: 'key-floor-admin', keyHash: sha256(ADMIN_KEY), name: 'admin', orgId: ORG, scopes: 'serve+admin', policyId: 'pol-floor-old' });
  await insertApiKey(db, { id: 'key-floor-serve', keyHash: sha256(SERVE_KEY), name: 'serve', orgId: ORG, scopes: 'serve', policyId: 'pol-floor-old' });
  // A measured kind of work for the feasibility read: the best point SCORES
  // 0.97 but can only PROVE 0.91 (its lower bound). A floor of 0.95 is
  // infeasible here; 0.9 is not.
  const pt = (model: string, quality: number, costPer1K: number, evidence?: FrontierPoint['evidence']): FrontierPoint => {
    const strategyConfig = { type: 'single', model } as FrontierPoint['strategyConfig'];
    return { clusterId: 'classification', strategyHash: strategyHash(strategyConfig), strategyConfig, quality, costPer1K, latencyP95: 400, providerMode: 'mock', ...(evidence ? { evidence } : {}) } as FrontierPoint;
  };
  await saveFrontier(
    db,
    'classification',
    [pt('mock-cheap', 0.8, 0.2), pt('mock-mid', 0.97, 1.0, { n: 20, qualityCi: [0.91, 0.99] } as FrontierPoint['evidence'])],
    'manual',
    'test-prices',
  );
});
afterAll(async () => {
  await app.close();
});

describe('the org-wide floor', () => {
  it('a serve-scoped key may not set it', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/floor', headers: { authorization: `Bearer ${SERVE_KEY}` }, payload: { qualityFloor: 0.95 } });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a floor outside [0, 1]; accepts a low bar — the operator sets THEIR bar (2026-09-01: the 0.5 clamp was a caption lie, not an invariant)', async () => {
    const low = await app.inject({ method: 'PUT', url: '/api/floor', headers: { authorization: `Bearer ${ADMIN_KEY}` }, payload: { qualityFloor: 0.3 } });
    expect(low.statusCode).toBe(200);
    expect((low.json() as { qualityFloor: number }).qualityFloor).toBe(0.3);
    const out = await app.inject({ method: 'PUT', url: '/api/floor', headers: { authorization: `Bearer ${ADMIN_KEY}` }, payload: { qualityFloor: 1.2 } });
    expect(out.statusCode).toBe(400);
    const neg = await app.inject({ method: 'PUT', url: '/api/floor', headers: { authorization: `Bearer ${ADMIN_KEY}` }, payload: { qualityFloor: -0.1 } });
    expect(neg.statusCode).toBe(400);
  });

  it('an admin sets it: new policy, keys rebound, per-kind floors survive', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/floor', headers: { authorization: `Bearer ${ADMIN_KEY}` }, payload: { qualityFloor: 0.95 } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { policyId: string; qualityFloor: number; clusterFloors: Record<string, number>; keysRebound: number; previousType: string };
    expect(body.qualityFloor).toBe(0.95);
    expect(body.keysRebound).toBe(2);
    expect(body.previousType).toBe('min_cost');
    expect(body.clusterFloors).toEqual({ extraction: 0.97 });
    expect(body.policyId).not.toBe('pol-floor-old');
    const db = app.potion.db.db;
    for (const keyId of ['key-floor-admin', 'key-floor-serve']) {
      const key = await getApiKeyById(db, ORG, keyId);
      expect(key?.policyId).toBe(body.policyId);
    }
    const policy = await getPolicyById(db, ORG, body.policyId);
    expect(policy?.config).toMatchObject({ type: 'min_cost', qualityFloor: 0.95, clusterFloors: { extraction: 0.97 } });
  });

  it('a latency-bound policy becomes compound rather than losing its bound', async () => {
    const db = app.potion.db.db;
    await insertPolicy(db, { id: 'pol-floor-lat', orgId: ORG, name: 'latency', config: { type: 'latency_bound', p95Ms: 800 } });
    const admin = await getApiKeyById(db, ORG, 'key-floor-admin');
    expect(admin).not.toBeNull();
    // rebind by hand to simulate an org running a latency policy
    const { updateApiKeyPolicy } = await import('@potion/db');
    await updateApiKeyPolicy(db, ORG, 'key-floor-admin', 'pol-floor-lat');
    await updateApiKeyPolicy(db, ORG, 'key-floor-serve', 'pol-floor-lat');
    const res = await app.inject({ method: 'PUT', url: '/api/floor', headers: { authorization: `Bearer ${ADMIN_KEY}` }, payload: { qualityFloor: 0.9 } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { policyId: string; previousType: string };
    expect(body.previousType).toBe('latency_bound');
    const policy = await getPolicyById(db, ORG, body.policyId);
    expect(policy?.config).toMatchObject({ type: 'compound', qualityFloor: 0.9, p95Ms: 800 });
  });
});

// POST /api/policies rebindKeys (surface review 2026-08-24): the settings
// "Apply to my keys" — a new policy row governs every live key, riders
// survive, no key is minted, and the raw-key field never appears.
describe('policy apply with rebindKeys', () => {
  it('rebinds every live key, carries riders, and mints nothing', async () => {
    const db = app.potion.db.db;
    // Give the current policy a shadow rider so the carry is observable.
    await insertPolicy(db, {
      id: 'pol-floor-rider',
      orgId: ORG,
      name: 'with rider',
      config: { type: 'min_cost', qualityFloor: 0.9, shadow: { sampleRate: 0.1, candidates: 'frontier' } },
    });
    const rebindOld = await app.inject({
      method: 'POST',
      url: '/api/policies',
      headers: { authorization: `Bearer ${ADMIN_KEY}`, 'content-type': 'application/json' },
      payload: { policy: { type: 'max_quality', costCeilingPer1K: 2 }, rebindKeys: true },
    });
    expect(rebindOld.statusCode).toBe(201);
    const body = rebindOld.json();
    expect(body.keysRebound).toBeGreaterThanOrEqual(2);
    expect(body.apiKey).toBeUndefined();
    expect(body.boundKeyId).toBeNull();
    const admin = await getApiKeyById(db, ORG, 'key-floor-admin');
    const serve = await getApiKeyById(db, ORG, 'key-floor-serve');
    expect(admin!.policyId).toBe(body.policy.id);
    expect(serve!.policyId).toBe(body.policy.id);
    const stored = await getPolicyById(db, ORG, body.policy.id as string);
    expect(stored!.config.type).toBe('max_quality');
  });

  // PER-KIND FLOORS SURVIVE "Apply to my keys" (2026-09-16, customer-eyes
  // review): the picker sends only the policy shape, and the rebind used to
  // drop every measured per-kind bar — a code-review floor of 0.97 vanished
  // without a word. The Quality floor card beside it always carried them.
  it('rebinding from the picker carries the current per-kind floors; an explicit clusterFloors in the body wins', async () => {
    const db = app.potion.db.db;
    const { updateApiKeyPolicy } = await import('@potion/db');
    await insertPolicy(db, {
      id: 'pol-floor-kinds',
      orgId: ORG,
      name: 'with kinds',
      config: { type: 'min_cost', qualityFloor: 0.9, clusterFloors: { 'code-review': 0.97 }, shadow: { sampleRate: 0.1, candidates: 'frontier' } },
    });
    await updateApiKeyPolicy(db, ORG, 'key-floor-admin', 'pol-floor-kinds');
    await updateApiKeyPolicy(db, ORG, 'key-floor-serve', 'pol-floor-kinds');
    const res = await app.inject({
      method: 'POST',
      url: '/api/policies',
      headers: { authorization: `Bearer ${ADMIN_KEY}`, 'content-type': 'application/json' },
      payload: { policy: { type: 'min_cost', qualityFloor: 0.8 }, rebindKeys: true },
    });
    expect(res.statusCode, res.body).toBe(201);
    const stored = await getPolicyById(db, ORG, (res.json() as { policy: { id: string } }).policy.id);
    expect(stored!.config).toMatchObject({ type: 'min_cost', qualityFloor: 0.8, clusterFloors: { 'code-review': 0.97 }, shadow: { sampleRate: 0.1 } });
    // explicit wins
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/policies',
      headers: { authorization: `Bearer ${ADMIN_KEY}`, 'content-type': 'application/json' },
      payload: { policy: { type: 'min_cost', qualityFloor: 0.8, clusterFloors: { 'code-review': 0.9 } }, rebindKeys: true },
    });
    expect(res2.statusCode, res2.body).toBe(201);
    const stored2 = await getPolicyById(db, ORG, (res2.json() as { policy: { id: string } }).policy.id);
    expect((stored2!.config as { clusterFloors?: Record<string, number> }).clusterFloors).toEqual({ 'code-review': 0.9 });
  });

  it('a serve-scoped key may not rebind', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/policies',
      headers: { authorization: `Bearer ${SERVE_KEY}`, 'content-type': 'application/json' },
      payload: { policy: { type: 'min_cost', qualityFloor: 0.8 }, rebindKeys: true },
    });
    expect(res.statusCode).toBe(403);
  });
});

// FEASIBILITY BEFORE COMMITMENT (2026-09-16). Found live: a floor of
// 0.978543771043771 on a kind of work whose highest provable quality is
// 0.969 sat on a key for weeks and the card accepted it without a word.
describe('floor feasibility — the card asks before the customer commits', () => {
  it('GET /api/floor/feasibility names every kind of work where no measured point PROVES the floor', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/floor/feasibility?floor=0.95', headers: { authorization: `Bearer ${SERVE_KEY}` } });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { floor: number; infeasible: Array<{ clusterId: string; floor: number; highestProvable: number; bestModel: string }> };
    expect(body.floor).toBe(0.95);
    const c = body.infeasible.find((r) => r.clusterId === 'classification');
    expect(c, JSON.stringify(body)).toBeDefined();
    expect(c!.floor).toBe(0.95);
    expect(c!.highestProvable).toBe(0.91);
    expect(c!.bestModel).toBe('mock-mid');
    // extraction carries a per-kind floor of 0.97 but has no frontier → nothing to warn from
    expect(body.infeasible.some((r) => r.clusterId === 'extraction')).toBe(false);
  });

  it('a floor the evidence can prove is feasible', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/floor/feasibility?floor=0.9', headers: { authorization: `Bearer ${SERVE_KEY}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { infeasible: Array<{ clusterId: string }>; clusters: Array<{ clusterId: string; feasible: boolean }> };
    expect(body.infeasible.some((r) => r.clusterId === 'classification')).toBe(false);
    expect(body.clusters.find((r) => r.clusterId === 'classification')?.feasible).toBe(true);
  });

  it('rejects a floor outside [0, 1]', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/floor/feasibility?floor=1.5', headers: { authorization: `Bearer ${SERVE_KEY}` } });
    expect(res.statusCode).toBe(400);
  });

  it('PUT /api/floor names the infeasible kinds of work on the save itself — an API caller never saw the card', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/floor', headers: { authorization: `Bearer ${ADMIN_KEY}` }, payload: { qualityFloor: 0.95 } });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { qualityFloor: number; infeasible: Array<{ clusterId: string; highestProvable: number }> };
    expect(body.qualityFloor).toBe(0.95);
    expect(body.infeasible.map((r) => r.clusterId)).toContain('classification');
  });
});
