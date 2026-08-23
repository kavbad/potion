// Route-level proof that stream:true relays the PROVIDER's stream (2026-08-22).
// Three production deploys burst because a wrapper layer dropped
// completeStream; this test holds the whole path from the route down to the
// org provider set: when the provider streams, the route streams.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256, strategyHash, type FrontierPoint } from '@potion/core';
import { createOrg, insertApiKey, insertPolicy } from '@potion/db';
import { saveFrontier } from '@potion/pareto';
import { buildServer } from '../src/server.js';

const ORG = 'org-realstream';
const KEY = 'pk_realstream';
const CHEAP = { type: 'single', model: 'mock-cheap' } as const;
let app: FastifyInstance;
let streamCalls = 0;

beforeAll(async () => {
  app = await buildServer({ seed: false });
  const db = app.potion.db.db;
  await createOrg(db, { id: ORG, name: 'Real stream' });
  await insertPolicy(db, { id: 'pol-realstream', orgId: ORG, name: 'floor', config: { type: 'min_cost', qualityFloor: 0.5 } });
  await insertApiKey(db, { id: 'key-realstream', keyHash: sha256(KEY), name: 'serve', orgId: ORG, policyId: 'pol-realstream' });
  const point: FrontierPoint = { clusterId: 'code-gen', strategyHash: strategyHash(CHEAP), strategyConfig: CHEAP, quality: 0.8, costPer1K: 0.2, latencyP95: 400, providerMode: 'mock' };
  await saveFrontier(db, 'code-gen', [point], 'manual', 'test-prices');
  // The org provider set, with a mock transport that streams word by word.
  const real = app.potion.providersForOrg;
  app.potion.providersForOrg = async (orgId: string) => {
    const set = await real(orgId);
    const mock = {
      ...set.providers.mock,
      completeStream: async (req: Parameters<typeof set.providers.mock.complete>[0], onToken: (t: string) => void) => {
        streamCalls++;
        const res = await set.providers.mock.complete(req);
        for (const w of res.text.split(' ')) {
          onToken(`${w} `);
          await new Promise((r) => setTimeout(r, 2));
        }
        return res;
      },
    };
    const providers = { ...set.providers, mock };
    return { ...set, providers, resolve: (m: string) => { const r = set.resolve(m); return r.provider.id === 'mock' ? { ...r, provider: mock } : r; } };
  };
});
afterAll(async () => {
  await app.close();
});

describe('stream:true on a single strategy', () => {
  it('relays the provider stream: many content chunks, the provider stream called once', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${KEY}`, 'x-potion-cluster': 'code-gen' },
      payload: { model: 'potion-auto', stream: true, messages: [{ role: 'user', content: 'Write a function that reverses a list and explain it in a few sentences.' }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    const events = res.body.split('\n\n').filter((e) => e.startsWith('data: ')).map((e) => e.slice(6));
    expect(events.at(-1)).toBe('[DONE]');
    const contents = events.filter((e) => e !== '[DONE]').map((e) => JSON.parse(e).choices?.[0]?.delta?.content).filter((c) => typeof c === 'string');
    expect(contents.length).toBeGreaterThan(3);
    expect(streamCalls).toBe(1);
  });
  it('the JSON path is untouched', async () => {
    const before = streamCalls;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${KEY}`, 'x-potion-cluster': 'code-gen' },
      payload: { model: 'potion-auto', messages: [{ role: 'user', content: 'Write a function that reverses a list — json path.' }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().choices[0].message.content.length).toBeGreaterThan(0);
    expect(streamCalls).toBe(before);
  });
});
