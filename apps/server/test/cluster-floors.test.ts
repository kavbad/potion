// Per-kind-of-work floors (routing/floors.ts): a policy carries one floor per
// cluster; applying a proposal MERGES a cluster's floor into the bound policy;
// apply-all merges every open proposal into one policy.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256, strategyHash, type FrontierPoint, type Policy } from '@potion/core';
import { createOrg, getFirstApiKeyWithPolicy, getPolicyById, insertApiKey, insertLearningProposal, insertPolicy } from '@potion/db';
import { saveFrontier } from '@potion/pareto';
import { buildServer } from '../src/server.js';
import { floorFor, mintFloor, policyForCluster, withClusterFloor } from '../src/routing/floors.js';

const ORG = 'org-floors';
const KEY = 'pk_floors';
const ADMIN = 'pk_floors_admin';
const CHEAP = { type: 'single', model: 'mock-cheap' } as const;
const MID = { type: 'single', model: 'mock-mid' } as const;

function point(clusterId: string, cfg: FrontierPoint['strategyConfig'], quality: number, costPer1K: number): FrontierPoint {
  return { clusterId, strategyHash: strategyHash(cfg), strategyConfig: cfg, quality, costPer1K, latencyP95: 400, providerMode: 'mock' };
}

describe('floors helpers', () => {
  const base: Policy = { type: 'min_cost', qualityFloor: 0.7, clusterFloors: { 'code-gen': 0.9 } };
  it('floorFor and policyForCluster substitute the cluster floor, else the default', () => {
    expect(floorFor(base, 'code-gen')).toBe(0.9);
    expect(floorFor(base, 'classification')).toBe(0.7);
    expect(floorFor({ type: 'max_quality', costCeilingPer1K: 1 }, 'code-gen')).toBeNull();
    expect(policyForCluster(base, 'code-gen')).toMatchObject({ qualityFloor: 0.9 });
    expect(policyForCluster(base, 'classification')).toBe(base);
  });
  it('withClusterFloor merges into min_cost/compound and seeds min_cost otherwise', () => {
    expect(withClusterFloor(base, 'classification', 0.8)).toEqual({ type: 'min_cost', qualityFloor: 0.7, clusterFloors: { 'code-gen': 0.9, classification: 0.8 } });
    // 2026-09-11: a seeded policy carries THIS cluster's floor for THIS
    // cluster only. The top-level floor is the platform default (what a
    // fresh key gets), never the measurement — a classification bar of 1.0
    // once became the global floor and put every other kind of work on the
    // priciest point.
    expect(withClusterFloor(null, 'code-gen', 0.85)).toEqual({ type: 'min_cost', qualityFloor: 0.95, clusterFloors: { 'code-gen': 0.85 } });
    expect(withClusterFloor({ type: 'max_quality', costCeilingPer1K: 1 }, 'x', 0.6)).toEqual({ type: 'min_cost', qualityFloor: 0.95, clusterFloors: { x: 0.6 } });
    expect(floorFor(withClusterFloor(null, 'code-gen', 0.85), 'classification')).toBe(0.95);
  });
  it('mintFloor is the ONE rule: floors to 2dp (never rounds up), clamps to [0, 1]', () => {
    // The production value: a lower bound written raw as a floor.
    expect(mintFloor(0.978543771043771)).toBe(0.97);
    expect(mintFloor(0.855), 'a bar is a promise — never rounded up past the measurement').toBe(0.85);
    expect(mintFloor(0.859)).toBe(0.85);
    expect(mintFloor(1.2)).toBe(1);
    expect(mintFloor(-0.1)).toBe(0);
    expect(mintFloor(Number.NaN)).toBe(0);
  });
});

let app: FastifyInstance;
const db = () => app.potion.db.db;

beforeAll(async () => {
  app = await buildServer({ seed: false });
  await createOrg(db(), { id: ORG, name: 'Floors' });
  await insertPolicy(db(), { id: 'pol-floors', orgId: ORG, name: 'floors', config: { type: 'min_cost', qualityFloor: 0.7, clusterFloors: { 'code-gen': 0.9 } } });
  await insertApiKey(db(), { id: 'key-floors', keyHash: sha256(KEY), name: 'serve', orgId: ORG, policyId: 'pol-floors' });
  await insertApiKey(db(), { id: 'key-floors-admin', keyHash: sha256(ADMIN), name: 'admin', orgId: ORG, policyId: 'pol-floors', scopes: 'serve+admin' });
  for (const c of ['code-gen', 'classification']) {
    await saveFrontier(db(), c, [point(c, CHEAP, 0.8, 0.2), point(c, MID, 0.92, 1.0)], 'manual', 'test-prices');
  }
});
afterAll(async () => {
  await app.close();
});

