// OpenAI wire parity (2026-08-23): agentic loops (assistant tool_calls, role
// 'tool' results), content-part arrays, honest image refusal, and caller
// sampling/format parameters reaching the provider.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { sha256, strategyHash, type FrontierPoint } from '@potion/core';
import { createOrg, insertApiKey, insertPolicy } from '@potion/db';
import { saveFrontier } from '@potion/pareto';
import { buildServer } from '../src/server.js';

const ORG = 'org-wire';
const KEY = 'pk_wire';
const CHEAP = { type: 'single', model: 'mock-cheap' } as const;
let app: FastifyInstance;
const seen: unknown[] = [];

beforeAll(async () => {
  app = await buildServer({ seed: false });
  const db = app.potion.db.db;
  await createOrg(db, { id: ORG, name: 'Wire' });
  await insertPolicy(db, { id: 'pol-wire', orgId: ORG, name: 'floor', config: { type: 'min_cost', qualityFloor: 0.5 } });
  await insertApiKey(db, { id: 'key-wire', keyHash: sha256(KEY), name: 'serve', orgId: ORG, policyId: 'pol-wire' });
  const point: FrontierPoint = { clusterId: 'code-gen', strategyHash: strategyHash(CHEAP), strategyConfig: CHEAP, quality: 0.8, costPer1K: 0.2, latencyP95: 400, providerMode: 'mock' };
  await saveFrontier(db, 'code-gen', [point], 'manual', 'test-prices');
  const real = app.potion.providersForOrg;
  app.potion.providersForOrg = async (orgId: string) => {
    const set = await real(orgId);
    const mock = { ...set.providers.mock, complete: async (req: Parameters<typeof set.providers.mock.complete>[0]) => { seen.push(req); return set.providers.mock.complete(req); } };
    const providers = { ...set.providers, mock };
    return { ...set, providers, resolve: (m: string) => { const r = set.resolve(m); return r.provider.id === 'mock' ? { ...r, provider: mock } : r; } };
  };
});
afterAll(async () => {
  await app.close();
});

const post = (payload: NonNullable<InjectOptions['payload']>) =>
  app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${KEY}`, 'x-potion-cluster': 'code-gen' }, payload });

describe('agentic turns', () => {
  it('the second turn of a tool loop — assistant tool_calls then a tool result — is accepted and forwarded verbatim', async () => {
    seen.length = 0;
    const res = await post({
      model: 'potion-auto',
      messages: [
        { role: 'user', content: 'Weather in Paris? Use the tool, then write a short poem about it.' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: '{"temp_c":21,"sky":"clear"}' },
      ],
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
    });
    expect(res.statusCode).toBe(200);
    const req = seen[0] as { messages: { role: string; tool_calls?: unknown; tool_call_id?: string }[] };
    expect(req.messages[1]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'call_1' }] });
    expect(req.messages[2]).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
  });
});

describe('content parts', () => {
  it('a text-part array is flattened to text', async () => {
    seen.length = 0;
    const res = await post({ model: 'potion-auto', messages: [{ role: 'user', content: [{ type: 'text', text: 'Write a function that' }, { type: 'text', text: 'reverses a list.' }] }] });
    expect(res.statusCode).toBe(200);
    expect((seen[0] as { messages: { content: string }[] }).messages[0]!.content).toBe('Write a function that\nreverses a list.');
  });
  it('an image part is refused with a precise code, not silently dropped', async () => {
    const res = await post({ model: 'potion-auto', messages: [{ role: 'user', content: [{ type: 'text', text: 'What is in this picture?' }, { type: 'image_url', image_url: { url: 'https://example.com/x.png' } }] }] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('unsupported_content');
    expect(res.json().error.message).toMatch(/1 image part/);
  });
});

describe('caller parameters', () => {
  it('temperature, top_p, stop, seed, user, response_format, parallel_tool_calls reach the provider', async () => {
    seen.length = 0;
    const res = await post({ model: 'potion-auto', messages: [{ role: 'user', content: 'Return JSON describing a list reversal function.' }], temperature: 0.2, top_p: 0.9, stop: ['END'], seed: 7, user: 'u-1', response_format: { type: 'json_object' }, parallel_tool_calls: false });
    expect(res.statusCode).toBe(200);
    const req = seen[0] as { params?: { sampling?: Record<string, unknown> } };
    expect(req.params?.sampling).toEqual({ temperature: 0.2, top_p: 0.9, stop: ['END'], seed: 7, user: 'u-1', response_format: { type: 'json_object' }, parallel_tool_calls: false });
  });
  it('n must be 1', async () => {
    const res = await post({ model: 'potion-auto', messages: [{ role: 'user', content: 'hi there' }], n: 2 });
    expect(res.statusCode).toBe(400);
  });
});
