// A REASONING MODEL UNDER A BUDGET IT CANNOT ANSWER IN (2026-09-06).
//
// tooSmallForReasoning already knew: below REASONING_MIN_BUDGET a marked
// model spends the whole allowance on hidden reasoning and returns nothing
// visible. The serving path asked for an alternative and, when the frontier
// offered none the policy admitted, did NOTHING — and served the model it had
// just established could not answer. The customer got a 200 with "".
//
// Measured in a head-to-head against openrouter/auto and a fixed incumbent:
// all 11 Potion failures were this, every one on multi-step-reasoning at
// max_tokens=64, against baselines that answered 100% of the same items.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256, strategyHash, type FrontierPoint } from '@potion/core';
import { createOrg, insertApiKey, insertPolicy } from '@potion/db';
import { saveFrontier } from '@potion/pareto';
import { buildServer } from '../src/server.js';
import { clearReasoningMarks, markReasoning } from '../src/routing/reasoning.js';

const ORG = 'org-reasoning-budget';
const KEY = 'pk_reasoning_budget';
let app: FastifyInstance;

// Every point on this frontier is a reasoning model — the production shape
// that made the skip a no-op. mock-mid/mock-cheap are the embedded provider's
// models, marked here so the guard sees them as reasoning.
const pt = (model: string, quality: number, cost: number): FrontierPoint => {
  const cfg = { type: 'single', model } as const;
  return { clusterId: 'code-gen', strategyHash: strategyHash(cfg), strategyConfig: cfg, quality, costPer1K: cost, latencyP95: 400, providerMode: 'mock' };
};

beforeAll(async () => {
  app = await buildServer({ seed: false });
  const db = app.potion.db.db;
  await createOrg(db, { id: ORG, name: 'Reasoning' });
  await insertPolicy(db, { id: 'pol-rb', orgId: ORG, name: 'floor', config: { type: 'min_cost', qualityFloor: 0.5 } });
  await insertApiKey(db, { id: 'key-rb', keyHash: sha256(KEY), name: 'serve', orgId: ORG, policyId: 'pol-rb' });
  // The frontier is entirely reasoning models. The platform fallback in mock
  // mode is `mock-mid` (DEFAULT_STRATEGY), left UNMARKED on purpose: this
  // pins the case the fix handles — nothing the policy admits can answer, but
  // something else can. (When even the fallback is a reasoning model there is
  // nothing that can answer at all; that case still serves, and is called out
  // in chat.ts rather than silently handled here.)
  await saveFrontier(db, 'code-gen', [pt('mock-cheap', 0.9, 0.5), pt('mock-frontier', 0.8, 0.1)], 'manual', 'test-prices');
  clearReasoningMarks();
  markReasoning('mock-cheap', 'reasoning_tokens');
  markReasoning('mock-frontier', 'reasoning_tokens');
}, 90_000);

afterAll(async () => {
  clearReasoningMarks();
  await app.close();
});

const ask = (maxTokens: number) =>
  app.inject({
    method: 'POST', url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    payload: { model: 'potion-auto', max_tokens: maxTokens, messages: [{ role: 'user', content: 'Write a function that reverses a string.' }] },
  });

describe('every admissible point is a reasoning model under a tiny budget', () => {
  it('does not serve a model it has already determined cannot answer', async () => {
    const res = await ask(64);
    expect(res.statusCode).toBe(200);
    const served = String(res.headers['x-potion-model']);
    expect(
      ['mock-cheap', 'mock-frontier'].includes(served),
      `served ${served}: the skip found no alternative and served the reasoning model anyway`,
    ).toBe(false);
    expect(served).toBe('mock-mid');
  });

  it('says so on the receipt rather than implying a measured pick', async () => {
    const res = await ask(64);
    expect(String(res.headers['x-frontier-trace'])).toContain('fallback=1');
    expect(res.json().potion?.fallback_reason).toBe('reasoning_budget');
  });

  it('leaves a generous budget alone — the guard is about the budget, not the model', async () => {
    const res = await ask(4096);
    expect(res.statusCode).toBe(200);
    expect(['mock-cheap', 'mock-frontier']).toContain(String(res.headers['x-potion-model']));
    expect(String(res.headers['x-frontier-trace'])).toContain('fallback=0');
  });
});

// 2026-09-07: the heuristic was costing real money. REASONING_MIN_BUDGET
// (1024) is a proxy for "will this model answer inside the budget?", and
// evidence.tokens now answers that directly. or-solar-pro4 is the cheapest
// feasible point on extraction ($0.0208/1K), is reasoning-marked, and
// averages 91 output tokens — under max_tokens=400 the proxy skipped it and
// the request went to a point 9x dearer, which was most of a persistent 1.6x
// cost gap against a free auto-router.
describe('measured output outranks the reasoning roster', () => {
  const ORG2 = 'org-measured-budget';
  const KEY2 = 'pk_measured_budget';
  const cfg = { type: 'single', model: 'mock-cheap' } as const;

  beforeAll(async () => {
    const db = app.potion.db.db;
    const { createOrg: co, insertApiKey: ik, insertPolicy: ip } = await import('@potion/db');
    await co(db, { id: ORG2, name: 'Measured' });
    await ip(db, { id: 'pol-mb', orgId: ORG2, name: 'floor', config: { type: 'min_cost', qualityFloor: 0.5 } });
    await ik(db, { id: 'key-mb', keyHash: sha256(KEY2), name: 'serve', orgId: ORG2, policyId: 'pol-mb' });
    // mock-cheap is reasoning-marked (above) AND carries a profile showing it
    // answers in 20 tokens. A 400-token budget fits that four times over.
    await saveFrontier(db, 'summarization', [{
      clusterId: 'summarization', strategyHash: strategyHash(cfg), strategyConfig: cfg,
      quality: 0.9, costPer1K: 0.01, latencyP95: 400, providerMode: 'mock',
      evidence: { cacheKeys: [], runIds: ['r'], n: 40, qualityCi95: 0.02, qualityCi: [0.88, 0.92], tokens: { inputMean: 120, outputMean: 20 } },
    }], 'manual', 'test-prices');
    markReasoning('mock-cheap', 'reasoning_tokens');
  }, 60_000);

  it('serves a reasoning-marked point whose MEASURED output fits the budget', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${KEY2}`, 'content-type': 'application/json', 'x-potion-cluster': 'summarization' },
      payload: { model: 'potion-auto', max_tokens: 400, messages: [{ role: 'user', content: 'Summarise this.' }] },
    });
    expect(res.statusCode).toBe(200);
    expect(
      res.headers['x-potion-model'],
      'a 20-token measured mean fits a 400-token budget; the roster should not veto measured evidence',
    ).toBe('mock-cheap');
    expect(String(res.headers['x-frontier-trace'])).toContain('fallback=0');
  });
});
