// THE FLOOR-INFEASIBLE ALERT (2026-09-16): a key whose floor admits no
// measured point on a kind of work mints ONE alert per episode, not one per
// request — and the serve path itself is what raises it.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256, strategyHash, type FrontierPoint } from '@potion/core';
import { createOrg, insertApiKey, insertPolicy } from '@potion/db';
import { saveFrontier } from '@potion/pareto';
import { createQueue, type PotionQueue } from '@potion/queue';
import { buildServer } from '../src/server.js';
import { alertFloorInfeasible, resetFloorInfeasibleAlerts } from '../src/routing/floor-alert.js';
import type { PotionContext } from '../src/context.js';

const ORG = 'org-floor-alert';
const KEY = 'pk_floor_alert';
const enqueued: Array<{ name: string; payload: { orgId: string; event: string; detail?: Record<string, unknown> } }> = [];

function recordingQueue(): PotionQueue {
  const inner = createQueue();
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'enqueue') {
        return async (name: string, payload: unknown) => {
          enqueued.push({ name, payload: payload as (typeof enqueued)[number]['payload'] });
          return (target as PotionQueue).enqueue(name, payload);
        };
      }
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as PotionQueue;
}

function pt(model: string, quality: number, costPer1K: number, evidence?: FrontierPoint['evidence']): FrontierPoint {
  const strategyConfig = { type: 'single', model } as FrontierPoint['strategyConfig'];
  return { clusterId: 'classification', strategyHash: strategyHash(strategyConfig), strategyConfig, quality, costPer1K, latencyP95: 400, providerMode: 'mock', ...(evidence ? { evidence } : {}) } as FrontierPoint;
}

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildServer({ seed: false, queue: recordingQueue() });
  const db = app.potion.db.db;
  await createOrg(db, { id: ORG, name: 'Floor Alert Co' });
  // Best point proves 0.91; the key's floor is 0.95 → infeasible on classification.
  await saveFrontier(db, 'classification', [pt('mock-cheap', 0.8, 0.2), pt('mock-mid', 0.97, 1.0, { n: 20, qualityCi: [0.91, 0.99] } as FrontierPoint['evidence'])], 'manual', 'test-prices');
  await insertPolicy(db, { id: 'pol-floor-alert', orgId: ORG, name: 'floor 0.95', config: { type: 'min_cost', qualityFloor: 0.95 } });
  await insertApiKey(db, { id: 'key-floor-alert', keyHash: sha256(KEY), name: 'serve', orgId: ORG, policyId: 'pol-floor-alert' });
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  resetFloorInfeasibleAlerts();
  enqueued.length = 0;
});

const infeasibleAlerts = () => enqueued.filter((e) => e.name === 'alerts:dispatch' && e.payload.event === 'policy_infeasible' && e.payload.detail?.leg === 'floor');

async function serve() {
  return app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${KEY}`, 'x-potion-cluster': 'classification' },
    payload: { model: 'potion-auto', messages: [{ role: 'user', content: 'Is this review positive?' }] },
  });
}

describe('the serve path raises it', () => {
  it('one infeasible request → one policy_infeasible alert naming the floor, the highest provable quality, and the served point', async () => {
    const res = await serve();
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['x-frontier-trace']).toContain('fallback=1');
    // fire-and-forget: give the emit a tick
    await new Promise((r) => setTimeout(r, 50));
    const alerts = infeasibleAlerts();
    expect(alerts, JSON.stringify(enqueued)).toHaveLength(1);
    const d = alerts[0]!.payload.detail!;
    expect(d.clusterId).toBe('classification');
    expect(d.policyId).toBe('pol-floor-alert');
    expect(d.qualityFloor).toBe(0.95);
    expect(d.highestProvable).toBe(0.91);
    expect(d.bestModel).toBe('mock-mid');
    expect(String(d.narrative)).toContain('highest provable is 0.91');
  });

  it('a thousand requests, one alert: the second request in the episode is silent', async () => {
    await serve();
    await serve();
    await serve();
    await new Promise((r) => setTimeout(r, 50));
    expect(infeasibleAlerts()).toHaveLength(1);
  });
});

describe('the dedupe', () => {
  // The real context (the server's, with the recording queue above) — a
  // stub cast past the type would be checked against nothing.
  const ctx = (): PotionContext => app.potion;
  const args = { orgId: 'o', policyId: 'p', clusterId: 'c', policy: { type: 'min_cost', qualityFloor: 0.95 } as const, frontier: null, servedStrategy: 'x' };

  it('same org+policy+cluster within the TTL: once; after the TTL: again; a different cluster: its own episode', async () => {
    const t0 = 1_000_000;
    expect(await alertFloorInfeasible(ctx(), args, t0)).toBe(true);
    expect(await alertFloorInfeasible(ctx(), args, t0 + 1000)).toBe(false);
    expect(await alertFloorInfeasible(ctx(), { ...args, clusterId: 'd' }, t0 + 1000)).toBe(true);
    expect(await alertFloorInfeasible(ctx(), args, t0 + 7 * 3600 * 1000)).toBe(true);
    expect(infeasibleAlerts()).toHaveLength(3);
  });

  it('an inline override (no policy id) has nothing durable to alert about', async () => {
    expect(await alertFloorInfeasible(ctx(), { ...args, policyId: null })).toBe(false);
    expect(infeasibleAlerts()).toHaveLength(0);
  });
});
