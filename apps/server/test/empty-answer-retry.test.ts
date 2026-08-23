// Empty answer under the output budget (2026-08-23): a single point that
// spends max_tokens without answering is served once more on the next point
// the policy admits; finish_reason 'length' surfaces when nothing else can.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256, strategyHash, type FrontierPoint } from '@potion/core';
import { createOrg, insertApiKey, insertPolicy } from '@potion/db';
import { saveFrontier } from '@potion/pareto';
import { buildServer } from '../src/server.js';
import { isEmptyAnswer } from '../src/routes/chat.js';

const ORG = 'org-empty';
const KEY = 'pk_empty';
const THINKER = { type: 'single', model: 'mock-cheap' } as const; // plays the reasoning model
const OTHER = { type: 'single', model: 'mock-mid' } as const;
let app: FastifyInstance;
const calls: string[] = [];
let thinkerMode: 'empty' | 'answer' = 'empty';

function point(clusterId: string, cfg: FrontierPoint['strategyConfig'], quality: number, costPer1K: number): FrontierPoint {
  return { clusterId, strategyHash: strategyHash(cfg), strategyConfig: cfg, quality, costPer1K, latencyP95: 400, providerMode: 'mock' };
}

beforeAll(async () => {
  app = await buildServer({ seed: false });
  const db = app.potion.db.db;
  await createOrg(db, { id: ORG, name: 'Empty' });
  await insertPolicy(db, { id: 'pol-empty', orgId: ORG, name: 'floor', config: { type: 'min_cost', qualityFloor: 0.5 } });
  await insertApiKey(db, { id: 'key-empty', keyHash: sha256(KEY), name: 'serve', orgId: ORG, policyId: 'pol-empty' });
  // extraction: thinker (cheap, picked first) + another point; code-gen: thinker alone.
  await saveFrontier(db, 'extraction', [point('extraction', THINKER, 0.9, 0.2), point('extraction', OTHER, 0.88, 1.0)], 'manual', 'test-prices');
  await saveFrontier(db, 'code-gen', [point('code-gen', THINKER, 0.9, 0.2)], 'manual', 'test-prices');
  const real = app.potion.providersForOrg;
  app.potion.providersForOrg = async (orgId: string) => {
    const set = await real(orgId);
    const mock = {
      ...set.providers.mock,
      complete: async (req: Parameters<typeof set.providers.mock.complete>[0]) => {
        calls.push(req.model);
        if (req.model === 'mock-cheap' && thinkerMode === 'empty') {
          const max = req.params?.maxTokens ?? 300;
          return { text: '', usage: { inputTokens: 20, outputTokens: max, reasoningTokens: max }, latencyMs: 5, modelVersion: 'thinker', finishReason: 'length' as const };
        }
        return set.providers.mock.complete(req);
      },
    };
    const providers = { ...set.providers, mock };
    return { ...set, providers, resolve: (m: string) => { const r = set.resolve(m); return r.provider.id === 'mock' ? { ...r, provider: mock } : r; } };
  };
});
afterAll(async () => {
  await app.close();
});

const post = (cluster: string, extra: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${KEY}`, 'x-potion-cluster': cluster }, payload: { model: 'potion-auto', max_tokens: 300, messages: [{ role: 'user', content: 'Extract the capital and population of France as JSON.' }], ...extra } });

describe('isEmptyAnswer', () => {
  it('is true only for an empty, budget-exhausted answer', () => {
    expect(isEmptyAnswer({ text: '', usage: { outputTokens: 300 } }, 300)).toBe(true);
    expect(isEmptyAnswer({ text: '', finishReason: 'length', usage: { outputTokens: 10 } }, undefined)).toBe(true);
    expect(isEmptyAnswer({ text: '', usage: { outputTokens: 10 } }, 300)).toBe(false);
    expect(isEmptyAnswer({ text: 'hi', usage: { outputTokens: 300 } }, 300)).toBe(false);
    expect(isEmptyAnswer({ text: '', toolCalls: [{}], usage: { outputTokens: 300 } }, 300)).toBe(false);
  });
});

describe('serving', () => {
  it('JSON path: the thinker answers nothing → served once more on the next point; headers say so', async () => {
    calls.length = 0; thinkerMode = 'empty';
    const res = await post('extraction');
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual(['mock-cheap', 'mock-mid']);
    expect(res.json().choices[0].message.content.length).toBeGreaterThan(0);
    expect(res.json().choices[0].finish_reason).toBe('stop');
    expect(res.headers['x-potion-model']).toBe('mock-mid');
    expect(String(res.headers['x-frontier-trace'])).toContain('retry=empty_answer');
  });
  it('JSON path: no other point → the empty answer is reported with finish_reason length', async () => {
    calls.length = 0; thinkerMode = 'empty';
    const res = await post('code-gen');
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual(['mock-cheap']);
    expect(res.json().choices[0].finish_reason).toBe('length');
    expect(String(res.headers['x-frontier-trace'])).not.toContain('retry=');
  });
  it('stream path: retries before any content is written', async () => {
    calls.length = 0; thinkerMode = 'empty';
    const res = await post('extraction', { stream: true });
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual(['mock-cheap', 'mock-mid']);
    const events = res.body.split('\n\n').filter((e) => e.startsWith('data: ')).map((e) => e.slice(6)).filter((e) => e !== '[DONE]').map((e) => JSON.parse(e));
    expect(events.filter((e) => e.choices?.[0]?.delta?.content).length).toBeGreaterThan(0);
    expect(events.at(-1)?.choices?.[0]?.finish_reason ?? events.at(-2)?.choices?.[0]?.finish_reason).toBe('stop');
  });
  it('a normal answer is untouched', async () => {
    calls.length = 0; thinkerMode = 'answer';
    const res = await post('extraction');
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual(['mock-cheap']);
    expect(res.headers['x-potion-model']).toBe('mock-cheap');
  });
});
