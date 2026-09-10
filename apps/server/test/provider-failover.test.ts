// A served point that THROWS is a routing fact (2026-09-10). Until now
// `nextPointExcluding` was wired for empty answers and the reasoning skip;
// a thrown provider error reached neither and every catch returned 503
// without asking whether another measured point could answer. A model dying
// upstream took its whole cluster down with it.
//
// These tests pin the rules as much as the behaviour: single points only,
// never over a pin, at most one extra execution, never onto the unmeasured
// fallback strategy, and — on a stream — never after a token has been sent.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256, strategyHash, type FrontierPoint } from '@potion/core';
import { createOrg, insertApiKey, insertPolicy } from '@potion/db';
import { saveFrontier } from '@potion/pareto';
import { buildServer } from '../src/server.js';

const ORG = 'org-failover';
const KEY = 'pk_failover';
const DEAD = { type: 'single', model: 'mock-cheap' } as const; // the one that throws
const ALIVE = { type: 'single', model: 'mock-mid' } as const;

let app: FastifyInstance;
const calls: string[] = [];
/** which models throw on this request */
let dying = new Set<string>();
/** emit this many tokens before throwing, on the streaming path */
let tokensBeforeThrow = 0;

const BOOM = 'upstream 503: model is dead';

function point(clusterId: string, cfg: FrontierPoint['strategyConfig'], quality: number, costPer1K: number): FrontierPoint {
  return { clusterId, strategyHash: strategyHash(cfg), strategyConfig: cfg, quality, costPer1K, latencyP95: 400, providerMode: 'mock' };
}

beforeAll(async () => {
  app = await buildServer({ seed: false });
  const db = app.potion.db.db;
  await createOrg(db, { id: ORG, name: 'Failover' });
  await insertPolicy(db, { id: 'pol-failover', orgId: ORG, name: 'floor', config: { type: 'min_cost', qualityFloor: 0.5 } });
  await insertApiKey(db, { id: 'key-failover', keyHash: sha256(KEY), name: 'serve', orgId: ORG, policyId: 'pol-failover' });
  // extraction: the dead model is cheapest so min_cost picks it first, with a
  // live point behind it. code-gen: the dead model ALONE — nothing to fail to.
  await saveFrontier(db, 'extraction', [point('extraction', DEAD, 0.9, 0.2), point('extraction', ALIVE, 0.88, 1.0)], 'manual', 'test-prices');
  await saveFrontier(db, 'code-gen', [point('code-gen', DEAD, 0.9, 0.2)], 'manual', 'test-prices');

  const real = app.potion.providersForOrg;
  app.potion.providersForOrg = async (orgId: string) => {
    const set = await real(orgId);
    const mock = {
      ...set.providers.mock,
      complete: async (req: Parameters<typeof set.providers.mock.complete>[0]) => {
        calls.push(req.model);
        if (dying.has(req.model)) throw new Error(BOOM);
        return set.providers.mock.complete(req);
      },
      // The mock has no completeStream of its own; supplying one is what lets
      // the "already emitted a token" case exist at all.
      completeStream: async (req: Parameters<typeof set.providers.mock.complete>[0], onToken: (t: string) => void) => {
        calls.push(req.model);
        if (dying.has(req.model)) {
          for (let i = 0; i < tokensBeforeThrow; i++) onToken('partial ');
          throw new Error(BOOM);
        }
        const r = await set.providers.mock.complete(req);
        onToken(r.text);
        return r;
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
  app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${KEY}`, 'x-potion-cluster': cluster },
    payload: { model: 'potion-auto', max_tokens: 300, messages: [{ role: 'user', content: 'Extract the capital of France as JSON.' }], ...extra },
  });

beforeEach(() => {
  calls.length = 0;
  dying = new Set();
  tokensBeforeThrow = 0;
});

describe('a served point that throws is served once more on the next measured point', () => {
  it('JSON path: the cheap point dies → the next point answers, and the receipt says so', async () => {
    dying.add('mock-cheap');
    const res = await post('extraction');
    expect(res.statusCode, 'a dead point with a live neighbour must not 503').toBe(200);
    expect(calls).toEqual(['mock-cheap', 'mock-mid']);
    expect(res.json().choices[0].message.content.length).toBeGreaterThan(0);
    expect(res.headers['x-potion-model']).toBe('mock-mid');
    expect(String(res.headers['x-frontier-trace'])).toContain('retry=provider_error');
  });

  it('JSON path: nothing to fail over to → the original error, not a silent default', async () => {
    dying.add('mock-cheap');
    const res = await post('code-gen');
    expect(res.statusCode).toBe(503);
    expect(calls, 'one point on the frontier means one call').toEqual(['mock-cheap']);
    expect(JSON.stringify(res.json())).toContain(BOOM);
  });

  it('AT MOST ONE extra execution: when the next point dies too, the FIRST error is reported', async () => {
    dying.add('mock-cheap');
    dying.add('mock-mid');
    const res = await post('extraction');
    expect(res.statusCode).toBe(503);
    expect(calls, 'two points tried, and no third attempt').toEqual(['mock-cheap', 'mock-mid']);
    expect(JSON.stringify(res.json()), 'the primary failure explains the request').toContain(BOOM);
  });

  it('a PINNED model is never swapped — the pin IS the request', async () => {
    dying.add('mock-cheap');
    const res = await post('extraction', { model: 'mock-cheap' });
    expect(res.statusCode, 'answering a pin with a different model would be answering a question nobody asked').toBe(503);
    expect(calls).toEqual(['mock-cheap']);
  });

  it('a healthy request is untouched: no retry token, one call', async () => {
    const res = await post('extraction');
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual(['mock-cheap']);
    expect(String(res.headers['x-frontier-trace'])).not.toContain('retry=');
  });
});

describe('the streaming path may only fail over before it has committed content', () => {
  it('throws BEFORE the first token → failed over, and the client sees one coherent answer', async () => {
    dying.add('mock-cheap');
    tokensBeforeThrow = 0;
    const res = await post('extraction', { stream: true });
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual(['mock-cheap', 'mock-mid']);
    const events = res.body.split('\n\n').filter((e) => e.startsWith('data: ')).map((e) => e.slice(6)).filter((e) => e !== '[DONE]').map((e) => JSON.parse(e));
    const text = events.map((e) => e.choices?.[0]?.delta?.content ?? '').join('');
    expect(text.length).toBeGreaterThan(0);
    expect(text, 'no fragment of the dead point may survive into the answer').not.toContain('partial');
  });

  it('throws AFTER a token → NOT failed over: splicing two answers would be incoherent', async () => {
    dying.add('mock-cheap');
    tokensBeforeThrow = 2;
    const res = await post('extraction', { stream: true });
    expect(calls, 'the dead point is called once and never replaced').toEqual(['mock-cheap']);
    expect(res.body, 'the stream reports the error it hit').toContain('service_unavailable');
  });
});
