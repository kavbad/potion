// apps/server route tests (vitest + app.inject, ZERO network/services).
// Boots a real server on PGlite with seed disabled and a HAND-MADE frontier
// with known points, so each policy type's selection is asserted exactly.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256, strategyHash, type FrontierPoint, type Policy } from '@potion/core';
import {
  DEFAULT_ORG_ID,
  insertApiKey,
  insertPolicy,
  listProviderKeys,
  listRequestLogs,
} from '@potion/db';
import { saveFrontier } from '@potion/pareto';
import { buildServer } from '../src/server.js';

// ---- known frontier (code-gen) ----
const CFG_CHEAP = { type: 'single', model: 'mock-cheap' } as const;
const CFG_MID = { type: 'single', model: 'mock-mid' } as const;
const CFG_STRONG = { type: 'single', model: 'mock-frontier' } as const;
const CFG_BON = {
  type: 'best-of-n',
  model: 'mock-mid',
  n: 2,
  judge: { model: 'mock-judge' },
} as const;

const H_CHEAP = strategyHash(CFG_CHEAP).slice(0, 8);
const H_MID = strategyHash(CFG_MID).slice(0, 8);
const H_STRONG = strategyHash(CFG_STRONG).slice(0, 8);
const H_BON = strategyHash(CFG_BON).slice(0, 8);

function point(strategyConfig: FrontierPoint['strategyConfig'], quality: number, costPer1K: number, latencyP95: number): FrontierPoint {
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
  point(CFG_MID, 0.7, 1.0, 900),
  point(CFG_STRONG, 0.9, 10.0, 1800),
  point(CFG_BON, 0.95, 25.0, 2000),
];

// ---- keys/policies ----
const KEY_A = 'pk_test_a_maxquality'; // max_quality ceiling 1.5 → mid
const KEY_B = 'pk_test_b_mincost'; // min_cost floor 0.8 → strong
const KEY_C = 'pk_test_c_latency'; // latency_bound 500 → cheap
const KEY_D = 'pk_test_d_infeasible'; // latency_bound 100 → fallback → bon
const KEY_E = 'pk_test_e_nopolicy'; // no policy bound

const CODE_PROMPT = 'Write a python function that reverses a string';

let app: FastifyInstance;

