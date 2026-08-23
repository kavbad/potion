// MIXING M3: a tool-carrying request is served from the cluster's frontier
// measured on tool use (instrument 'tools') when one exists.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256, strategyHash, type FrontierPoint } from '@potion/core';
import { createOrg, insertApiKey, insertPolicy } from '@potion/db';
import { saveFrontier } from '@potion/pareto';
import { buildServer } from '../src/server.js';

const ORG = 'org-toolsfrontier';
const KEY = 'pk_toolsfrontier';
const TEXT_PICK = { type: 'single', model: 'mock-cheap' } as const;
const TOOLS_PICK = { type: 'single', model: 'mock-mid' } as const;
let app: FastifyInstance;

function point(cfg: FrontierPoint['strategyConfig'], quality: number, costPer1K: number, toolsMeasured?: boolean): FrontierPoint {
  return { clusterId: 'agentic-tool-use', strategyHash: strategyHash(cfg), strategyConfig: cfg, quality, costPer1K, latencyP95: 400, providerMode: 'mock', ...(toolsMeasured ? { evidence: { cacheKeys: [], runIds: [], n: 24, qualityCi95: 0.03, toolsMeasured: true } } : {}) };
}

beforeAll(async () => {
  app = await buildServer({ seed: false });
  const db = app.potion.db.db;
  await createOrg(db, { id: ORG, name: 'Tools frontier' });
  await insertPolicy(db, { id: 'pol-toolsfrontier', orgId: ORG, name: 'floor', config: { type: 'min_cost', qualityFloor: 0.5 } });
  await insertApiKey(db, { id: 'key-toolsfrontier', keyHash: sha256(KEY), name: 'serve', orgId: ORG, policyId: 'pol-toolsfrontier' });
  await saveFrontier(db, 'agentic-tool-use', [point(TEXT_PICK, 0.9, 0.2)], 'manual', 'test-prices');
  await saveFrontier(db, 'agentic-tool-use', [point(TOOLS_PICK, 1.0, 0.3, true)], 'manual', 'test-prices', { instrument: 'tools' });
});
afterAll(async () => {
  await app.close();
});

const post = (extra: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${KEY}`, 'x-potion-cluster': 'agentic-tool-use' }, payload: { model: 'potion-auto', messages: [{ role: 'user', content: 'Weather in Paris? Use the tool.' }], ...extra } });

describe('the tools frontier', () => {
  it('a tool-carrying request is served from the tools frontier, and the trace says so', async () => {
    const res = await post({ tools: [{ type: 'function', function: { name: 'get_weather', parameters: {} } }] });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-potion-model']).toBe('mock-mid');
    expect(String(res.headers['x-frontier-trace'])).toContain('instrument=tools');
  });
  it('a plain request is served from the default frontier', async () => {
    const res = await post({});
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-potion-model']).toBe('mock-cheap');
    expect(String(res.headers['x-frontier-trace'])).not.toContain('instrument=');
  });
});

describe('classifier timing on the trace (item C)', () => {
  it('an unhinted request carries t_classify; a hinted one does not', async () => {
    const un = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${KEY}` }, payload: { model: 'potion-auto', messages: [{ role: 'user', content: `Weather tool probe timing ${Date.now()}` }] } });
    expect(String(un.headers['x-potion-timing'])).toMatch(/classify=\d+/);
    const hinted = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${KEY}`, 'x-potion-cluster': 'agentic-tool-use' }, payload: { model: 'potion-auto', messages: [{ role: 'user', content: 'hinted timing probe' }] } });
    expect(hinted.headers['x-potion-timing']).toBeUndefined();
  });
});
