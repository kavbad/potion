// G: an image-carrying request is served only from a cluster's frontier
// measured on vision; the parts reach the provider verbatim; without such a
// frontier the refusal names the cluster.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256, strategyHash, type FrontierPoint } from '@potion/core';
import { createOrg, insertApiKey, insertPolicy } from '@potion/db';
import { saveFrontier } from '@potion/pareto';
import { buildServer } from '../src/server.js';

const ORG = 'org-vision';
const KEY = 'pk_vision';
const VISION_PICK = { type: 'single', model: 'mock-mid' } as const;
let app: FastifyInstance;
const seen: unknown[] = [];
const IMG = { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==' } };

function point(cfg: FrontierPoint['strategyConfig'], quality: number): FrontierPoint {
  return { clusterId: 'extraction', strategyHash: strategyHash(cfg), strategyConfig: cfg, quality, costPer1K: 0.5, latencyP95: 400, providerMode: 'mock' };
}

beforeAll(async () => {
  app = await buildServer({ seed: false });
  const db = app.potion.db.db;
  await createOrg(db, { id: ORG, name: 'Vision' });
  await insertPolicy(db, { id: 'pol-vision', orgId: ORG, name: 'floor', config: { type: 'min_cost', qualityFloor: 0.5 } });
  await insertApiKey(db, { id: 'key-vision', keyHash: sha256(KEY), name: 'serve', orgId: ORG, policyId: 'pol-vision' });
  await saveFrontier(db, 'extraction', [point({ type: 'single', model: 'mock-cheap' }, 0.9)], 'manual', 'test-prices');
  await saveFrontier(db, 'code-gen', [{ ...point({ type: 'single', model: 'mock-cheap' }, 0.9), clusterId: 'code-gen' }], 'manual', 'test-prices');
  await saveFrontier(db, 'extraction', [point(VISION_PICK, 0.95)], 'manual', 'test-prices', { instrument: 'vision' });
  const real = app.potion.providersForOrg;
  app.potion.providersForOrg = async (orgId: string) => {
    const set = await real(orgId);
    const mock = { ...set.providers.mock, complete: async (req: Parameters<typeof set.providers.mock.complete>[0]) => { seen.push(req.messages); return set.providers.mock.complete(req); } };
    const providers = { ...set.providers, mock };
    return { ...set, providers, resolve: (m: string) => { const r = set.resolve(m); return r.provider.id === 'mock' ? { ...r, provider: mock } : r; } };
  };
});
afterAll(async () => {
  await app.close();
});

const post = (cluster: string, content: unknown) =>
  app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${KEY}`, 'x-potion-cluster': cluster }, payload: { model: 'potion-auto', messages: [{ role: 'user', content }] } });

describe('vision serving', () => {
  it('an image request on a cluster WITH a vision frontier is served from it; the parts reach the provider', async () => {
    seen.length = 0;
    const res = await post('extraction', [{ type: 'text', text: 'Read the invoice total.' }, IMG]);
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-potion-model']).toBe('mock-mid');
    expect(String(res.headers['x-frontier-trace'])).toContain('instrument=vision');
    const msgs = seen[0] as { parts?: unknown[]; content: string }[];
    expect(msgs[0]!.parts).toHaveLength(2);
    expect(msgs[0]!.content).toBe('Read the invoice total.');
  });
  it('an image request on a cluster WITHOUT one is refused, naming the cluster', async () => {
    const res = await post('code-gen', [{ type: 'text', text: 'What is in this screenshot?' }, IMG]);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('unsupported_content');
    expect(res.json().error.message).toContain("'code-gen'");
  });
  it('a text request on the same cluster keeps the default frontier', async () => {
    const res = await post('extraction', 'Extract the city from: shipped to Paris.');
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-potion-model']).toBe('mock-cheap');
    expect(String(res.headers['x-frontier-trace'])).not.toContain('instrument=');
  });
});

describe('audio serving (G, same gate as vision)', () => {
  const AUD = { type: 'input_audio', input_audio: { data: 'UklGRiQAAABXQVZF', format: 'wav' } };
  it('an audio request on a cluster WITHOUT an audio frontier is refused, naming the modality', async () => {
    const res = await post('extraction', [{ type: 'text', text: 'What code is spoken?' }, AUD]);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('unsupported_content');
    expect(res.json().error.message).toMatch(/audio inputs.*'extraction'/);
  });
  it('with an audio frontier it is served from it', async () => {
    const db = app.potion.db.db;
    await saveFrontier(db, 'extraction', [point(VISION_PICK, 0.9)], 'manual', 'test-prices', { instrument: 'audio' });
    const res = await post('extraction', [{ type: 'text', text: 'What code is spoken?' }, AUD]);
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['x-frontier-trace'])).toContain('instrument=audio');
    const msgs = seen.at(-1) as { parts?: { type: string }[] }[];
    expect(msgs[0]!.parts?.some((p) => p.type === 'input_audio')).toBe(true);
  });
});