async function chat(rawKey: string, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${rawKey}`, 'content-type': 'application/json' },
    payload: { model: 'potion-auto', messages: [{ role: 'user', content: CODE_PROMPT }], ...payload },
  });
}

beforeAll(async () => {
  app = await buildServer({ seed: false });
  const db = app.potion.db.db;

  const policies: Array<{ id: string; key: string; config: Policy }> = [
    { id: 'pol-a', key: KEY_A, config: { type: 'max_quality', costCeilingPer1K: 1.5 } },
    { id: 'pol-b', key: KEY_B, config: { type: 'min_cost', qualityFloor: 0.8 } },
    { id: 'pol-c', key: KEY_C, config: { type: 'latency_bound', p95Ms: 500 } },
    { id: 'pol-d', key: KEY_D, config: { type: 'latency_bound', p95Ms: 100 } },
  ];
  for (const p of policies) {
    await insertPolicy(db, { id: p.id, orgId: DEFAULT_ORG_ID, name: p.id, config: p.config });
    await insertApiKey(db, {
      id: `key-${p.id}`,
      keyHash: sha256(p.key),
      name: p.id,
      orgId: DEFAULT_ORG_ID,
      policyId: p.id,
    });
  }
  await insertApiKey(db, {
    id: 'key-e',
    keyHash: sha256(KEY_E),
    name: 'key-e',
    orgId: DEFAULT_ORG_ID,
    policyId: null,
  });

  await saveFrontier(db, 'code-gen', POINTS, 'manual', '2026-08-04');
}, 90_000);

afterAll(async () => {
  await app.close();
});

// ---------- auth & validation ----------

describe('auth + validation', () => {
  it('rejects a missing bearer token with 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      payload: { model: 'x', messages: [{ role: 'user', content: CODE_PROMPT }] },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('invalid_api_key');
  });

  it('rejects an unknown key with 401', async () => {
    const res = await chat('pk_test_nope', {});
    expect(res.statusCode).toBe(401);
  });

  it('rejects a key with no policy bound with 403', async () => {
    const res = await chat(KEY_E, {});
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('no_policy_bound');
  });

  it('rejects a missing model with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${KEY_A}`, 'content-type': 'application/json' },
      payload: { messages: [{ role: 'user', content: CODE_PROMPT }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.type).toBe('invalid_request_error');
  });

  it('rejects empty messages with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${KEY_A}`, 'content-type': 'application/json' },
      payload: { model: 'x', messages: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('ignores unknown request fields', async () => {
    const res = await chat(KEY_A, { temperature: 0.2, max_tokens: 50, top_p: 1, nonsense: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().object).toBe('chat.completion');
  });
});

/**
 * Compare an x-frontier-trace ignoring the frontier VERSION.
 *
 * These tests are about policy → strategy resolution, not about version
 * numbering: which strategy won, under which policy, whether it fell back,
 * and what provenance backed it. The version is incidental — a fresh database
 * now imports the live PLATFORM BASELINE before a test saves its own frontier,
 * so a test-authored frontier is v2 rather than v1. Pinning the literal
 * version coupled these assertions to unrelated state; the version is still
 * asserted, as "a real frontier was used", which is the part that carries
 * meaning.
 */
function expectTrace(actual: string | undefined, expected: string): void {
  const strip = (t: string): string => t.replace(/;frontier=v\d+/, '');
  expect(strip(actual ?? '')).toBe(strip(expected));
  const version = Number(/frontier=v(\d+)/.exec(actual ?? '')?.[1] ?? '-1');
  const expectedVersion = Number(/frontier=v(\d+)/.exec(expected)?.[1] ?? '-1');
  // v0 means "no frontier at all" — when the expectation says v0 it is
  // load-bearing, so it still must match exactly.
  if (expectedVersion === 0) expect(version).toBe(0);
  else expect(version).toBeGreaterThan(0);
}

// ---------- policy resolution ----------

describe('policy → strategy resolution (known frontier)', () => {
  it('max_quality (ceiling $1.5/1K) picks the mid single', async () => {
    const res = await chat(KEY_A, {});
    expect(res.statusCode).toBe(200);
    expectTrace(
      res.headers['x-frontier-trace'] as string | undefined,
      `cluster=code-gen;strategy=${H_MID};frontier=v1;policy=max_quality;fallback=0;provenance=mock`,
    );
    expect(res.json().choices[0].message.content).toContain('[mock:mock-mid]');
    expect(res.json().model).toBe('potion-auto');
    expect(res.json().usage.total_tokens).toBeGreaterThan(0);
  });

  it('min_cost (floor 0.8) picks the strong single (cheapest ≥ floor)', async () => {
    const res = await chat(KEY_B, {});
    expect(res.statusCode).toBe(200);
    expectTrace(
      res.headers['x-frontier-trace'] as string | undefined,
      `cluster=code-gen;strategy=${H_STRONG};frontier=v1;policy=min_cost;fallback=0;provenance=mock`,
    );
    expect(res.json().choices[0].message.content).toContain('[mock:mock-frontier]');
  });

  it('latency_bound (500ms) picks the cheap single', async () => {
    const res = await chat(KEY_C, {});
    expect(res.statusCode).toBe(200);
    expectTrace(
      res.headers['x-frontier-trace'] as string | undefined,
      `cluster=code-gen;strategy=${H_CHEAP};frontier=v1;policy=latency_bound;fallback=0;provenance=mock;latency_src=harness`,
    );
  });

  it('infeasible policy falls back to the highest-quality point (fallback=1)', async () => {
    const res = await chat(KEY_D, {});
    expect(res.statusCode).toBe(200);
    expectTrace(
      res.headers['x-frontier-trace'] as string | undefined,
      `cluster=code-gen;strategy=${H_BON};frontier=v1;policy=latency_bound;fallback=1;provenance=mock;latency_src=harness`,
    );
  });

  it('cluster without a frontier uses the documented default strategy (v0, fallback=1)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${KEY_A}`, 'content-type': 'application/json' },
      payload: {
        model: 'x',
        messages: [{ role: 'user', content: 'zqx jkv wobble gribble flibberty' }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-frontier-trace']).toMatch(
      /^cluster=general;strategy=[0-9a-f]{8};frontier=v0;policy=max_quality;fallback=1;provenance=mock$/,
    );
  });

  it('trace header matches the SPEC §8 format', async () => {
    const res = await chat(KEY_A, {});
    expect(res.headers['x-frontier-trace']).toMatch(
      /^cluster=[a-z0-9-]+;strategy=[0-9a-f]{8};frontier=v\d+;policy=(max_quality|min_cost|latency_bound);fallback=[01];provenance=mock$/,
    );
  });
});

// ---------- streaming ----------

describe('streaming contract', () => {
  it('stream:true + single strategy → SSE chunks + [DONE]', async () => {
    const res = await chat(KEY_C, { stream: true });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expectTrace(
      res.headers['x-frontier-trace'] as string | undefined,
      `cluster=code-gen;strategy=${H_CHEAP};frontier=v1;policy=latency_bound;fallback=0;provenance=mock;latency_src=harness`,
    );
    const frames = res.body.split('\n\n').filter((f) => f.trim() !== '');
    expect(frames.length).toBeGreaterThanOrEqual(3); // role + ≥1 content + stop + [DONE]
    const first = JSON.parse(frames[0]!.replace(/^data: /, ''));
    expect(first.object).toBe('chat.completion.chunk');
    expect(first.choices[0].delta.role).toBe('assistant');
    const contentFrames = frames.slice(1, -2).map((f) => JSON.parse(f.replace(/^data: /, '')));
    for (const f of contentFrames) {
      expect(f.choices[0].finish_reason).toBeNull();
      expect(typeof f.choices[0].delta.content).toBe('string');
    }
    const stop = JSON.parse(frames[frames.length - 2]!.replace(/^data: /, ''));
    expect(stop.choices[0].finish_reason).toBe('stop');
    expect(frames[frames.length - 1]).toBe('data: [DONE]');
    const text = contentFrames.map((f) => f.choices[0].delta.content).join('');
    expect(text).toContain('[mock:mock-cheap]');
  });

  it('stream:true + composite strategy → 200 JSON + x-latency-contract: non-streamed', async () => {
    // key D falls back to the best-of-n composite.
    const res = await chat(KEY_D, { stream: true });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['x-latency-contract']).toBe('non-streamed');
    expect(res.headers['x-frontier-trace']).toContain(`strategy=${H_BON}`);
    expect(res.json().object).toBe('chat.completion');
  });
});

