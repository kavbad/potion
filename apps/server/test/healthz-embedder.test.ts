// M1a item 3 tests: server boot reports the resolved embedder at /healthz as
// {mode, model, dims} and logs the embedder mode at boot — mock by default
// (loud simulated-routing warning), openai when POTION_EMBEDDER=openai with a
// key. The openai path is exercised with a STUBBED key + STUBBED global fetch
// (no real network).
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';

const ENV_KEYS = ['POTION_EMBEDDER', 'OPENAI_API_KEY', 'POTION_CLUSTER_THRESHOLD'] as const;

function snapshotEnv() {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>) {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

/** Deterministic 384-dim unit-ish vector for the stubbed embeddings API. */
function stubEmbedding(seed: number): number[] {
  const v = new Array<number>(384).fill(0);
  v[seed % 384] = 1;
  v[(seed * 7 + 13) % 384] = 0.5;
  return v;
}

/** Stub globalThis.fetch for POST /v1/embeddings: echoes one 384-dim vector
 * per input text, asserting the request pins model + dimensions:384. */
function stubEmbeddingsFetch(calls: Array<{ model: string; dimensions: number; inputs: number }>) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      model?: string;
      dimensions?: number;
      input?: string[];
    };
    const inputs = body.input ?? [];
    calls.push({ model: body.model ?? '', dimensions: body.dimensions ?? 0, inputs: inputs.length });
    expect(String(url)).toContain('/v1/embeddings');
    expect(body.model).toBe('text-embedding-3-small');
    expect(body.dimensions).toBe(384);
    return new Response(
      JSON.stringify({
        data: inputs.map((_, i) => ({ index: i, embedding: stubEmbedding(i) })),
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
}

describe('/healthz embedder reporting (M1a)', () => {
  const saved = snapshotEnv();
  let app: FastifyInstance | undefined;
  const realFetch = globalThis.fetch;

  afterEach(async () => {
    globalThis.fetch = realFetch;
    restoreEnv(saved);
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it('mock default: healthz reports {mode:mock, model, dims:384} and boot logs the loud warning', async () => {
    delete process.env.POTION_EMBEDDER;
    delete process.env.OPENAI_API_KEY;
    const logs: string[] = [];
    app = await buildServer({ seed: false, log: (m) => logs.push(m) });

    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { embedder: { mode: string; model: string; dims: number } };
    expect(body.embedder.mode).toBe('mock');
    expect(body.embedder.model).toBe('mock-keyword-clustered-384');
    expect(body.embedder.dims).toBe(384);

    expect(logs.some((l) => l.includes('mock embeddings: cluster assignment is simulated'))).toBe(
      true,
    );
    expect(logs.some((l) => l.includes('embedder mode=mock') && l.includes('dims=384'))).toBe(true);
  }, 90_000);

  it('openai-selected: stubbed key + stubbed fetch → healthz reports openai/text-embedding-3-small/384', async () => {
    process.env.POTION_EMBEDDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-test-stubbed';
    const calls: Array<{ model: string; dimensions: number; inputs: number }> = [];
    globalThis.fetch = stubEmbeddingsFetch(calls);

    const logs: string[] = [];
    app = await buildServer({ seed: false, log: (m) => logs.push(m) });

    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { embedder: { mode: string; model: string; dims: number } };
    expect(body.embedder).toEqual({
      mode: 'openai',
      model: 'text-embedding-3-small',
      dims: 384,
    });
    // Centroid building went through the stubbed embeddings endpoint with the
    // canonical dimensions pin; no mock warning on this path.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.dimensions === 384 && c.model === 'text-embedding-3-small')).toBe(
      true,
    );
    expect(logs.some((l) => l.includes('embedder mode=openai'))).toBe(true);
    expect(logs.some((l) => l.includes('mock embeddings'))).toBe(false);
  }, 90_000);

  it('boot refuses POTION_EMBEDDER=google with a clear non-canonical error', async () => {
    process.env.POTION_EMBEDDER = 'google';
    delete process.env.OPENAI_API_KEY;
    await expect(buildServer({ seed: false, log: () => {} })).rejects.toThrowError(/768-dim/);
  }, 90_000);
});
