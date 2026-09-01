// SHADOW → ORG EVIDENCE on the router artifact (2026-09-01): GET /api/router
// carries, per assignment, what the shadow plane MEASURED on this org's own
// traffic — serve-judge scores with Jeffreys intervals, measured costs on
// BOTH sides of the compare, and a confidence-gated `qualifies` flag. The
// evidence is display-only: it never mints a router version.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256, strategyHash, type FrontierPoint, type StrategyConfig } from '@potion/core';
import {
  insertApiKey,
  insertPolicy,
  insertQualitySample,
  insertRequestLog,
  insertShadowResult,
} from '@potion/db';
import { saveFrontier } from '@potion/pareto';
import { buildServer } from '../src/server.js';

const ORG = 'org-shadow-ev';
const KEY = 'pk_shadow_ev';
const CHEAP = { type: 'single', model: 'mock-cheap' } as const;
const MID = { type: 'single', model: 'mock-mid' } as const;
const H_CHEAP = strategyHash(CHEAP);
const H_MID = strategyHash(MID);
const H_RARE = 'a'.repeat(64); // a candidate with too few scored samples

function point(cfg: StrategyConfig, quality: number, costPer1K: number): FrontierPoint {
  return { clusterId: 'code-gen', strategyHash: strategyHash(cfg), strategyConfig: cfg, quality, costPer1K, latencyP95: 400, providerMode: 'mock' };
}

let app: FastifyInstance;
const db = () => app.potion.db.db;

beforeAll(async () => {
  app = await buildServer({ seed: false });
  const { createOrg } = await import('@potion/db');
  await createOrg(db(), { id: ORG, name: 'ShadowEv' });
  // floor 0.7 → mock-cheap (0.8) serves as the cheapest point above it.
  await insertPolicy(db(), { id: 'pol-shadow-ev', orgId: ORG, name: 'shadow-ev', config: { type: 'min_cost', qualityFloor: 0.7 } });
  await insertApiKey(db(), { id: 'key-shadow-ev', keyHash: sha256(KEY), name: 'serve', orgId: ORG, policyId: 'pol-shadow-ev', scopes: 'serve+admin' });
  await saveFrontier(db(), 'code-gen', [point(CHEAP, 0.8, 0.2), point(MID, 0.92, 1.0)], 'manual', 'test-prices');

  // Measured serving cost: 10 served requests at $0.001 each → $1.0/1K.
  for (let i = 0; i < 10; i += 1) {
    await insertRequestLog(db(), {
      orgId: ORG, clusterId: 'code-gen', strategyHash: H_CHEAP, model: 'mock-cheap',
      status: 'ok', usage: { costUsd: 0.001 }, latencyMs: 300,
    } as never);
  }
  // The serving strategy's own serve-judge scores (quality_samples).
  for (let i = 0; i < 5; i += 1) {
    await insertQualitySample(db(), {
      orgId: ORG, requestId: `chatcmpl-ev-${i}`, strategyHash: H_CHEAP, clusterId: 'code-gen',
      policyId: 'pol-shadow-ev', quality: 0.8, scorer: 'llm-judge:mock-judge', judgeModel: 'mock-judge', judgeCostUsd: 0,
    } as never);
  }
  // Challenger mock-mid: 35 scored shadow rows, high quality, $0.1/1K.
  for (let i = 0; i < 35; i += 1) {
    await insertShadowResult(db(), {
      orgId: ORG, requestId: `chatcmpl-sh-${i}`, clusterId: 'code-gen',
      primaryHash: H_CHEAP, candidateHash: H_MID, candidateModel: 'mock-mid',
      quality: 0.95, costUsd: 0.0001, latencyMs: 500,
    });
  }
  // A thinly-evidenced candidate: 3 scored rows only.
  for (let i = 0; i < 3; i += 1) {
    await insertShadowResult(db(), {
      orgId: ORG, requestId: `chatcmpl-shr-${i}`, clusterId: 'code-gen',
      primaryHash: H_CHEAP, candidateHash: H_RARE, candidateModel: 'rare-model',
      quality: 0.99, costUsd: 0.00005, latencyMs: 200,
    });
  }
});
afterAll(async () => {
  await app.close();
});

async function getRouter() {
  const res = await app.inject({ method: 'GET', url: '/api/router', headers: { authorization: `Bearer ${KEY}` } });
  expect(res.statusCode).toBe(200);
  return res.json() as {
    version: number;
    document: { assignments: Array<{ clusterId: string; shadow?: { instrument: string; servingObserved: { n: number; quality: number } | null; servingMeasuredCostPer1K: number | null; challengers: Array<{ strategyHash: string; model: string; n: number; qualityCi: [number, number]; costPer1K: number; qualifies: boolean; reason: string }> } }> };
  };
}

describe('router artifact carries shadow evidence', () => {
  it('the assignment shows serve-judge evidence: serving observed, measured costs, gated challengers', async () => {
    const body = await getRouter();
    const a = body.document.assignments.find((x) => x.clusterId === 'code-gen')!;
    expect(a.shadow).toBeDefined();
    expect(a.shadow!.instrument).toBe('serve-judge');
    expect(a.shadow!.servingObserved).toMatchObject({ n: 5 });
    expect(a.shadow!.servingMeasuredCostPer1K).toBeCloseTo(1.0, 6);

    const mid = a.shadow!.challengers.find((c) => c.strategyHash === H_MID)!;
    expect(mid.model).toBe('mock-mid');
    expect(mid.n).toBe(35);
    expect(mid.costPer1K).toBeCloseTo(0.1, 6);
    expect(mid.qualityCi[0]).toBeGreaterThanOrEqual(0.7); // lower bound clears the floor…
    expect(mid.qualifies).toBe(true); // …cheaper on measured actuals → qualifies
    expect(mid.reason).toContain('of your requests');

    const rare = a.shadow!.challengers.find((c) => c.strategyHash === H_RARE)!;
    expect(rare.qualifies).toBe(false);
    expect(rare.reason).toBe('3 of 30 scored samples');
    // qualified sorts first
    expect(a.shadow!.challengers[0]!.strategyHash).toBe(H_MID);
  });

  it('evidence never mints a version: more shadow rows, same routerHash/version', async () => {
    const before = await getRouter();
    await insertShadowResult(db(), {
      orgId: ORG, requestId: 'chatcmpl-sh-extra', clusterId: 'code-gen',
      primaryHash: H_CHEAP, candidateHash: H_MID, candidateModel: 'mock-mid',
      quality: 0.5, costUsd: 0.0001, latencyMs: 500,
    });
    const after = await getRouter();
    expect(after.version).toBe(before.version);
  });

  it('an org with no shadow window carries no block — absent, never zeros', async () => {
    const { createOrg } = await import('@potion/db');
    await createOrg(db(), { id: 'org-shadow-empty', name: 'Empty' });
    await insertPolicy(db(), { id: 'pol-shadow-empty', orgId: 'org-shadow-empty', name: 'e', config: { type: 'min_cost', qualityFloor: 0.7 } });
    await insertApiKey(db(), { id: 'key-shadow-empty', keyHash: sha256('pk_shadow_empty'), name: 'e', orgId: 'org-shadow-empty', policyId: 'pol-shadow-empty', scopes: 'serve+admin' });
    const res = await app.inject({ method: 'GET', url: '/api/router', headers: { authorization: 'Bearer pk_shadow_empty' } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { document: { assignments: Array<{ clusterId: string; shadow?: unknown }> } };
    for (const a of body.document.assignments) expect(a.shadow).toBeUndefined();
  });
});