// ---------- request logging ----------

describe('request logging', () => {
  it('writes a request_logs row per served request', async () => {
    const before = (await listRequestLogs(app.potion.db.db, DEFAULT_ORG_ID, 500)).length;
    const res = await chat(KEY_A, {});
    expect(res.statusCode).toBe(200);
    const logs = await listRequestLogs(app.potion.db.db, DEFAULT_ORG_ID, 500);
    expect(logs.length).toBe(before + 1);
    const row = logs[0]!; // desc by id
    expect(row.clusterId).toBe('code-gen');
    expect(row.strategyHash).toBe(strategyHash(CFG_MID));
    expect(row.policyType).toBe('max_quality');
    // The version is incidental: a fresh db imports the live platform
    // baseline first, so this test's own frontier sits above it. What must
    // hold is that a REAL frontier served the request (v0 means none).
    expect(row.frontierVersion).toBeGreaterThan(0);
    expect(row.model).toBe('potion-auto');
    expect(row.status).toBe('ok');
    expect(row.usage?.inputTokens).toBeGreaterThan(0);
    expect(typeof row.latencyMs).toBe('number');
    expect(row.trace).toBe(res.headers['x-frontier-trace']);
  });

  it('logs failed auth attempts too', async () => {
    const before = (await listRequestLogs(app.potion.db.db, DEFAULT_ORG_ID, 500)).length;
    await chat('pk_test_nope', {});
    const logs = await listRequestLogs(app.potion.db.db, DEFAULT_ORG_ID, 500);
    expect(logs.length).toBe(before + 1);
    expect(logs[0]!.status).toBe('auth_failed');
    // unattributed traffic is recorded under the default org (M2 #13)
    expect(logs[0]!.orgId).toBe(DEFAULT_ORG_ID);
  });
});

// ---------- /v1/policies ----------

