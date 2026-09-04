// G1 challenger promotion, end to end in the mock world:
//   shadow-qualified challenger → measured beside serving on the org's own
//   derived suite (learning period) → challenger_proposals row → one-button
//   apply → ORG frontier minted from the same measurements → routing reads
//   the measured field. Plus the tenancy pins: cross-org id → uniform 404;
//   re-apply → 409.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256, strategyHash, type FrontierPoint, type StrategyConfig } from '@potion/core';
import {
  insertApiKey,
  insertPolicy,
  insertRequestLog,
  insertShadowResult,
  insertTraceSpans,
  listChallengerProposals,
  upsertOrgIncumbents,
} from '@potion/db';
import { loadCurrentFrontier, saveFrontier } from '@potion/pareto';
import { LEARNING_SPAN_NAME, runLearningPeriodForOrg } from '@potion/workers';
import { buildServer } from '../src/server.js';
// R3: cross-tenant suites use TWO DISTINCT NON-DEFAULT orgs from the shared
// fixture — the demo org must never be the probed subject (fixture header;
// that assumption is what hid tenancy defect D1).
import { ORG_A, ORG_B, seedIsolationOrgs } from './fixtures/orgs.js';

const ORG = ORG_A;
const KEY = 'pk_challenger';
const KEY_B = 'pk_challenger_b';
const CHEAP = { type: 'single', model: 'mock-cheap' } as const; // serving
const MID = { type: 'single', model: 'mock-mid' } as const; // challenger
const H_CHEAP = strategyHash(CHEAP);
const H_MID = strategyHash(MID);

function point(cfg: StrategyConfig, quality: number, costPer1K: number): FrontierPoint {
  return { clusterId: 'classification', strategyHash: strategyHash(cfg), strategyConfig: cfg, quality, costPer1K, latencyP95: 300, providerMode: 'mock' };
}

let app: FastifyInstance;
const db = () => app.potion.db.db;

async function seedOrg(orgId: string, key: string): Promise<void> {
  await insertPolicy(db(), { id: `pol-ch-${orgId}`, orgId, name: orgId, config: { type: 'min_cost', qualityFloor: 0.7 } });
  await insertApiKey(db(), { id: `key-ch-${orgId}`, keyHash: sha256(key), name: 'serve', orgId, policyId: `pol-ch-${orgId}`, scopes: 'serve+admin' });
}

beforeAll(async () => {
  app = await buildServer({ seed: false });
  await seedIsolationOrgs(db());
  await seedOrg(ORG, KEY);
  await seedOrg(ORG_B, KEY_B);
  // Platform frontier: cheap serves under the 0.7 floor; mid is the shadow
  // challenger.
  await saveFrontier(db(), 'classification', [point(CHEAP, 0.8, 0.2), point(MID, 0.92, 1.0)], 'manual', 'test-prices');
  // Learning inputs: consent + a priced incumbent + ≥8 sampled requests.
  await upsertOrgIncumbents(db(), { orgId: ORG, models: ['mock-frontier'], other: null, samplingConsent: true });
  await insertTraceSpans(
    db(),
    Array.from({ length: 10 }, (_, i) => ({
      orgId: ORG, traceId: `learn-ch${i}`, spanId: 'chat', parentId: null, name: LEARNING_SPAN_NAME, model: 'mock-cheap', usage: {}, costUsd: 0,
      attrs: {
        'gen_ai.operation.name': 'chat',
        'potion.messages': [{ role: 'user', content: `Is ticket ${i} urgent or routine?` }],
        'gen_ai.completion': 'routine',
        'potion.cluster_id': 'classification',
        'potion.tool_count': 0,
      },
      ts: new Date(),
    })),
  );
  // Shadow evidence that QUALIFIES mock-mid: 35 scored rows, high quality,
  // $0.1/1K measured — against serving's measured $1.0/1K.
  for (let i = 0; i < 35; i += 1) {
    await insertShadowResult(db(), {
      orgId: ORG, requestId: `chatcmpl-ch${i}`, clusterId: 'classification',
      primaryHash: H_CHEAP, candidateHash: H_MID, candidateModel: 'mock-mid',
      quality: 0.95, costUsd: 0.0001, latencyMs: 400,
    });
  }
  for (let i = 0; i < 10; i += 1) {
    await insertRequestLog(db(), {
      orgId: ORG, clusterId: 'classification', strategyHash: H_CHEAP, model: 'mock-cheap',
      status: 'ok', usage: { inputTokens: 120, outputTokens: 60, costUsd: 0.001, latencyMs: 300 }, latencyMs: 300,
    });
  }
}, 90_000);
afterAll(async () => {
  await app.close();
});

