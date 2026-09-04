// The savings baseline is the org's designated or named incumbent when it is
// a point on the served frontier (routing/baseline.ts) — not always the
// frontier's best point.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { desc } from 'drizzle-orm';
import { sha256, strategyHash, type Frontier, type FrontierPoint } from '@potion/core';
import { createOrg, designateIncumbent, insertApiKey, insertPolicy, requestLogs, upsertOrgIncumbents, upsertStrategyConfig } from '@potion/db';
import { saveFrontier } from '@potion/pareto';
import { buildServer } from '../src/server.js';
import { baselineCostUsd } from '../src/routes/chat.js';
import { baselineFor, clearBaselineCache } from '../src/routing/baseline.js';

const ORG = 'org-baseline';
const KEY = 'pk_baseline';
const CHEAP = { type: 'single', model: 'mock-cheap' } as const;
const MID = { type: 'single', model: 'mock-mid' } as const;
const TOP = { type: 'single', model: 'mock-frontier' } as const;
const H = (c: FrontierPoint['strategyConfig']) => strategyHash(c);

function point(cfg: FrontierPoint['strategyConfig'], quality: number, costPer1K: number): FrontierPoint {
  return { clusterId: 'code-gen', strategyHash: H(cfg), strategyConfig: cfg, quality, costPer1K, latencyP95: 400, providerMode: 'mock' };
}
const POINTS = [point(CHEAP, 0.8, 0.2), point(MID, 0.9, 1.0), point(TOP, 0.95, 4.0)];
const FRONTIER: Frontier = {
  id: 'fr-baseline',
  clusterId: 'code-gen',
  version: 1,
  parentId: null,
  trigger: 'manual',
  points: POINTS,
  pricesVersion: 'test-prices',
  createdAt: '2026-08-28T00:00:00Z',
};

describe('baselineCostUsd', () => {
  it('scales to the best point by default and to the named baseline when given', () => {
    expect(baselineCostUsd(FRONTIER, H(CHEAP), 0.01)).toBeCloseTo(0.2, 6); // 0.01 × 4.0/0.2
    expect(baselineCostUsd(FRONTIER, H(CHEAP), 0.01, H(MID))).toBeCloseTo(0.05, 6); // 0.01 × 1.0/0.2
    expect(baselineCostUsd(FRONTIER, H(CHEAP), 0.01, 'not-on-frontier')).toBeCloseTo(0.2, 6);
  });
});

let app: FastifyInstance;
const db = () => app.potion.db.db;

beforeAll(async () => {
  app = await buildServer({ seed: false });
  await createOrg(db(), { id: ORG, name: 'Baseline' });
  await insertPolicy(db(), { id: 'pol-baseline', orgId: ORG, name: 'floor-0.7', config: { type: 'min_cost', qualityFloor: 0.7 } });
  await insertApiKey(db(), { id: 'key-baseline', keyHash: sha256(KEY), name: 'serve', orgId: ORG, policyId: 'pol-baseline' });
  await saveFrontier(db(), 'code-gen', POINTS, 'manual', 'test-prices');
});
afterAll(async () => {
  await app.close();
});

async function serve(prompt: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${KEY}`, 'x-potion-cluster': 'code-gen' },
    payload: { model: 'potion-auto', messages: [{ role: 'user', content: prompt }] },
  });
  const [row] = await db().select().from(requestLogs).orderBy(desc(requestLogs.id)).limit(1);
  return { status: res.statusCode, model: res.headers['x-potion-model'], cost: row?.usage?.costUsd ?? null, baseline: row?.baselineCostUsd ?? null, basis: row?.baselineBasis ?? null };
}

/**
 * THE RATIO, ASSERTED WHERE IT IS OBSERVABLE.
 *
 * The e2e rows below cannot carry a ratio: every mock alias is priced at
 * $0/1M by design, so a served request records costUsd 0 and therefore
 * baselineCostUsd 0. `expect(0).toBeCloseTo(0 * ratio)` holds for EVERY
 * ratio — which is what the three assertions here used to be, identical in
 * effect and unable to tell 4.0/0.2 from 1.0/0.2.
 *
 * What the row genuinely proves is the SELECTION (`basis`, plus the
 * `baselineFor` result each test already pins). The scaling is proved by
 * running the serve path's own `baselineCostUsd` over the hash that
 * selection produced, at a cost where the arithmetic is visible. Change the
 * selection and this moves; that is the property the old line claimed.
 */
function expectScaling(selected: string | null, ratio: number): void {
  const servedCostUsd = 0.01; // any nonzero cost makes the ratio observable
  expect(baselineCostUsd(FRONTIER, H(CHEAP), servedCostUsd, selected)).toBeCloseTo(
    servedCostUsd * ratio,
    9,
  );
}

describe('the baseline on a served request', () => {
  it('is the best point when nothing is named', async () => {
    clearBaselineCache();
    expect(await baselineFor(db(), ORG, 'code-gen', FRONTIER)).toBeNull();
    const r = await serve('write a function that reverses a list — baseline none');
    expect(r.status).toBe(200);
    expect(r.model).toBe('mock-cheap');
    expect(r.basis).toBe('best-of-frontier'); // 0089: the silent fallback is now distinguishable on the row
    expectScaling(null, 4.0 / 0.2); // no named baseline → the frontier's best point
  });
  it('is the org’s named model from onboarding when it sits on the frontier', async () => {
    await upsertOrgIncumbents(db(), { orgId: ORG, models: ['mock-mid'], other: null, samplingConsent: false });
    clearBaselineCache();
    expect(await baselineFor(db(), ORG, 'code-gen', FRONTIER)).toEqual({ hash: H(MID), basis: 'org-incumbent' });
    const r = await serve('write a function that reverses a list — baseline org');
    expect(r.basis).toBe('org-incumbent');
    expectScaling(H(MID), 1.0 / 0.2); // the named model's point, not the best one
  });
  it('the cluster designation outranks the org’s named model', async () => {
    await upsertStrategyConfig(db(), H(TOP), TOP);
    await designateIncumbent(db(), ORG, 'code-gen', H(TOP));
    clearBaselineCache();
    expect(await baselineFor(db(), ORG, 'code-gen', FRONTIER)).toEqual({ hash: H(TOP), basis: 'cluster-incumbent' });
    const r = await serve('write a function that reverses a list — baseline cluster');
    expect(r.basis).toBe('cluster-incumbent');
    expectScaling(H(TOP), 4.0 / 0.2); // the designated point — same ratio as best here, but a different hash
  });
});
