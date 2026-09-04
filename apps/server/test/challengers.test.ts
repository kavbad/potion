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
  insertChallengerProposal,
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

  // THE TWO-ORG LIST PIN (mutation audit, 2026-09-04). Every assertion above
  // reads ONE org, so `eq(challengerProposals.orgId, orgId)` could be deleted
  // from listChallengerProposals — making one org's list return EVERY org's
  // proposals — with all 1012 server tests still green. A second org that
  // owns a proposal of its own is what makes the filter observable; the
  // assertion is on the EXACT id set, because a list returning everybody's
  // rows still "contains" the caller's.
  it("GET /api/challengers returns ONLY the calling org's proposals", async () => {
    // ORG_A's true set, captured BEFORE ORG_B owns anything — so it is the
    // right answer even if the repo under test is the thing that is broken.
    const mine = (await listChallengerProposals(db(), ORG)).map((p) => p.id);
    expect(mine.length, 'the pin is vacuous unless ORG_A owns a proposal').toBeGreaterThan(0);

    const B_ID = 'cp-orgb-isolation';
    await insertChallengerProposal(db(), {
      id: B_ID, orgId: ORG_B, clusterId: 'classification', suiteId: 'classification-replays-v1',
      servingHash: H_CHEAP, servingModel: 'mock-cheap', servingQuality: 0.8,
      challengerHash: H_MID, challengerModel: 'mock-mid', challengerQuality: 0.93,
      retention: { mean: 0.98, ci95: [0.95, 1], floor: 0.7 }, shadow: { n: 35, costPer1K: 0.1 }, items: 35,
    });

    // the repo itself — the org filter, not the route's rendering
    expect((await listChallengerProposals(db(), ORG)).map((p) => p.id)).toEqual(mine);
    expect((await listChallengerProposals(db(), ORG_B)).map((p) => p.id)).toEqual([B_ID]);

    // and over HTTP, under each org's own credential
    const a = await app.inject({ method: 'GET', url: '/api/challengers', headers: { authorization: `Bearer ${KEY}` } });
    expect(a.statusCode).toBe(200);
    const aIds = (a.json() as { proposals: Array<{ id: string }> }).proposals.map((p) => p.id);
    expect(aIds, "ORG_A's list carried a foreign proposal").toEqual(mine);
    expect(a.body).not.toContain(B_ID);
    expect(a.body).not.toContain(ORG_B);

    const b = await app.inject({ method: 'GET', url: '/api/challengers', headers: { authorization: `Bearer ${KEY_B}` } });
    expect(b.statusCode).toBe(200);
    const bIds = (b.json() as { proposals: Array<{ id: string }> }).proposals.map((p) => p.id);
    expect(bIds, "ORG_B's list carried a foreign proposal").toEqual([B_ID]);
    for (const id of mine) expect(b.body).not.toContain(id);
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
