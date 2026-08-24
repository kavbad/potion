// The Replit beta report's three integration pains, fixed (2026-08-24):
// policy discovery, an actionable policy_not_found, and typed routing.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256, strategyHash, type FrontierPoint } from '@potion/core';
import { createOrg, insertApiKey, insertPolicy } from '@potion/db';
import { saveFrontier } from '@potion/pareto';
import { buildServer } from '../src/server.js';

const ORG = 'org-beta';
const KEY = 'pk_beta';
const CFG = { type: 'single', model: 'mock-cheap' } as const;
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer({ seed: false });
  const db = app.potion.db.db;
  await createOrg(db, { id: ORG, name: 'Beta' });
  await insertPolicy(db, { id: 'pol-beta-strict', orgId: ORG, name: 'strict-floor', config: { type: 'min_cost', qualityFloor: 0.99 } });
  await insertPolicy(db, { id: 'pol-beta-loose', orgId: ORG, name: 'loose-floor', config: { type: 'min_cost', qualityFloor: 0.5 } });
  await insertApiKey(db, { id: 'key-beta', keyHash: sha256(KEY), name: 'serve', orgId: ORG, policyId: 'pol-beta-strict' });
  const point: FrontierPoint = { clusterId: 'code-gen', strategyHash: strategyHash(CFG), strategyConfig: CFG, quality: 0.9, costPer1K: 0.2, latencyP95: 400, providerMode: 'mock' };
  await saveFrontier(db, 'code-gen', [point], 'manual', 'test-prices');
});
afterAll(async () => {
  await app.close();
});

describe('policy discovery', () => {
  it('GET /v1/policies lists the org policies with names, marking the bound one', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/policies', headers: { authorization: `Bearer ${KEY}` } });
    expect(res.statusCode).toBe(200);
    const j = res.json();
    expect(j.policy).toMatchObject({ id: 'pol-beta-strict', bound: true });
    expect(j.policies.map((p: { id: string; name: string; bound: boolean }) => [p.id, p.name, p.bound]).sort()).toEqual([
      ['pol-beta-loose', 'loose-floor', false],
      ['pol-beta-strict', 'strict-floor', true],
    ]);
  });
});

describe('policy_not_found is actionable', () => {
  it('names the available policies and the safe default', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${KEY}`, 'x-potion-policy': 'min_cost' }, payload: { model: 'potion-auto', messages: [{ role: 'user', content: 'hi' }] } });
    expect(res.statusCode).toBe(400);
    const e = res.json().error;
    expect(e.code).toBe('policy_not_found');
    expect(e.hint).toContain('omit the x-potion-policy');
    expect(e.available_policies).toEqual(expect.arrayContaining([{ id: 'pol-beta-strict', name: 'strict-floor' }]));
  });
});

describe('typed routing on the response', () => {
  it('an unmeetable floor is explained: fallback true, reason policy_infeasible, key_default source', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${KEY}`, 'x-potion-cluster': 'code-gen' }, payload: { model: 'potion-auto', messages: [{ role: 'user', content: 'write a function' }] } });
    expect(res.statusCode).toBe(200);
    expect(res.json().potion).toMatchObject({
      requested_cluster: 'code-gen',
      resolved_cluster: 'code-gen',
      requested_policy: null,
      policy_source: 'key_default',
      resolved_policy_type: 'min_cost',
      model: 'mock-cheap',
      fallback: true,
      fallback_reason: 'policy_infeasible',
      provenance: 'mock',
    });
  });
  it('a named override is reported as the source', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${KEY}`, 'x-potion-cluster': 'code-gen', 'x-potion-policy': 'loose-floor' }, payload: { model: 'potion-auto', messages: [{ role: 'user', content: 'write a function' }] } });
    expect(res.statusCode).toBe(200);
    expect(res.json().potion).toMatchObject({ requested_policy: 'loose-floor', policy_source: 'override', fallback: false });
  });
});
