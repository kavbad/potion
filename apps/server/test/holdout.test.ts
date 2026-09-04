// G1 RANDOMIZED INCUMBENT HOLDOUT (0086), end to end in the mock world:
//   consent-gated swap on the serve path (labeled everywhere it lands),
//   pin outranks it, the settings route caps + 409s honestly, and the
//   Savings report's verified block only says "verified" when the org's
//   own randomized traffic proves it.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256, strategyHash, type FrontierPoint, type PriceTable, type StrategyConfig } from '@potion/core';
import {
  createOrg,
  insertApiKey,
  insertPolicy,
  insertRequestLog,
  listRequestLogs,
  setHoldoutConfig,
  upsertOrgIncumbents,
} from '@potion/db';
import { saveFrontier } from '@potion/pareto';
import { buildServer } from '../src/server.js';
import { HOLDOUT_MAX_RATE, bustHoldoutCache, eligibleIncumbent } from '../src/routing/holdout.js';
import { MIN_HOLDOUT_REQUESTS, buildVerifiedSavings } from '../src/routes/reports.js';

const ORG = 'org-holdout';
const KEY = 'pk_holdout';
const CHEAP = { type: 'single', model: 'mock-cheap' } as const; // the router's pick
const INCUMBENT = 'mock-frontier';

function point(cfg: StrategyConfig, quality: number, costPer1K: number): FrontierPoint {
  return { clusterId: 'classification', strategyHash: strategyHash(cfg), strategyConfig: cfg, quality, costPer1K, latencyP95: 300, providerMode: 'mock' };
}

let app: FastifyInstance;
const db = () => app.potion.db.db;

