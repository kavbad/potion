// M3 #26 observability — server integration tests (vitest + app.inject,
// ZERO network/services). Boots the real server on PGlite (seed disabled)
// with a hand-made code-gen frontier, mirroring test/server.test.ts.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256, strategyHash, type FrontierPoint } from '@potion/core';
import { DEFAULT_ORG_ID, insertApiKey, insertPolicy } from '@potion/db';
import { saveFrontier } from '@potion/pareto';
import { buildServer } from '../src/server.js';

const KEY = 'pk_test_observability';
const CFG_MID = { type: 'single', model: 'mock-mid' } as const;
const H_MID = strategyHash(CFG_MID);
const CODE_PROMPT = 'Write a python function that reverses a string';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer({ seed: false });
  const db = app.potion.db.db;
  await insertPolicy(db, {
    id: 'pol-obs',
    orgId: DEFAULT_ORG_ID,
    name: 'pol-obs',
    config: { type: 'max_quality', costCeilingPer1K: 100 },
  });
  await insertApiKey(db, {
    id: 'key-obs',
    keyHash: sha256(KEY),
    name: 'key-obs',
    orgId: DEFAULT_ORG_ID,
    policyId: 'pol-obs',
  });
  const point: FrontierPoint = {
    clusterId: 'code-gen',
    strategyHash: H_MID,
    strategyConfig: CFG_MID,
    quality: 0.7,
    costPer1K: 1.0,
    latencyP95: 900,
  };
  await saveFrontier(db, 'code-gen', [point], 'manual', '2026-08-04');
}, 90_000);

afterAll(async () => {
  await app.close();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function chat(headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', ...headers },
    payload: { model: 'potion-auto', messages: [{ role: 'user', content: CODE_PROMPT }] },
  });
}

describe('M3 #26 observability (server integration)', () => {
  it('GET /metrics returns 200 Prometheus text with the request series', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('potion_http_requests_total');
    expect(res.body).toContain('potion_http_request_duration_ms');
  });

  it('a served chat request increments the frontier-decision series', async () => {
    const res = await chat();
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-frontier-trace']).toContain(`strategy=${H_MID.slice(0, 8)}`);
    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.body).toContain(
      `potion_frontier_decisions_total{cluster_id="code-gen",strategy_hash="${H_MID}",fallback="0",provenance="mock"}`,
    );
  });

  it('provider calls are observed through the withMetrics proxy', async () => {
    await chat();
    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.body).toContain('potion_provider_calls_total{provider="mock",model="mock-mid"');
    expect(metrics.body).toContain('potion_provider_call_duration_ms');
  });

  it('http request counting includes the chat route', async () => {
    await chat();
    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.body).toContain('potion_http_requests_total{route="/v1/chat/completions",status="200"}');
  });

  it('inbound x-request-id is preserved and echoed', async () => {
    const res = await chat({ 'x-request-id': 'req-integration-42' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toBe('req-integration-42');
  });

  it('absent x-request-id → a uuid is generated and echoed', async () => {
    const res = await chat();
    const id = res.headers['x-request-id'];
    expect(typeof id).toBe('string');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('SSE responses echo the request id too (hijacked path)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: `Bearer ${KEY}`,
        'content-type': 'application/json',
        'x-request-id': 'req-sse-7',
      },
      payload: {
        model: 'potion-auto',
        messages: [{ role: 'user', content: CODE_PROMPT }],
        stream: true,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.headers['x-request-id']).toBe('req-sse-7');
  });

  it('POTION_METRICS=0 disables /metrics (M2 surface unchanged)', async () => {
    vi.stubEnv('POTION_METRICS', '0');
    const off = await buildServer({ seed: false });
    try {
      const res = await off.inject({ method: 'GET', url: '/metrics' });
      expect(res.statusCode).toBe(404);
      // Serving still works with metrics off.
      const db = off.potion.db.db;
      await insertPolicy(db, {
        id: 'pol-obs-off',
        orgId: DEFAULT_ORG_ID,
        name: 'pol-obs-off',
        config: { type: 'max_quality', costCeilingPer1K: 100 },
      });
      await insertApiKey(db, {
        id: 'key-obs-off',
        keyHash: sha256(KEY),
        name: 'key-obs-off',
        orgId: DEFAULT_ORG_ID,
        policyId: 'pol-obs-off',
      });
      const chatRes = await off.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
        payload: { model: 'potion-auto', messages: [{ role: 'user', content: CODE_PROMPT }] },
      });
      expect(chatRes.statusCode).toBe(200);
    } finally {
      await off.close();
    }
  }, 90_000);
});
