// M3 #25 OpenAI parity contract tests (SPEC §12.7) — recorded OpenAI fixture
// shapes, mock provider/embedder only, ZERO network. Boots a real server on
// PGlite (seed off) with a hand-made frontier (single + best-of-n points), so
// tool passthrough (single-only), streaming usage, legacy completions and the
// error parity table are all asserted against exact OpenAI response shapes.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256, strategyHash, type FrontierPoint, type Policy } from '@potion/core';
import { DEFAULT_ORG_ID, insertApiKey, insertPolicy } from '@potion/db';
import { saveFrontier } from '@potion/pareto';
import { createMockProvider, type Provider } from '@potion/providers';
import { buildServer } from '../src/server.js';

// ---- known frontier (code-gen): one single, one composite ----
const CFG_CHEAP = { type: 'single', model: 'mock-cheap' } as const;
const CFG_BON = {
  type: 'best-of-n',
  model: 'mock-mid',
  n: 2,
  judge: { model: 'mock-judge' },
} as const;

function point(
  strategyConfig: FrontierPoint['strategyConfig'],
  quality: number,
  costPer1K: number,
  latencyP95: number,
): FrontierPoint {
  return {
    clusterId: 'code-gen',
    strategyHash: strategyHash(strategyConfig),
    strategyConfig,
    quality,
    costPer1K,
    latencyP95,
  };
}

const POINTS: FrontierPoint[] = [
  point(CFG_CHEAP, 0.5, 0.1, 300),
  point(CFG_BON, 0.95, 25.0, 2000),
];

// latency_bound 500 → cheap SINGLE; max_quality ceiling 100 → best-of-n COMPOSITE.
const KEY_SINGLE = 'pk_parity_single';
const KEY_COMPOSITE = 'pk_parity_composite';
const KEY_LIMITED = 'pk_parity_limited'; // 1 rps — 429 parity

const CODE_PROMPT = 'Write a python function that reverses a string';

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get the current weather for a city',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
    },
  },
] as const;

let app: FastifyInstance;

