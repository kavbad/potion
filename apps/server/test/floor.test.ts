// PUT /api/floor (P1-7): the org-wide quality floor from /settings/controls.
// A change mints a NEW policy row (immutable history) and rebinds every
// active key; per-kind floors and a latency bound survive the change.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256 } from '@potion/core';
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
      config: { type: 'min_cost', qualityFloor: 0.9, shadow: { compare: ['max_quality'] } },
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
