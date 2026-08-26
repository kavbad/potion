// Public measured-answers endpoint (Answer Engine C1, 2026-08-25).
// The redaction contract is the test: embargoed models and combination
// compositions NEVER appear in the public payload, simulated evidence never
// masquerades as measurement, and thin frontiers are omitted entirely.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { strategyHash, type FrontierPoint, type StrategyConfig } from '@potion/core';
import { saveFrontier } from '@potion/pareto';
import { buildServer } from '../src/server.js';

const PUBLIC_SINGLE: StrategyConfig = { type: 'single', model: 'gpt-mini-class' };
const EMBARGOED_SINGLE: StrategyConfig = { type: 'single', model: 'or-solar-pro4' };
const COMBINATION: StrategyConfig = {
  type: 'cascade',
  stages: [
    { model: 'gpt-mini-class', confidenceThreshold: 0.7 },
    { model: 'gpt-frontier-class', confidenceThreshold: 0 },
  ],
  confidenceMethod: 'logprob',
} as never;

function pt(clusterId: string, config: StrategyConfig, quality: number, costPer1K: number, providerMode: 'live' | 'mock'): FrontierPoint {
  return { clusterId, strategyHash: strategyHash(config), strategyConfig: config, quality, costPer1K, latencyP95: 500, providerMode } as FrontierPoint;
}

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer({ seed: false });
  const db = app.potion.db.db;
  // extraction: 3 live points — the publishable case, with all three label kinds.
  await saveFrontier(db, 'extraction', [
    pt('extraction', EMBARGOED_SINGLE, 0.99, 0.02, 'live'),
    pt('extraction', PUBLIC_SINGLE, 0.94, 0.3, 'live'),
    pt('extraction', COMBINATION, 1.0, 0.9, 'live'),
  ], 'manual', 'test-prices');
  // code-gen: only ONE live point — a single point is not a comparison; omitted.
  await saveFrontier(db, 'code-gen', [
    pt('code-gen', PUBLIC_SINGLE, 0.9, 0.1, 'live'),
    pt('code-gen', COMBINATION, 0.95, 0.5, 'mock'),
  ], 'manual', 'test-prices');
  // summarization: all mock — simulated evidence never reaches the public page.
  await saveFrontier(db, 'summarization', [
    pt('summarization', PUBLIC_SINGLE, 0.8, 0.1, 'mock'),
    pt('summarization', COMBINATION, 0.9, 0.4, 'mock'),
  ], 'manual', 'test-prices');
}, 90_000);

afterAll(async () => {
  await app.close();
});

describe('GET /api/public/answers', () => {
  it('serves without a session, live-only, thin clusters omitted', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/public/answers' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toContain('public');
    const body = res.json() as { clusters: Array<{ clusterId: string; points: Array<Record<string, unknown>> }> };
    const ids = body.clusters.map((c) => c.clusterId);
    expect(ids).toContain('extraction');
    expect(ids).not.toContain('code-gen'); // 1 live point — omitted
    expect(ids).not.toContain('summarization'); // all simulated — omitted
    const ex = body.clusters.find((c) => c.clusterId === 'extraction')!;
    expect(ex.points).toHaveLength(3);
  });

  it('masks the embargoed model and every combination; names the public single readably', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/public/answers' });
    const ex = (res.json() as { clusters: Array<{ clusterId: string; points: Array<{ label: string; masked: boolean; kind: string }> }> })
      .clusters.find((c) => c.clusterId === 'extraction')!;
    const labels = ex.points.map((p) => p.label);
    expect(labels.some((l) => l.includes('gpt-4.1-mini'))).toBe(true); // prices display name
    expect(ex.points.filter((p) => p.masked)).toHaveLength(2);
    expect(ex.points.find((p) => p.kind === 'combination')!.label).toContain('withheld');
  });

  it('the serialized payload carries no embargoed name, no member list, no strategy hash', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/public/answers' });
    const raw = res.body.toLowerCase();
    for (const banned of ['solar', 'upstage', 'cascade', 'confidencethreshold', 'gpt-frontier-class', 'strategyhash']) {
      expect(raw).not.toContain(banned);
    }
    expect(/[0-9a-f]{16,64}/.test(res.body)).toBe(false); // no hashes of any kind
  });
});