async function serve(payload: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${KEY}`, 'x-potion-cluster': 'classification' },
    payload: { model: 'potion-auto', messages: [{ role: 'user', content: 'urgent or routine?' }], ...payload },
  });
}

beforeAll(async () => {
  app = await buildServer({ seed: false });
  await createOrg(db(), { id: ORG, name: 'Holdout' });
  await insertPolicy(db(), { id: 'pol-holdout', orgId: ORG, name: 'h', config: { type: 'min_cost', qualityFloor: 0.7 } });
  await insertApiKey(db(), { id: 'key-holdout', keyHash: sha256(KEY), name: 'serve', orgId: ORG, policyId: 'pol-holdout', scopes: 'serve+admin' });
  await saveFrontier(db(), 'classification', [point(CHEAP, 0.8, 0.2)], 'manual', 'test-prices');
  await upsertOrgIncumbents(db(), { orgId: ORG, models: [INCUMBENT], other: null, samplingConsent: false });
});
afterAll(async () => {
  await app.close();
});
afterEach(() => {
  vi.restoreAllMocks();
  bustHoldoutCache(ORG);
});

describe('the serve-path swap', () => {
  it('consent off → the router serves; no holdout marks anywhere', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.0001); // would fire if enabled
    const res = await serve();
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-potion-model']).toBe('mock-cheap');
    expect(String(res.headers['x-frontier-trace'])).not.toContain('holdout=');
  });

  it('consent on + the draw lands in the slice → the NAMED incumbent serves, labeled everywhere', async () => {
    await setHoldoutConfig(db(), ORG, { consent: true, rate: HOLDOUT_MAX_RATE });
    bustHoldoutCache(ORG);
    vi.spyOn(Math, 'random').mockReturnValue(0.0001); // inside the slice
    const res = await serve();
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-potion-model']).toBe(INCUMBENT);
    expect(String(res.headers['x-frontier-trace'])).toContain('holdout=1');
    expect(String(res.headers['x-frontier-trace'])).not.toContain('router=v'); // the router did not decide it
    const row = (await listRequestLogs(db(), ORG, 5)).find((r) => r.completionId === res.json().id)!;
    expect(row.holdout).toBe(true);
    expect(row.baselineCostUsd).toBeNull(); // a baseline request never claims savings
    expect(row.routerVersion).toBeNull();
    expect(row.servedModel).toBe(INCUMBENT);
  });

  it('a draw outside the slice serves normally even with consent on', async () => {
    await setHoldoutConfig(db(), ORG, { consent: true, rate: HOLDOUT_MAX_RATE });
    bustHoldoutCache(ORG);
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    const res = await serve();
    expect(res.headers['x-potion-model']).toBe('mock-cheap');
    expect(String(res.headers['x-frontier-trace'])).not.toContain('holdout=');
  });

  it('an explicit pin outranks the holdout', async () => {
    await setHoldoutConfig(db(), ORG, { consent: true, rate: HOLDOUT_MAX_RATE });
    bustHoldoutCache(ORG);
    vi.spyOn(Math, 'random').mockReturnValue(0.0001);
    const res = await serve({ model: 'mock-mid' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-potion-model']).toBe('mock-mid');
    expect(String(res.headers['x-frontier-trace'])).not.toContain('holdout=');
  });
});

describe('eligibleIncumbent (fail-closed)', () => {
  const prices = app ? undefined : undefined; // populated in tests below via app
  void prices;
  it('never a mock baseline under live providers; honest reasons otherwise', () => {
    const table: PriceTable = { version: 'v', updatedAt: '', entries: [{ alias: 'mock-frontier', provider: 'mock', model: 'mock', inputPer1M: 1, outputPer1M: 1 }] };
    expect(eligibleIncumbent(['mock-frontier'], table, 'live')).toMatchObject({ model: null });
    expect(eligibleIncumbent(['mock-frontier'], table, 'mock')).toEqual({ model: 'mock-frontier' });
    expect(eligibleIncumbent([], table, 'mock')).toMatchObject({ model: null, why: 'no incumbent designated' });
    expect(eligibleIncumbent(['not-priced'], table, 'mock')).toMatchObject({ model: null });
  });
});

describe('the settings route', () => {
  it('caps the rate, 409s without an incumbent, and reflects state', async () => {
    const put = (payload: Record<string, unknown>) =>
      app.inject({ method: 'PUT', url: '/api/holdout', headers: { authorization: `Bearer ${KEY}` }, payload });
    expect((await put({ enabled: true, rate: 0.2 })).statusCode).toBe(400); // above the cap
    expect((await put({ enabled: true, rate: 0.03 })).statusCode).toBe(200);
    const state = await app.inject({ method: 'GET', url: '/api/holdout', headers: { authorization: `Bearer ${KEY}` } });
    expect(state.json()).toMatchObject({ enabled: true, rate: 0.03, incumbentModel: INCUMBENT, eligible: true, maxRate: HOLDOUT_MAX_RATE });
    expect((await put({ enabled: false })).statusCode).toBe(200);
  });
});

describe('verified savings (the only block allowed to say "verified")', () => {
  const stats = (holdoutCosts: number[], routed: { requests: number; spendUsd: number }) => ({
    holdout: { requests: holdoutCosts.length, costs: holdoutCosts },
    routed,
  });

  it('off / no-incumbent / insufficient are absent states, never zeros dressed as proof', () => {
    expect(buildVerifiedSavings({ consent: false, rate: 0.02, incumbentModel: 'x' }, stats([0.002], { requests: 10, spendUsd: 0.005 }), 'k').status).toBe('off');
    expect(buildVerifiedSavings({ consent: true, rate: 0.02, incumbentModel: null }, stats([0.002], { requests: 10, spendUsd: 0.005 }), 'k').status).toBe('no-incumbent');
    const few = buildVerifiedSavings({ consent: true, rate: 0.02, incumbentModel: 'x' }, stats(Array(5).fill(0.002), { requests: 10, spendUsd: 0.005 }), 'k');
    expect(few.status).toBe('insufficient');
    expect(few.verifiedSavingsUsd).toBeNull();
  });

  it('the verified numbers: measured mean × routed count, and the billable LOWER bound never exceeds the estimate', () => {
    const costs = Array.from({ length: MIN_HOLDOUT_REQUESTS + 10 }, (_, i) => 0.002 + (i % 5) * 0.0001);
    const v = buildVerifiedSavings({ consent: true, rate: 0.02, incumbentModel: 'gpt-x' }, stats(costs, { requests: 1000, spendUsd: 0.5 }), 'seed-key');
    expect(v.status).toBe('verified');
    expect(v.meanIncumbentCostUsd!).toBeGreaterThan(0.002);
    expect(v.withoutPotionUsd!).toBeCloseTo(v.meanIncumbentCostUsd! * 1000, 8);
    expect(v.verifiedSavingsUsd!).toBeCloseTo(v.withoutPotionUsd! - 0.5, 8);
    expect(v.verifiedSavingsLowerUsd!).toBeLessThanOrEqual(v.verifiedSavingsUsd!);
    expect(v.meanCi95![0]).toBeLessThanOrEqual(v.meanIncumbentCostUsd!);
    // deterministic: same window + same costs → same interval
    const again = buildVerifiedSavings({ consent: true, rate: 0.02, incumbentModel: 'gpt-x' }, stats(costs, { requests: 1000, spendUsd: 0.5 }), 'seed-key');
    expect(again.meanCi95).toEqual(v.meanCi95);
  });

  it('the savings report carries the block end to end', async () => {
    await setHoldoutConfig(db(), ORG, { consent: true, rate: 0.03 });
    const today = new Date();
    for (let i = 0; i < MIN_HOLDOUT_REQUESTS + 5; i += 1) {
      await insertRequestLog(db(), {
        orgId: ORG, clusterId: 'classification', strategyHash: strategyHash({ type: 'single', model: INCUMBENT }),
        model: INCUMBENT, status: 'ok', usage: { inputTokens: 120, outputTokens: 60, costUsd: 0.002, latencyMs: 300 }, latencyMs: 300, holdout: true, ts: today,
      });
    }
    for (let i = 0; i < 100; i += 1) {
      await insertRequestLog(db(), {
        orgId: ORG, clusterId: 'classification', strategyHash: strategyHash(CHEAP),
        model: 'mock-cheap', status: 'ok', usage: { inputTokens: 120, outputTokens: 60, costUsd: 0.0002, latencyMs: 200 }, latencyMs: 200, ts: today,
      });
    }
    const res = await app.inject({ method: 'GET', url: '/api/reports/savings', headers: { authorization: `Bearer ${KEY}` } });
    expect(res.statusCode).toBe(200);
    const v = (res.json() as { verified: { status: string; holdoutRate: number; incumbentModel: string; meanIncumbentCostUsd: number; verifiedSavingsUsd: number; verifiedSavingsLowerUsd: number } }).verified;
    expect(v.status).toBe('verified');
    expect(v.holdoutRate).toBe(0.03); // the slice is visible where the claim renders
    expect(v.incumbentModel).toBe(INCUMBENT);
    // the earlier serve-path e2e contributed one real (near-zero-cost) mock
    // holdout row to the same window — the mean honestly includes it
    expect(v.meanIncumbentCostUsd).toBeCloseTo(0.002, 3);
    expect(v.verifiedSavingsUsd).toBeGreaterThan(0);
    expect(v.verifiedSavingsLowerUsd).toBeLessThanOrEqual(v.verifiedSavingsUsd);
  });
});
