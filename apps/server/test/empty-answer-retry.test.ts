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
import { clearReasoningMarks, isReasoningModel, markReasoning, seedReasoningMarks } from '../src/routing/reasoning.js';

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

describe('seedReasoningMarks', () => {
  it('marks the aliases named in POTION_REASONING_MODELS', () => {
    clearReasoningMarks();
    expect(seedReasoningMarks({ POTION_REASONING_MODELS: ' or-inkling-small, or-inkling ,' } as NodeJS.ProcessEnv)).toEqual(['or-inkling-small', 'or-inkling']);
    expect(isReasoningModel('or-inkling')).toBe(true);
    clearReasoningMarks();
  });
});

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
    expect(isReasoningModel('mock-cheap')).toBe(true); // the empty answer taught the server
    expect(isReasoningModel('mock-mid')).toBe(false); // the retry's real answer taught nothing wrong
  });
  // REWRITTEN 2026-09-06, and this comment is why. It used to assert that
  // with no other point the empty answer is simply reported honestly — the
  // best outcome available at the time. It no longer is: `mock-cheap` is a
  // KNOWN reasoning model by now (the case above taught the server), the
  // budget is 300, and the pre-call guard therefore knows before dialling
  // that this model cannot emit anything. There IS something else to serve —
  // the platform fallback — which that path previously refused to consider,
  // so the request was spent on a call whose outcome was already determined.
  // Honest-empty is still the contract when nothing at all can answer, which
  // the second case below pins.
  it('JSON path: no other point, but the fallback can answer → it serves, labelled', async () => {
    calls.length = 0; thinkerMode = 'empty';
    const res = await post('code-gen');
    expect(res.statusCode).toBe(200);
    expect(calls, 'the model known to be unable to answer is never dialled').toEqual(['mock-mid']);
    expect(res.json().choices[0].message.content.length).toBeGreaterThan(0);
    expect(String(res.headers['x-frontier-trace'])).toContain('fallback=1');
    expect(res.json().potion?.fallback_reason).toBe('reasoning_budget');
    expect(String(res.headers['x-frontier-trace'])).not.toContain('retry=');
  });

  it('JSON path: when NOTHING can answer the budget, the empty answer is still reported honestly', async () => {
    // Mark the fallback as a reasoning model too: now every route out is one,
    // there is no better answer to give, and the old contract stands — serve,
    // and report finish_reason length rather than inventing a refusal.
    markReasoning('mock-mid', 'reasoning_tokens');
    calls.length = 0; thinkerMode = 'empty';
    const res = await post('code-gen');
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual(['mock-cheap']);
    expect(res.json().choices[0].finish_reason).toBe('length');
    expect(String(res.headers['x-frontier-trace'])).not.toContain('retry=');
    clearReasoningMarks();
    markReasoning('mock-cheap', 'reasoning_tokens'); // restore what the suite taught
  });
  it('stream path: retries before any content is written', async () => {
    clearReasoningMarks(); // the JSON case above taught the server; test the retry itself
    calls.length = 0; thinkerMode = 'empty';
    const res = await post('extraction', { stream: true });
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual(['mock-cheap', 'mock-mid']);
    const events = res.body.split('\n\n').filter((e) => e.startsWith('data: ')).map((e) => e.slice(6)).filter((e) => e !== '[DONE]').map((e) => JSON.parse(e));
    expect(events.filter((e) => e.choices?.[0]?.delta?.content).length).toBeGreaterThan(0);
    expect(events.at(-1)?.choices?.[0]?.finish_reason ?? events.at(-2)?.choices?.[0]?.finish_reason).toBe('stop');
  });
  it('the empty answer taught the server: the thinker is now a known reasoning model and is skipped BEFORE the call under a small budget', async () => {
    expect(isReasoningModel('mock-cheap')).toBe(true);
    calls.length = 0; thinkerMode = 'empty';
    const res = await post('extraction');
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual(['mock-mid']); // no wasted call on the thinker
    expect(res.headers['x-potion-model']).toBe('mock-mid');
    expect(String(res.headers['x-frontier-trace'])).not.toContain('retry=');
  });
  it('above REASONING_MIN_BUDGET the thinker is asked as usual', async () => {
    calls.length = 0; thinkerMode = 'answer';
    const res = await post('extraction', { max_tokens: 2048 });
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual(['mock-cheap']);
  });
  it('a normal answer is untouched', async () => {
    clearReasoningMarks();
    calls.length = 0; thinkerMode = 'answer';
    const res = await post('extraction');
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual(['mock-cheap']);
    expect(res.headers['x-potion-model']).toBe('mock-cheap');
  });
});
