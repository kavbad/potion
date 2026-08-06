// Serve-time provenance guard tests (ROADMAP M1a item 4): a simulated number
// may never masquerade as live evidence. Live servers REFUSE tainted
// frontiers (provider_mode 'mock'/'unknown') — falling back per the existing
// no-frontier rule with provenance=blocked in the trace header; mock-only
// (dev) servers allow them with provenance=mock. Zero network: 'live' mode
// uses lazy transports and every executed strategy here resolves to the
// built-in mock provider.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  sha256,
  strategyHash,
  type Frontier,
  type FrontierPoint,
  type Policy,
} from '@potion/core';
import { DEFAULT_ORG_ID, insertApiKey, insertPolicy } from '@potion/db';
import { saveFrontier } from '@potion/pareto';
import { guardFrontierProvenance } from '../src/routes/chat.js';
import { DEFAULT_STRATEGY } from '../src/context.js';
import { buildServer } from '../src/server.js';

const KEY = 'pk_prov_test_key';
const POLICY: Policy = { type: 'max_quality', costCeilingPer1K: 100 };
const CODE_PROMPT = 'Write a python function that reverses a string';

function point(mode: FrontierPoint['providerMode'] | 'absent', quality: number): FrontierPoint {
  const p: FrontierPoint = {
    clusterId: 'code-gen',
    strategyHash: strategyHash({ type: 'single', model: 'mock-mid' }),
    strategyConfig: { type: 'single', model: 'mock-mid' },
    quality,
    costPer1K: 1.0,
    latencyP95: 900,
  };
  if (mode !== 'absent') p.providerMode = mode;
  return p;
}

async function bootWithFrontier(
  providerMode: 'mock' | 'live',
  points: FrontierPoint[],
): Promise<FastifyInstance> {
  const app = await buildServer({ seed: false, providerMode });
  const db = app.potion.db.db;
  await insertPolicy(db, { id: 'pol-prov', orgId: DEFAULT_ORG_ID, name: 'pol-prov', config: POLICY });
  await insertApiKey(db, {
    id: 'key-prov',
    keyHash: sha256(KEY),
    name: 'prov',
    orgId: DEFAULT_ORG_ID,
    policyId: 'pol-prov',
  });
  await saveFrontier(db, 'code-gen', points, 'manual', '2026-08-04');
  return app;
}

async function chat(app: FastifyInstance) {
  return app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    payload: { model: 'potion-auto', messages: [{ role: 'user', content: CODE_PROMPT }] },
  });
}

describe('guardFrontierProvenance (unit)', () => {
  const frontier = (points: FrontierPoint[]): Frontier => ({
    id: 'fr-1',
    clusterId: 'code-gen',
    version: 3,
    parentId: null,
    trigger: 'manual',
    points,
    pricesVersion: 'v1',
    createdAt: '2026-08-04T00:00:00.000Z',
  });

  it('blocks a mock-tainted frontier under live mode (and warns)', () => {
    const warn = vi.fn();
    const out = guardFrontierProvenance(frontier([point('mock', 0.9)]), 'live', warn);
    expect(out.frontier).toBeNull();
    expect(out.provenance).toBe('blocked');
    expect(warn).toHaveBeenCalledOnce();
  });

  it("blocks an 'unknown' (absent) provenance frontier under live mode", () => {
    const out = guardFrontierProvenance(frontier([point('absent', 0.9)]), 'live');
    expect(out.frontier).toBeNull();
    expect(out.provenance).toBe('blocked');
  });

  it('serves an all-live frontier under live mode', () => {
    const f = frontier([point('live', 0.9)]);
    const out = guardFrontierProvenance(f, 'live');
    expect(out.frontier).toBe(f);
    expect(out.provenance).toBe('live');
  });

  it('allows a mock frontier under mock-only (dev) mode', () => {
    const f = frontier([point('mock', 0.9)]);
    const out = guardFrontierProvenance(f, 'mock');
    expect(out.frontier).toBe(f);
    expect(out.provenance).toBe('mock');
  });
});

describe('provenance guard over HTTP', () => {
  describe('live server + mock-provenance frontier → blocked fallback', () => {
    let app: FastifyInstance;
    beforeAll(async () => {
      app = await bootWithFrontier('live', [point('mock', 0.9), point('absent', 0.8)]);
    }, 90_000);
    afterAll(async () => {
      await app.close();
    });

    it('falls back per the no-frontier rule with provenance=blocked in the trace', async () => {
      const res = await chat(app);
      expect(res.statusCode).toBe(200);
      const trace = res.headers['x-frontier-trace'];
      expect(trace).toContain('provenance=blocked');
      expect(trace).toContain('fallback=1');
      expect(trace).toContain('frontier=v0');
      expect(trace).toContain(`strategy=${strategyHash(DEFAULT_STRATEGY).slice(0, 8)}`);
      // request is still served (200) — evidence is blocked, not the customer
      expect(res.json().choices[0].message.content).toBeTruthy();
    });
  });

  describe('live server + live-provenance frontier → served', () => {
    let app: FastifyInstance;
    beforeAll(async () => {
      app = await bootWithFrontier('live', [point('live', 0.9)]);
    }, 90_000);
    afterAll(async () => {
      await app.close();
    });

    it('serves from the frontier with provenance=live', async () => {
      const res = await chat(app);
      expect(res.statusCode).toBe(200);
      const trace = res.headers['x-frontier-trace'];
      expect(trace).toContain('provenance=live');
      expect(trace).toContain('fallback=0');
      expect(trace).toContain('frontier=v1');
    });
  });

  describe('mock-only server (dev) + mock frontier → provenance=mock', () => {
    let app: FastifyInstance;
    beforeAll(async () => {
      app = await bootWithFrontier('mock', [point('mock', 0.9)]);
    }, 90_000);
    afterAll(async () => {
      await app.close();
    });

    it('serves from the frontier with provenance=mock', async () => {
      const res = await chat(app);
      expect(res.statusCode).toBe(200);
      const trace = res.headers['x-frontier-trace'];
      expect(trace).toContain('provenance=mock');
      expect(trace).toContain('fallback=0');
      expect(trace).toContain('frontier=v1');
    });
  });
});