function chat(rawKey: string, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${rawKey}`, 'content-type': 'application/json' },
    payload: { model: 'potion-auto', messages: [{ role: 'user', content: CODE_PROMPT }], ...payload },
  });
}

function sseFrames(body: string): string[] {
  return body.split('\n\n').filter((f) => f.trim() !== '');
}

function frameJson(frame: string): Record<string, any> {
  return JSON.parse(frame.replace(/^data: /, '')) as Record<string, any>;
}

/** Exact OpenAI error parity assertion: { error: { message, type, param, code } }
 * with EXACTLY those four keys. */
function expectErrorShape(
  body: unknown,
  expected: { type: string; code: string | null; param: string | null },
): void {
  const err = (body as { error: Record<string, unknown> }).error;
  expect(Object.keys(err).sort()).toEqual(['code', 'message', 'param', 'type']);
  expect(typeof err.message).toBe('string');
  expect((err.message as string).length).toBeGreaterThan(0);
  expect(err.type).toBe(expected.type);
  expect(err.code).toBe(expected.code);
  expect(err.param).toBe(expected.param);
}

beforeAll(async () => {
  app = await buildServer({ seed: false });
  const db = app.potion.db.db;
  const keys: Array<{ id: string; raw: string; config: Policy; rateRps?: number }> = [
    { id: 'pol-single', raw: KEY_SINGLE, config: { type: 'latency_bound', p95Ms: 500 } },
    { id: 'pol-composite', raw: KEY_COMPOSITE, config: { type: 'max_quality', costCeilingPer1K: 100 } },
    { id: 'pol-limited', raw: KEY_LIMITED, config: { type: 'latency_bound', p95Ms: 500 }, rateRps: 1 },
  ];
  for (const k of keys) {
    await insertPolicy(db, { id: k.id, orgId: DEFAULT_ORG_ID, name: k.id, config: k.config });
    await insertApiKey(db, {
      id: `key-${k.id}`,
      keyHash: sha256(k.raw),
      name: k.id,
      orgId: DEFAULT_ORG_ID,
      policyId: k.id,
      ...(k.rateRps !== undefined ? { rateRps: k.rateRps } : {}),
    });
  }
  await saveFrontier(db, 'code-gen', POINTS, 'manual', '2026-08-04');
}, 90_000);

afterAll(async () => {
  await app.close();
});

// ---------- GET /v1/models ----------

describe('GET /v1/models', () => {
  it('returns the OpenAI list shape with potion-auto + every prices.json alias', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${KEY_SINGLE}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.object).toBe('list');
    const created = Math.floor(Date.parse(app.potion.prices.updatedAt) / 1000);
    const ids = body.data.map((m: { id: string }) => m.id);
    expect(ids).toEqual(['potion-auto', ...app.potion.prices.entries.map((e) => e.alias)]);
    for (const m of body.data) {
      expect(Object.keys(m).sort()).toEqual(['created', 'id', 'object', 'owned_by']);
      expect(m.object).toBe('model');
      expect(m.created).toBe(created);
    }
    expect(body.data[0]).toEqual({ id: 'potion-auto', object: 'model', created, owned_by: 'potion' });
    // owned_by = the price entry's provider
    const byId = new Map(app.potion.prices.entries.map((e) => [e.alias, e.provider]));
    for (const m of body.data.slice(1)) {
      expect(m.owned_by).toBe(byId.get(m.id));
    }
  });

  it('requires an api key (401 invalid_api_key)', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/models' });
    expect(res.statusCode).toBe(401);
    expectErrorShape(res.json(), { type: 'invalid_request_error', code: 'invalid_api_key', param: null });
  });
});

// ---------- POST /v1/embeddings ----------

describe('POST /v1/embeddings', () => {
  const embedModel = (): string => app.potion.embedderInfo.model;

  it('single string input → OpenAI embedding-list shape, 384 dims, usage', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: { authorization: `Bearer ${KEY_SINGLE}`, 'content-type': 'application/json' },
      payload: { model: embedModel(), input: 'hello embeddings' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.object).toBe('list');
    expect(body.model).toBe(embedModel());
    expect(body.data).toHaveLength(1);
    expect(Object.keys(body.data[0]).sort()).toEqual(['embedding', 'index', 'object']);
    expect(body.data[0].object).toBe('embedding');
    expect(body.data[0].index).toBe(0);
    expect(body.data[0].embedding).toHaveLength(384);
    expect(body.usage.prompt_tokens).toBe(Math.ceil('hello embeddings'.length / 4));
    expect(body.usage.total_tokens).toBe(body.usage.prompt_tokens);
  });

  it('batched input → one data element per input, indices in order', async () => {
    const inputs = ['alpha text', 'beta text', 'gamma text'];
    const res = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: { authorization: `Bearer ${KEY_SINGLE}`, 'content-type': 'application/json' },
      payload: { model: embedModel(), input: inputs },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(3);
    body.data.forEach((d: { index: number; embedding: number[] }, i: number) => {
      expect(d.index).toBe(i);
      expect(d.embedding).toHaveLength(384);
    });
    const expectedTokens = inputs.reduce((s, t) => s + Math.ceil(t.length / 4), 0);
    expect(body.usage.prompt_tokens).toBe(expectedTokens);
    expect(body.usage.total_tokens).toBe(expectedTokens);
  });

  it('unknown model → OpenAI-shaped 400 (param model, code model_not_found)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: { authorization: `Bearer ${KEY_SINGLE}`, 'content-type': 'application/json' },
      payload: { model: 'text-embedding-3-large', input: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expectErrorShape(res.json(), { type: 'invalid_request_error', code: 'model_not_found', param: 'model' });
  });

  it('401 without a key; 400 on a malformed body', async () => {
    const noKey = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: { 'content-type': 'application/json' },
      payload: { model: embedModel(), input: 'x' },
    });
    expect(noKey.statusCode).toBe(401);
    expectErrorShape(noKey.json(), { type: 'invalid_request_error', code: 'invalid_api_key', param: null });

    const bad = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: { authorization: `Bearer ${KEY_SINGLE}`, 'content-type': 'application/json' },
      payload: { model: embedModel(), input: [] },
    });
    expect(bad.statusCode).toBe(400);
    expectErrorShape(bad.json(), { type: 'invalid_request_error', code: 'invalid_request_error', param: null });
  });
});

// ---------- POST /v1/completions (legacy) ----------

describe('POST /v1/completions (legacy)', () => {
  it('non-stream: legacy text_completion shape + exact prompt→messages shim', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/completions',
      headers: { authorization: `Bearer ${KEY_SINGLE}`, 'content-type': 'application/json' },
      payload: { model: 'potion-auto', prompt: CODE_PROMPT, max_tokens: 50, temperature: 0.2 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.object).toBe('text_completion');
    expect(body.id).toMatch(/^cmpl-[0-9a-f]{24}$/);
    expect(typeof body.created).toBe('number');
    expect(body.model).toBe('potion-auto');
    expect(body.choices).toHaveLength(1);
    expect(Object.keys(body.choices[0]).sort()).toEqual(['finish_reason', 'index', 'text']);
    expect(body.choices[0].index).toBe(0);
    expect(body.choices[0].finish_reason).toBe('stop');
    expect(body.choices[0].text).toContain('[mock:mock-cheap]');
    // Shim correctness: prompt became exactly one { role:'user', content } message —
    // the mock's input token estimate is ceil(len('user:'+prompt)/4).
    expect(body.usage.prompt_tokens).toBe(Math.ceil((CODE_PROMPT.length + 'user:'.length) / 4));
    expect(body.usage.completion_tokens).toBeGreaterThan(0);
    expect(body.usage.total_tokens).toBe(body.usage.prompt_tokens + body.usage.completion_tokens);
    expect(res.headers['x-frontier-trace']).toContain('cluster=code-gen');
  });

  it('prompt array → one choice per element (legacy batching)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/completions',
      headers: { authorization: `Bearer ${KEY_SINGLE}`, 'content-type': 'application/json' },
      payload: { model: 'potion-auto', prompt: [CODE_PROMPT, 'Write a python function that parses CSV'] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.choices).toHaveLength(2);
    expect(body.choices.map((c: { index: number }) => c.index)).toEqual([0, 1]);
    expect(body.usage.total_tokens).toBe(body.usage.prompt_tokens + body.usage.completion_tokens);
  });

  it('stream:true → legacy SSE chunk sequence with [DONE] terminator', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/completions',
      headers: { authorization: `Bearer ${KEY_SINGLE}`, 'content-type': 'application/json' },
      payload: { model: 'potion-auto', prompt: CODE_PROMPT, stream: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const frames = sseFrames(res.body);
    expect(frames.length).toBeGreaterThanOrEqual(3); // ≥1 token chunk + stop + [DONE]
    expect(frames[frames.length - 1]).toBe('data: [DONE]');
    const chunks = frames.slice(0, -1).map(frameJson);
    for (const c of chunks) {
      expect(c.object).toBe('text_completion');
      expect(c.id).toMatch(/^cmpl-/);
      expect(c.choices).toHaveLength(1);
      expect(c.choices[0].index).toBe(0);
    }
    const last = chunks[chunks.length - 1]!;
    expect(last.choices[0].finish_reason).toBe('stop');
    for (const c of chunks.slice(0, -1)) {
      expect(c.choices[0].finish_reason).toBeNull();
      expect(typeof c.choices[0].text).toBe('string');
    }
    const text = chunks.slice(0, -1).map((c) => c.choices[0].text).join('');
    expect(text).toContain('[mock:mock-cheap]');
  });

  it('401 without a key; 400 on a malformed body', async () => {
    const noKey = await app.inject({
      method: 'POST',
      url: '/v1/completions',
      headers: { 'content-type': 'application/json' },
      payload: { model: 'potion-auto', prompt: CODE_PROMPT },
    });
    expect(noKey.statusCode).toBe(401);
    expectErrorShape(noKey.json(), { type: 'invalid_request_error', code: 'invalid_api_key', param: null });

    const bad = await app.inject({
      method: 'POST',
      url: '/v1/completions',
      headers: { authorization: `Bearer ${KEY_SINGLE}`, 'content-type': 'application/json' },
      payload: { model: 'potion-auto' },
    });
    expect(bad.statusCode).toBe(400);
    expectErrorShape(bad.json(), { type: 'invalid_request_error', code: 'invalid_request_error', param: null });
  });
});

// ---------- tool calling passthrough (/v1/chat/completions) ----------

describe('tool calling passthrough', () => {
  it('non-stream: tools forwarded → response preserves tool_calls verbatim', async () => {
    const res = await chat(KEY_SINGLE, { tools: TOOLS, tool_choice: 'auto' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.object).toBe('chat.completion');
    const msg = body.choices[0].message;
    expect(msg.role).toBe('assistant');
    expect(msg.content).toBe('');
    expect(msg.tool_calls).toHaveLength(1);
    const tc = msg.tool_calls[0];
    expect(Object.keys(tc).sort()).toEqual(['function', 'id', 'type']);
    expect(tc.id).toMatch(/^call_[0-9a-f]{8}$/);
    expect(tc.type).toBe('function');
    expect(tc.function.name).toBe('get_weather');
    // arguments is the provider-produced JSON STRING (lossless passthrough)
    const args = JSON.parse(tc.function.arguments);
    expect(args.echo).toContain('reverses a string');
    expect(typeof args.seed).toBe('number');
    expect(body.choices[0].finish_reason).toBe('tool_calls');
    expect(body.usage.total_tokens).toBeGreaterThan(0);
  });

  it('stream: tool_calls arrive as OpenAI delta chunks + finish_reason tool_calls', async () => {
    const res = await chat(KEY_SINGLE, { tools: TOOLS, stream: true });
    expect(res.statusCode).toBe(200);
    const frames = sseFrames(res.body);
    expect(frames[frames.length - 1]).toBe('data: [DONE]');
    const chunks = frames.slice(0, -1).map(frameJson);
    // role chunk → tool_calls delta chunk → finish chunk (mock text is '')
    expect(chunks).toHaveLength(3);
    expect(chunks[0]!.choices[0].delta.role).toBe('assistant');
    const delta = chunks[1]!.choices[0].delta;
    expect(delta.tool_calls).toHaveLength(1);
    expect(delta.tool_calls[0].index).toBe(0);
    expect(delta.tool_calls[0].id).toMatch(/^call_[0-9a-f]{8}$/);
    expect(delta.tool_calls[0].type).toBe('function');
    expect(delta.tool_calls[0].function.name).toBe('get_weather');
    expect(JSON.parse(delta.tool_calls[0].function.arguments).echo).toContain('reverses a string');
    expect(chunks[1]!.choices[0].finish_reason).toBeNull();
    expect(chunks[2]!.choices[0].finish_reason).toBe('tool_calls');
  });

  it('tools + non-single strategy → 400 invalid_request_error (param tools)', async () => {
    const res = await chat(KEY_COMPOSITE, { tools: TOOLS });
    expect(res.statusCode).toBe(400);
    expectErrorShape(res.json(), { type: 'invalid_request_error', code: 'invalid_request_error', param: 'tools' });
    expect(res.json().error.message).toContain('best-of-n');
  });

  it('tool_choice without tools → 400 invalid_request_error (param tool_choice)', async () => {
    const res = await chat(KEY_SINGLE, { tool_choice: 'auto' });
    expect(res.statusCode).toBe(400);
    expectErrorShape(res.json(), { type: 'invalid_request_error', code: 'invalid_request_error', param: 'tool_choice' });
  });
});

// ---------- streaming usage (stream_options.include_usage) ----------

describe('stream_options.include_usage', () => {
  it('final chunk carries usage with choices: [] before [DONE]', async () => {
    const res = await chat(KEY_SINGLE, { stream: true, stream_options: { include_usage: true } });
    expect(res.statusCode).toBe(200);
    const frames = sseFrames(res.body);
    expect(frames[frames.length - 1]).toBe('data: [DONE]');
    const chunks = frames.slice(0, -1).map(frameJson);
    const stop = chunks[chunks.length - 2]!;
    expect(stop.choices[0].finish_reason).toBe('stop');
    const usageChunk = chunks[chunks.length - 1]!;
    expect(usageChunk.object).toBe('chat.completion.chunk');
    expect(usageChunk.choices).toEqual([]);
    expect(Object.keys(usageChunk.usage).sort()).toEqual([
      'completion_tokens',
      'prompt_tokens',
      'total_tokens',
    ]);
    expect(usageChunk.usage.prompt_tokens).toBeGreaterThan(0);
    expect(usageChunk.usage.completion_tokens).toBeGreaterThan(0);
    expect(usageChunk.usage.total_tokens).toBe(
      usageChunk.usage.prompt_tokens + usageChunk.usage.completion_tokens,
    );
  });

  it('omitted include_usage → no usage chunk (pre-M3 sequence preserved)', async () => {
    const res = await chat(KEY_SINGLE, { stream: true });
    const frames = sseFrames(res.body);
    const chunks = frames.slice(0, -1).map(frameJson);
    expect(chunks.every((c) => c.choices.length === 1)).toBe(true);
    expect(chunks.some((c) => 'usage' in c)).toBe(false);
  });
});

// ---------- error parity table ----------

describe('error parity table (exact OpenAI shape)', () => {
  it('401 bad key → invalid_api_key', async () => {
    const res = await chat('pk_parity_nope', {});
    expect(res.statusCode).toBe(401);
    expectErrorShape(res.json(), { type: 'invalid_request_error', code: 'invalid_api_key', param: null });
  });

  it('429 rate limited → rate_limit_exceeded (+ Retry-After)', async () => {
    const okRes = await chat(KEY_LIMITED, {});
    expect(okRes.statusCode).toBe(200);
    const res = await chat(KEY_LIMITED, {}); // 1 rps → immediate second is rejected
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expectErrorShape(res.json(), { type: 'rate_limit_exceeded', code: 'rate_limit_exceeded', param: null });
  });

  it('400 bad request → invalid_request_error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${KEY_SINGLE}`, 'content-type': 'application/json' },
      payload: { model: 'potion-auto' },
    });
    expect(res.statusCode).toBe(400);
    expectErrorShape(res.json(), { type: 'invalid_request_error', code: 'invalid_request_error', param: null });
  });

  it('503 provider down → service_unavailable', async () => {
    // A dedicated app whose providers all fail on complete() (embed stays
    // functional so boot/centroids work) — provider-down parity for /v1/chat.
    const mock = createMockProvider(app.potion.prices);
    const failing: Provider = {
      id: 'mock',
      complete: () => Promise.reject(new Error('simulated provider outage')),
      embed: (texts) => mock.embed!(texts),
    };
    const down = await buildServer({ seed: false, providers: { anthropic: failing, openai: failing, google: failing, openrouter: failing, mock: failing } });
    try {
      const db = down.potion.db.db;
      await insertPolicy(db, {
        id: 'pol-down',
        orgId: DEFAULT_ORG_ID,
        name: 'down',
        config: { type: 'latency_bound', p95Ms: 500 },
      });
      await insertApiKey(db, {
        id: 'key-down',
        keyHash: sha256('pk_parity_down'),
        name: 'down',
        orgId: DEFAULT_ORG_ID,
        policyId: 'pol-down',
      });
      const res = await down.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: 'Bearer pk_parity_down', 'content-type': 'application/json' },
        payload: { model: 'potion-auto', messages: [{ role: 'user', content: CODE_PROMPT }] },
      });
      expect(res.statusCode).toBe(503);
      expectErrorShape(res.json(), { type: 'service_unavailable', code: 'service_unavailable', param: null });
    } finally {
      await down.close();
    }
  }, 90_000);
});
