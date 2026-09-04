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
  getOrgIncumbents,
  insertApiKey,
  insertPolicy,
  insertRequestLog,
  listRequestLogs,
  setHoldoutConfig,
  upsertOrgIncumbents,
} from '@potion/db';
import { saveFrontier } from '@potion/pareto';
import { buildServer } from '../src/server.js';
import { HOLDOUT_MAX_RATE, bustHoldoutCache, eligibleIncumbent, resolveHoldout } from '../src/routing/holdout.js';
import { compileAndMintRouter } from '../src/routing/compile-router.js';
import { MIN_HOLDOUT_REQUESTS, buildVerifiedSavings } from '../src/routes/reports.js';

const ORG = 'org-holdout';
const KEY = 'pk_holdout';
const CHEAP = { type: 'single', model: 'mock-cheap' } as const; // the router's pick
const INCUMBENT = 'mock-frontier';

function point(cfg: StrategyConfig, quality: number, costPer1K: number, clusterId = 'classification'): FrontierPoint {
  return { clusterId, strategyHash: strategyHash(cfg), strategyConfig: cfg, quality, costPer1K, latencyP95: 300, providerMode: 'mock' };
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

// ── COVERAGE (2026-09-04, mutation audit) ────────────────────────────────
// The rate cap above is DEFENCE IN DEPTH: the PUT route rejects a rate over
// the cap, but a rate that reached org_incumbents another way — a direct
// write, a migration, a route that predates the cap — must still not widen
// the slice. Replacing `Math.min(cfg.rate, HOLDOUT_MAX_RATE)` with plain
// `cfg.rate` passed every test in this file until this one; it is asserted
// on resolveHoldout directly (its `rand` seam) so the draw is exact rather
// than a probability.
const OVER_RATE_ORG = 'org-holdout-overrate';
const OVER_RATE = 0.9; // what the route would 400

describe('the rate cap (a stored rate the route would never have written)', () => {
  beforeAll(async () => {
    await createOrg(db(), { id: OVER_RATE_ORG, name: 'Over Rate' });
    await upsertOrgIncumbents(db(), { orgId: OVER_RATE_ORG, models: [INCUMBENT], other: null, samplingConsent: false });
    await setHoldoutConfig(db(), OVER_RATE_ORG, { consent: true, rate: OVER_RATE });
    bustHoldoutCache(OVER_RATE_ORG);
  });

  it('the seeded rate really is above the cap — the repo does not clamp it', async () => {
    const inc = await getOrgIncumbents(db(), OVER_RATE_ORG);
    expect(inc?.holdoutRate).toBe(OVER_RATE);
    expect(inc!.holdoutRate).toBeGreaterThan(HOLDOUT_MAX_RATE);
  });

  it('a draw between the cap and the stored rate does NOT fire — the cap, not the rate, decides', async () => {
    const opts = { pinned: false, instrument: 'default' };
    // Below the cap the slice still fires, so the fixture is live and the
    // nulls below are the cap refusing, not the org being ineligible.
    expect(await resolveHoldout(app.potion, OVER_RATE_ORG, { ...opts, rand: () => HOLDOUT_MAX_RATE / 2 })).toEqual({
      model: INCUMBENT,
    });
    // Between the cap and the stored rate: ONLY the Math.min can refuse these.
    expect(await resolveHoldout(app.potion, OVER_RATE_ORG, { ...opts, rand: () => HOLDOUT_MAX_RATE })).toBeNull();
    expect(await resolveHoldout(app.potion, OVER_RATE_ORG, { ...opts, rand: () => 0.5 })).toBeNull();
    expect(await resolveHoldout(app.potion, OVER_RATE_ORG, { ...opts, rand: () => OVER_RATE - 0.01 })).toBeNull();
    // And above the stored rate, as it never fired.
    expect(await resolveHoldout(app.potion, OVER_RATE_ORG, { ...opts, rand: () => 0.99 })).toBeNull();
  });
});

// ── COVERAGE (2026-09-04, mutation audit) ────────────────────────────────
// The two serve-path guards — `heldOut !== null ? null : baselineFor(...)`
// and `heldOut !== null ? null : stampedRouterVersion(...)` — were asserted
// above on a fixture where BOTH fields were null for other reasons: the
// incumbent was not on the frontier (so baselineCostUsd bailed at its own
// `chosen` lookup) and the org had never minted a router version. Deleting
// either guard shipped green.
//
// This org is the state that makes each guard load-bearing, and it is
// reachable in production: eligibleIncumbent does not exclude an incumbent
// that is ALSO a measured Pareto point, so the org's named model can be the
// very point the policy picks. A holdout row there would otherwise claim
// savings against itself — inflating usage_daily.baselineCostUsd and the
// invoice — and be attributed to a router that did not decide it.
const ON_FRONTIER_ORG = 'org-holdout-onfrontier';
const ON_FRONTIER_KEY = 'pk_holdout_onfrontier';
const ON_FRONTIER_CLUSTER = 'summarization';
const INCUMBENT_HASH = strategyHash({ type: 'single', model: INCUMBENT });

describe('the serve-path guards, on a fixture where each is load-bearing', () => {
  let mintedVersion = 0;

  const serveOnFrontier = () =>
    app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${ON_FRONTIER_KEY}`, 'x-potion-cluster': ON_FRONTIER_CLUSTER },
      payload: { model: 'potion-auto', messages: [{ role: 'user', content: 'summarize the quarterly report' }] },
    });

  const rowFor = async (res: { json: () => { id: string } }) =>
    (await listRequestLogs(db(), ON_FRONTIER_ORG, 5)).find((r) => r.completionId === res.json().id)!;

  beforeAll(async () => {
    await createOrg(db(), { id: ON_FRONTIER_ORG, name: 'Holdout OnFrontier' });
    // Floor 0.9 admits both points, so min_cost picks the CHEAPER of them —
    // which is the org's own named incumbent. The router's pick and the
    // holdout's swap are then the same strategy on the same frontier.
    await insertPolicy(db(), { id: 'pol-holdout-of', orgId: ON_FRONTIER_ORG, name: 'h-of', config: { type: 'min_cost', qualityFloor: 0.9 } });
    await insertApiKey(db(), { id: 'key-holdout-of', keyHash: sha256(ON_FRONTIER_KEY), name: 'serve', orgId: ON_FRONTIER_ORG, policyId: 'pol-holdout-of', scopes: 'serve+admin' });
    await saveFrontier(
      db(),
      ON_FRONTIER_CLUSTER,
      [
        point({ type: 'single', model: INCUMBENT }, 0.92, 0.5, ON_FRONTIER_CLUSTER), // the incumbent IS a measured point
        point({ type: 'single', model: 'mock-mid' }, 0.99, 5, ON_FRONTIER_CLUSTER), // the best-of-frontier fallback
      ],
      'manual',
      'test-prices',
    );
    await upsertOrgIncumbents(db(), { orgId: ON_FRONTIER_ORG, models: [INCUMBENT], other: null, samplingConsent: false });
    const minted = await compileAndMintRouter(app.potion, db(), ON_FRONTIER_ORG, () => {});
    mintedVersion = minted.version;
    // The minted assignment IS the strategy a holdout on this org serves —
    // without this, stampedRouterVersion would return null on its own and the
    // router-version guard below would pass for a reason that is not itself.
    const assignment = minted.document.assignments.find((a) => a.clusterId === ON_FRONTIER_CLUSTER);
    expect(assignment?.strategyHash).toBe(INCUMBENT_HASH);
  });

  it('CONTROL — consent off: the same request DOES record an incumbent baseline and the minted router version', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.0001); // would land in the slice if consent were on
    const res = await serveOnFrontier();
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['x-potion-model']).toBe(INCUMBENT); // the router's own pick, not a swap
    const row = await rowFor(res);
    expect(row.holdout).toBe(false);
    expect(row.strategyHash).toBe(INCUMBENT_HASH);
    // Both guarded fields are live on this fixture — so what the holdout row
    // below lacks, it lacks because of the guards and nothing else.
    expect(row.baselineCostUsd).not.toBeNull();
    expect(row.baselineBasis).toBe('org-incumbent');
    expect(row.routerVersion).toBe(mintedVersion);
    expect(String(res.headers['x-frontier-trace'])).toContain(`router=v${mintedVersion}`);
  });

  it('a holdout on that SAME state is never compared against the incumbent, and carries no router version', async () => {
    await setHoldoutConfig(db(), ON_FRONTIER_ORG, { consent: true, rate: HOLDOUT_MAX_RATE });
    bustHoldoutCache(ON_FRONTIER_ORG);
    vi.spyOn(Math, 'random').mockReturnValue(0.0001);
    const res = await serveOnFrontier();
    expect(res.statusCode, res.body).toBe(200);
    const row = await rowFor(res);
    expect(row.holdout).toBe(true);
    expect(row.servedModel).toBe(INCUMBENT);
    expect(row.strategyHash).toBe(INCUMBENT_HASH); // the same point the mint recorded
    // GUARD 2 (`heldOut !== null ? null : await baselineFor(...)`): a baseline
    // request never claims savings against the org's own incumbent — which,
    // here, is the very request being served. Drop the guard and this row is
    // stamped 'org-incumbent'.
    expect(row.baselineBasis).not.toBe('org-incumbent');
    expect(row.baselineBasis).not.toBe('cluster-incumbent');
    // FIXED 2026-09-04, and this fixture is what found it. Nulling the
    // incumbent designation was not enough: baselineCostUsd read the null
    // hash as "none named" and fell through to its silent best-of-frontier
    // fallback, so this row recorded a baseline against mock-mid — 10× the
    // incumbent's measured cost — for the very request that IS the
    // comparator. It was invisible everywhere else in this file because the
    // incumbent sits off-frontier there and baselineCostUsd bails at its own
    // `chosen` lookup. The rollup sums baseline_cost_usd with no holdout
    // filter, so the number reached the invoice's projected savings.
    // schema.ts's promise, now kept: such rows carry baseline NULL.
    expect(row.baselineCostUsd).toBeNull();
    expect(row.baselineBasis).toBeNull();
    // GUARD 3 (`heldOut !== null ? null : await stampedRouterVersion(...)`):
    // the coin decided this request, not the router — even though the minted
    // artifact does contain exactly this assignment.
    expect(row.routerVersion).toBeNull();
    expect(String(res.headers['x-frontier-trace'])).toContain('holdout=1');
    expect(String(res.headers['x-frontier-trace'])).not.toContain('router=v');
  });
});