async function serve(cluster: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${KEY}`, 'x-potion-cluster': cluster },
    payload: { model: 'potion-auto', messages: [{ role: 'user', content: `floors ${cluster}` }] },
  });
  return { status: res.statusCode, model: res.headers['x-potion-model'] };
}

describe('serving under per-cluster floors', () => {
  it('code-gen (floor 0.9) gets mock-mid; classification (default 0.7) gets mock-cheap', async () => {
    expect(await serve('code-gen')).toEqual({ status: 200, model: 'mock-mid' });
    expect(await serve('classification')).toEqual({ status: 200, model: 'mock-cheap' });
  });
});

describe('applying proposals merges floors', () => {
  const proposal = (id: string, clusterId: string, suggestedFloor: number) =>
    insertLearningProposal(db(), {
      id, orgId: ORG, clusterId, suiteId: `learn-${clusterId}`,
      incumbentModel: 'mock-mid', incumbentHash: strategyHash(MID), incumbentQuality: 0.92, incumbentCostPer1K: 1.0,
      servingHash: strategyHash(CHEAP), servingModel: 'mock-cheap', servingQuality: 0.8, servingCostPer1K: 0.2,
      retention: 0.87, suggestedFloor, projectedSaving: 0.8, items: 10, spendUsd: 0.01, status: 'proposed',
    });

  it('one proposal adds its cluster floor and keeps the others', async () => {
    await proposal('lp-f-1', 'classification', 0.82);
    const res = await app.inject({ method: 'POST', url: '/api/learning/proposals/lp-f-1/apply', headers: { authorization: `Bearer ${ADMIN}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ applied: true, qualityFloor: 0.82, clusterFloors: { 'code-gen': 0.9, classification: 0.82 } });
    const k = await getFirstApiKeyWithPolicy(db(), ORG);
    const row = await getPolicyById(db(), ORG, k!.policyId!);
    expect(row?.config).toMatchObject({ type: 'min_cost', qualityFloor: 0.7, clusterFloors: { 'code-gen': 0.9, classification: 0.82 } });
  });
  it('apply-all folds every open proposal into one policy', async () => {
    await proposal('lp-f-2', 'rewrite-edit', 0.77);
    await proposal('lp-f-3', 'creative', 0.66);
    const res = await app.inject({ method: 'POST', url: '/api/learning/proposals/apply-all', headers: { authorization: `Bearer ${ADMIN}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ applied: 2, clusterFloors: { 'code-gen': 0.9, classification: 0.82, 'rewrite-edit': 0.77, creative: 0.66 } });
    const again = await app.inject({ method: 'POST', url: '/api/learning/proposals/apply-all', headers: { authorization: `Bearer ${ADMIN}` } });
    expect(again.statusCode).toBe(409);
  });
});

// 2026-09-11: a proposal may only be applied over the world it measured.
// The 2026-09-08 incident was a proposal applied over a frontier it had
// never seen at prices it had never seen. Frontier version and prices
// version are both recorded on the proposal; apply refuses when either moved.
describe('a stale proposal is refused at apply', () => {
  const proposal = (id: string, over: Partial<{ frontierVersion: number | null; pricesVersion: string | null }>) =>
    insertLearningProposal(db(), {
      id, orgId: ORG, clusterId: 'classification', suiteId: 'learn-classification',
      incumbentModel: 'mock-mid', incumbentHash: strategyHash(MID), incumbentQuality: 0.92, incumbentCostPer1K: 1.0,
      servingHash: strategyHash(CHEAP), servingModel: 'mock-cheap', servingQuality: 0.8, servingCostPer1K: 0.2,
      retention: 0.87, suggestedFloor: 0.8, projectedSaving: 0.8, items: 10, spendUsd: 0.01, status: 'proposed',
      ...over,
    });
  const apply = (id: string) => app.inject({ method: 'POST', url: `/api/learning/proposals/${id}/apply`, headers: { authorization: `Bearer ${ADMIN}` } });

  it('refuses when the frontier it measured against has moved', async () => {
    await proposal('lp-stale-frontier', { frontierVersion: 999 });
    const res = await apply('lp-stale-frontier');
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('proposal_stale');
    expect(res.json().error.message).toMatch(/frontier moved v999/);
  });

  it('refuses when the prices it measured against have moved', async () => {
    await proposal('lp-stale-prices', { pricesVersion: 'prices-from-another-era' });
    const res = await apply('lp-stale-prices');
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/prices moved prices-from-another-era/);
  });

  it('applies when both match what serves now, and apply-all names the stale ones it left', async () => {
    const { loadCurrentFrontier } = await import('@potion/pareto');
    const now = await loadCurrentFrontier(db(), 'classification', ORG);
    expect(now).not.toBeNull();
    await proposal('lp-fresh', { frontierVersion: now!.version, pricesVersion: app.potion.prices.version });
    await proposal('lp-stale-2', { frontierVersion: 998 });
    const all = await app.inject({ method: 'POST', url: '/api/learning/proposals/apply-all', headers: { authorization: `Bearer ${ADMIN}` } });
    expect(all.statusCode).toBe(200);
    const body = all.json();
    expect(body.applied).toBeGreaterThanOrEqual(1);
    expect(body.stale.map((s: { id: string }) => s.id)).toContain('lp-stale-2');
    expect(body.stale.map((s: { id: string }) => s.id)).not.toContain('lp-fresh');
  });
});