describe('policy endpoints', () => {
  it('GET /v1/policies returns the key’s bound policy', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/policies',
      headers: { authorization: `Bearer ${KEY_B}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().policy.config).toEqual({ type: 'min_cost', qualityFloor: 0.8 });
  });

  it('GET /v1/policies requires auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/policies' });
    expect(res.statusCode).toBe(401);
  });

  it('POST /v1/policies validates, stores, and re-binds the key’s policy', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/policies',
      headers: { authorization: `Bearer ${KEY_C}`, 'content-type': 'application/json' },
      payload: { type: 'min_cost', qualityFloor: 7 },
    });
    expect(bad.statusCode).toBe(400);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/policies',
      headers: { authorization: `Bearer ${KEY_C}`, 'content-type': 'application/json' },
      payload: { type: 'max_quality', costCeilingPer1K: 30, name: 'go-big' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().policy.name).toBe('go-big');

    // now resolves the best-of-n composite (q 0.95, $25 ≤ $30)
    const chatRes = await chat(KEY_C, {});
    expectTrace(
      chatRes.headers['x-frontier-trace'] as string | undefined,
      `cluster=code-gen;strategy=${H_BON};frontier=v1;policy=max_quality;fallback=0;provenance=mock`,
    );
  });
});

// ---------- dashboard API ----------

describe('dashboard API', () => {
  it('POST /api/workloads breaks a JSONL body down by cluster', async () => {
    const jsonl = [
      JSON.stringify('Write a python function to parse a CSV file'),
      JSON.stringify({ prompt: 'Extract the invoice total and vendor as JSON' }),
      'Summarize this earnings report tl;dr',
    ].join('\n');
    const res = await app.inject({
      method: 'POST',
      url: '/api/workloads',
      headers: { 'content-type': 'application/x-ndjson' },
      payload: jsonl,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(3);
    expect(body.breakdown).toEqual({ 'code-gen': 1, extraction: 1, summarization: 1 });
    expect(body.assignments).toHaveLength(3);
  });

  it('POST /api/workloads accepts {"prompts": [...]} JSON too', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workloads',
      headers: { 'content-type': 'application/json' },
      payload: { prompts: ['Write a javascript function', 'Classify this comment as spam or not spam'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().breakdown).toEqual({ 'code-gen': 1, classification: 1 });
  });

  it('POST /api/workloads rejects an empty body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workloads',
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /api/frontiers/:clusterId returns points (dominated=false) + operating point', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/frontiers/code-gen' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.frontier.version).toBeGreaterThan(0); // above the platform baseline
    expect(body.frontier.points).toHaveLength(4);
    for (const p of body.frontier.points) {
      expect(p.dominated).toBe(false);
      expect(p.strategyConfig.type).toBeTruthy();
    }
    // first key with a policy is key A → max_quality ceiling 1.5 → mid
    expect(body.operatingPoint.strategyHash).toBe(strategyHash(CFG_MID));
    expect(body.operatingPoint.policy).toEqual({ type: 'max_quality', costCeilingPer1K: 1.5 });
    expect(body.operatingPoint.fallback).toBe(0);
  });

  it('GET /api/frontiers/:clusterId 404s for an unknown cluster', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/frontiers/nope' });
    expect(res.statusCode).toBe(404);
  });

  it('POST /api/keys stores provider keys MASKED only (idempotent)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/keys',
      headers: { 'content-type': 'application/json' },
      payload: { provider: 'openai', apiKey: 'sk-test-1234567890abcdef', name: 'prod openai' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().maskedKey).toBe('sk-…cdef');
    expect(res.json().maskedKey).not.toContain('1234567890');

    const again = await app.inject({
      method: 'POST',
      url: '/api/keys',
      headers: { 'content-type': 'application/json' },
      payload: { provider: 'openai', apiKey: 'sk-test-1234567890abcdef' },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(res.json().id);

    const stored = await listProviderKeys(app.potion.db.db, DEFAULT_ORG_ID);
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain('sk-test-1234567890abcdef');

    const bad = await app.inject({
      method: 'POST',
      url: '/api/keys',
      headers: { 'content-type': 'application/json' },
      payload: { provider: 'openai', apiKey: 'short' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('POST /api/policies creates a policy and (optionally) a fresh bound key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/policies',
      headers: { 'content-type': 'application/json' },
      payload: { policy: { type: 'latency_bound', p95Ms: 500 }, createKey: true, name: 'fast-lane' },
    });
    expect(res.statusCode).toBe(201);
    const { policy, boundKeyId, apiKey } = res.json();
    expect(policy.name).toBe('fast-lane');
    expect(boundKeyId).toMatch(/^key-/);
    expect(apiKey).toMatch(/^pk_/);

    // the new key serves with its policy immediately (latency 500 → cheap)
    const chatRes = await chat(apiKey, {});
    expect(chatRes.headers['x-frontier-trace']).toContain(`strategy=${H_CHEAP}`);

    const bad = await app.inject({
      method: 'POST',
      url: '/api/policies',
      headers: { 'content-type': 'application/json' },
      payload: { policy: { type: 'nope' } },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('GET /api/endpoint-snippet returns curl + openai-node snippets', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/endpoint-snippet?policy=min_cost' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.policy).toEqual({ type: 'min_cost', qualityFloor: 0.8 });
    expect(body.url).toContain('/v1/chat/completions');
    expect(body.curl).toContain('curl ');
    expect(body.curl).toContain('$POTION_API_KEY');
    expect(body.openaiNode).toContain("import OpenAI from 'openai'");
    expect(body.openaiNode).toContain('baseURL');

    const jsonPolicy = await app.inject({
      method: 'GET',
      url: `/api/endpoint-snippet?policy=${encodeURIComponent(JSON.stringify({ type: 'max_quality', costCeilingPer1K: 2 }))}`,
    });
    expect(jsonPolicy.statusCode).toBe(200);
    expect(jsonPolicy.json().policy).toEqual({ type: 'max_quality', costCeilingPer1K: 2 });

    const bad = await app.inject({ method: 'GET', url: '/api/endpoint-snippet?policy=bogus' });
    expect(bad.statusCode).toBe(400);
  });
});