describe('challenger promotion, end to end', () => {
  it('the learning period measures the qualified challenger beside serving and mints a proposal', async () => {
    const report = await runLearningPeriodForOrg(
      { db: db(), dbHandle: app.potion.db, pricesPath: app.potion.pricesPath },
      ORG,
    );
    expect(report.outcome, JSON.stringify(report.skipped)).toBe('ran');
    expect(report.challengers, JSON.stringify(report.skipped)).toHaveLength(1);
    expect(report.challengers[0]).toMatchObject({ clusterId: 'classification', challengerModel: 'mock-mid' });
    const rows = await listChallengerProposals(db(), ORG);
    expect(rows).toHaveLength(1);
    const p = rows[0]!;
    expect(p.status).toBe('proposed');
    expect(p.challengerHash).toBe(H_MID);
    expect(p.servingHash).toBe(H_CHEAP);
    const retention = p.retention as { ci95: [number, number]; floor: number };
    expect(retention.ci95[0]).toBeGreaterThanOrEqual(retention.floor); // the gate that minted it
    const shadow = p.shadow as { n: number; costPer1K: number; servingMeasuredCostPer1K: number };
    expect(shadow.n).toBe(35);
    expect(shadow.costPer1K).toBeCloseTo(0.1, 6);
    expect(shadow.servingMeasuredCostPer1K).toBeCloseTo(1.0, 6);
  });

  it('GET /api/challengers lists it', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/challengers', headers: { authorization: `Bearer ${KEY}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { proposals: Array<{ challengerModel: string; status: string }> };
    expect(body.proposals[0]).toMatchObject({ challengerModel: 'mock-mid', status: 'proposed' });
  });

  it("cross-org apply is a uniform 404 — one org can never promote into another's routing", async () => {
    const id = (await listChallengerProposals(db(), ORG))[0]!.id;
    const res = await app.inject({ method: 'POST', url: `/api/challengers/${id}/apply`, headers: { authorization: `Bearer ${KEY_B}` } });
    expect(res.statusCode).toBe(404);
  });

  it('apply mints the ORG frontier from the same-suite measurements; routing reads the measured field', async () => {
    const id = (await listChallengerProposals(db(), ORG))[0]!.id;
    const before = await loadCurrentFrontier(db(), 'classification', ORG);
    expect(before?.orgId ?? null).toBeNull(); // platform frontier until now
    const res = await app.inject({ method: 'POST', url: `/api/challengers/${id}/apply`, headers: { authorization: `Bearer ${KEY}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { applied: boolean; frontierVersion: number; points: number; nowServes: { model: string; fallback: number } | null };
    expect(body.applied).toBe(true);
    expect(body.points).toBeGreaterThanOrEqual(1);
    expect(body.nowServes).not.toBeNull(); // the honest readback: what production does next
    const after = await loadCurrentFrontier(db(), 'classification', ORG);
    expect(after?.orgId).toBe(ORG); // serving now reads the org's own measured field
    expect((await listChallengerProposals(db(), ORG))[0]!.status).toBe('applied');
    // org B's routing is untouched
    const b = await loadCurrentFrontier(db(), 'classification', ORG_B);
    expect(b?.orgId ?? null).toBeNull();
  });

  it('re-apply is a 409 — the transition is one-way', async () => {
    const id = (await listChallengerProposals(db(), ORG))[0]!.id;
    const res = await app.inject({ method: 'POST', url: `/api/challengers/${id}/apply`, headers: { authorization: `Bearer ${KEY}` } });
    expect(res.statusCode).toBe(409);
  });
});
