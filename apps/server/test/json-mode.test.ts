import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256, strategyHash, type FrontierPoint } from '@potion/core';
import { createOrg, insertApiKey, insertPolicy } from '@potion/db';
import { saveFrontier } from '@potion/pareto';
import { buildServer } from '../src/server.js';
import { unwrapJsonFences } from '../src/routing/json-mode.js';

describe('unwrapJsonFences', () => {
  it('removes a fence only when the inside parses', () => {
    expect(unwrapJsonFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(unwrapJsonFences('```\n[1,2]\n```')).toBe('[1,2]');
    expect(unwrapJsonFences('```json\nnot json\n```')).toBe('```json\nnot json\n```');
    expect(unwrapJsonFences('{"a":1}')).toBe('{"a":1}');
    expect(unwrapJsonFences('Here you go:\n```json\n{"a":1}\n```\nNote: approximate.')).toBe('{"a":1}');
    expect(unwrapJsonFences('no json here')).toBe('no json here');
  });
});

const ORG = 'org-jsonmode';
const KEY = 'pk_jsonmode';
const CFG = { type: 'single', model: 'mock-cheap' } as const;
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer({ seed: false });
  const db = app.potion.db.db;
  await createOrg(db, { id: ORG, name: 'JSON mode' });
  await insertPolicy(db, { id: 'pol-jsonmode', orgId: ORG, name: 'floor', config: { type: 'min_cost', qualityFloor: 0.5 } });
  await insertApiKey(db, { id: 'key-jsonmode', keyHash: sha256(KEY), name: 'serve', orgId: ORG, policyId: 'pol-jsonmode' });
  const point: FrontierPoint = { clusterId: 'extraction', strategyHash: strategyHash(CFG), strategyConfig: CFG, quality: 0.8, costPer1K: 0.2, latencyP95: 400, providerMode: 'mock' };
  await saveFrontier(db, 'extraction', [point], 'manual', 'test-prices');
  const real = app.potion.providersForOrg;
  app.potion.providersForOrg = async (orgId: string) => {
    const set = await real(orgId);
    const mock = { ...set.providers.mock, complete: async () => ({ text: '```json\n{"capital":"Paris"}\n```', usage: { inputTokens: 10, outputTokens: 12 }, latencyMs: 3, modelVersion: 'm' }) };
    const providers = { ...set.providers, mock };
    return { ...set, providers, resolve: (m: string) => { const r = set.resolve(m); return r.provider.id === 'mock' ? { ...r, provider: mock } : r; } };
  };
});
afterAll(async () => {
  await app.close();
});

const post = (extra: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${KEY}`, 'x-potion-cluster': 'extraction' }, payload: { model: 'potion-auto', messages: [{ role: 'user', content: 'Capital of France as JSON.' }], ...extra } });

describe('JSON mode at the edge', () => {
  it('a fenced object is unwrapped when json_object was asked for', async () => {
    const res = await post({ response_format: { type: 'json_object' } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.json().choices[0].message.content)).toEqual({ capital: 'Paris' });
  });
  it('without response_format the text is returned as the model wrote it', async () => {
    const res = await post({});
    expect(res.json().choices[0].message.content).toBe('```json\n{"capital":"Paris"}\n```');
  });
});
