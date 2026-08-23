// Per-kind-of-work floors (routing/floors.ts): a policy carries one floor per
// cluster; applying a proposal MERGES a cluster's floor into the bound policy;
// apply-all merges every open proposal into one policy.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256, strategyHash, type FrontierPoint, type Policy } from '@potion/core';
import { createOrg, getFirstApiKeyWithPolicy, getPolicyById, insertApiKey, insertLearningProposal, insertPolicy } from '@potion/db';
import { saveFrontier } from '@potion/pareto';
import { buildServer } from '../src/server.js';
import { floorFor, policyForCluster, withClusterFloor } from '../src/routing/floors.js';

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
    expect(withClusterFloor(null, 'code-gen', 0.85)).toEqual({ type: 'min_cost', qualityFloor: 0.85, clusterFloors: { 'code-gen': 0.85 } });
    expect(withClusterFloor({ type: 'max_quality', costCeilingPer1K: 1 }, 'x', 0.6)).toEqual({ type: 'min_cost', qualityFloor: 0.6, clusterFloors: { x: 0.6 } });
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
    } as never);

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
