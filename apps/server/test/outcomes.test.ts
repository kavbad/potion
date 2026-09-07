// G1 Outcome API (SPEC §16): POST /v1/outcomes — ground truth from the
// customer's own application, attached AT INGEST to the served request.
//   · happy path: signal lands, attribution copied from the served row
//   · append-only: a later signal is a new row, never an edit
//   · unknown request_id → 404 (an outcome must attach to a served request)
//   · org isolation: one org can never annotate another's traffic
//   · STRICT body: unknown fields 400 (never silently stripped — §27)
//   · the router artifact carries the "your app's verdicts" block
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256, strategyHash, type FrontierPoint, type StrategyConfig } from '@potion/core';
import { createOrg, insertApiKey, insertPolicy, listOutcomesSince } from '@potion/db';
import { saveFrontier } from '@potion/pareto';
import { buildServer } from '../src/server.js';

const ORG_A = 'org-outcomes-a';
const ORG_B = 'org-outcomes-b';
const KEY_A = 'pk_outcomes_a';
const KEY_B = 'pk_outcomes_b';
const CHEAP = { type: 'single', model: 'mock-cheap' } as const;
const H_CHEAP = strategyHash(CHEAP);

function point(cfg: StrategyConfig, quality: number, costPer1K: number): FrontierPoint {
  return { clusterId: 'classification', strategyHash: strategyHash(cfg), strategyConfig: cfg, quality, costPer1K, latencyP95: 300, providerMode: 'mock' };
}

let app: FastifyInstance;
const db = () => app.potion.db.db;

async function seedOrg(orgId: string, key: string): Promise<void> {
  await createOrg(db(), { id: orgId, name: orgId });
  await insertPolicy(db(), { id: `pol-${orgId}`, orgId, name: orgId, config: { type: 'min_cost', qualityFloor: 0.7 } });
  await insertApiKey(db(), { id: `key-${orgId}`, keyHash: sha256(key), name: 'serve', orgId, policyId: `pol-${orgId}`, scopes: 'serve+admin' });
}

async function serve(key: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${key}`, 'x-potion-cluster': 'classification' },
    payload: { model: 'potion-auto', messages: [{ role: 'user', content: 'Is this ticket urgent or routine?' }] },
  });
  expect(res.statusCode).toBe(200);
  return res.json().id as string;
}

async function report(key: string, body: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/v1/outcomes',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    payload: body,
  });
}

beforeAll(async () => {
  app = await buildServer({ seed: false });
  await seedOrg(ORG_A, KEY_A);
  await seedOrg(ORG_B, KEY_B);
  await saveFrontier(db(), 'classification', [point(CHEAP, 0.8, 0.2)], 'manual', 'test-prices');
});
afterAll(async () => {
  await app.close();
});

describe('POST /v1/outcomes', () => {
  it('attaches a signal to the served request — attribution copied at ingest', async () => {
    const id = await serve(KEY_A);
    const res = await report(KEY_A, { request_id: id, success: true, validator: 'tests_passed' });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; request_id: string; attached: { cluster: string; strategy: string; router_version: number | null } };
    expect(body.request_id).toBe(id);
    expect(body.attached.cluster).toBe('classification');
    expect(body.attached.strategy).toBe(H_CHEAP.slice(0, 8));
    const rows = (await listOutcomesSince(db(), ORG_A, new Date(Date.now() - 3600_000))).filter((r) => r.requestId === id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.strategyHash).toBe(H_CHEAP);
    expect(rows[0]!.success).toBe(true);
    expect(rows[0]!.validator).toBe('tests_passed');
  });

  it('append-only: a later human signal is a second row on the same request', async () => {
    const id = await serve(KEY_A);
    expect((await report(KEY_A, { request_id: id, success: true })).statusCode).toBe(201);
    expect((await report(KEY_A, { request_id: id, human: 'edited' })).statusCode).toBe(201);
    const rows = (await listOutcomesSince(db(), ORG_A, new Date(Date.now() - 3600_000))).filter((r) => r.requestId === id);
    expect(rows).toHaveLength(2);
  });

  it('an unknown request_id is a 404 — outcomes attach to requests Potion served', async () => {
    const res = await report(KEY_A, { request_id: 'chatcmpl-never-served', success: true });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('unknown_request');
  });

  it("org isolation: org B cannot annotate org A's request (404, not 403 — no existence leak)", async () => {
    const id = await serve(KEY_A);
    const res = await report(KEY_B, { request_id: id, success: false });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('unknown_request');
  });

  it('STRICT body: an unknown field is a 400 naming the field, never silently stripped', async () => {
    const id = await serve(KEY_A);
    const res = await report(KEY_A, { request_id: id, success: true, business_value: 12 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('business_value');
  });

  it('an empty outcome is not evidence: no signals → 400', async () => {
    const id = await serve(KEY_A);
    const res = await report(KEY_A, { request_id: id });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('at least one signal');
  });

  it('score is bounded to [0,1]', async () => {
    const id = await serve(KEY_A);
    expect((await report(KEY_A, { request_id: id, score: 1.5 })).statusCode).toBe(400);
    expect((await report(KEY_A, { request_id: id, score: 0.97 })).statusCode).toBe(201);
  });

  it('no key → 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/outcomes', payload: { request_id: 'x', success: true } });
    expect(res.statusCode).toBe(401);
  });
});

describe('the router artifact carries the verdicts', () => {
  it("GET /api/router shows the assignment's customer-outcomes block", async () => {
    // Three fresh requests with verdicts: two successes, one failure+edited.
    const ids = [await serve(KEY_A), await serve(KEY_A), await serve(KEY_A)];
    expect((await report(KEY_A, { request_id: ids[0]!, success: true })).statusCode).toBe(201);
    expect((await report(KEY_A, { request_id: ids[1]!, success: true })).statusCode).toBe(201);
    expect((await report(KEY_A, { request_id: ids[2]!, success: false, human: 'edited' })).statusCode).toBe(201);

    const res = await app.inject({ method: 'GET', url: '/api/router', headers: { authorization: `Bearer ${KEY_A}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      document: { assignments: Array<{ clusterId: string; outcomes?: { instrument: string; requests: number; success: { n: number; rate: number; ci: [number, number] } | null; human: { edited: number } | null } }> };
    };
    const a = body.document.assignments.find((x) => x.clusterId === 'classification')!;
    expect(a.outcomes).toBeDefined();
    expect(a.outcomes!.instrument).toBe('customer-outcomes');
    expect(a.outcomes!.requests).toBeGreaterThanOrEqual(3);
    expect(a.outcomes!.success).not.toBeNull();
    expect(a.outcomes!.success!.n).toBeGreaterThanOrEqual(3);
    expect(a.outcomes!.success!.ci[0]).toBeLessThanOrEqual(a.outcomes!.success!.rate);
    expect(a.outcomes!.human?.edited).toBeGreaterThanOrEqual(1);
  });
});

// ---- C5 reliability (docs/INFERENCE-COMPILER-PLAN.md) ----
//
// The two things observational outcome evidence can honestly support about a
// DEPLOYED assignment, surfaced where the customer reads their plan. Not a
// frontier axis — outcome evidence cannot rank candidates, because routing
// decided which requests each one saw.
describe('C5: the compiled plan carries cost-per-success and the success floor', () => {
  const ORG_R = 'org-reliability';
  const KEY_R = 'pk_reliability';

  async function planFor(key: string) {
    const res = await app.inject({ method: 'GET', url: '/api/router', headers: { authorization: `Bearer ${key}` } });
    expect(res.statusCode).toBe(200);
    return (res.json() as {
      document: {
        assignments: Array<{
          clusterId: string;
          costPer1K: number | null;
          reliability?: { costPerSuccess: number | null; floor: { verdict: string; n: number; reason: string } | null };
        }>;
      };
    }).document.assignments.find((a) => a.clusterId === 'classification')!;
  }

  beforeAll(async () => {
    await createOrg(db(), { id: ORG_R, name: ORG_R });
    await insertPolicy(db(), {
      id: `pol-${ORG_R}`, orgId: ORG_R, name: ORG_R,
      // A demanding floor, so the seeded failures are unambiguously below it.
      config: { type: 'min_cost', qualityFloor: 0.7, guarantee: { minQuality: 0.7, windowMin: 1440, sampleRate: 0, action: 'alert', minSuccessRate: 0.98 } },
    });
    await insertApiKey(db(), { id: `key-${ORG_R}`, keyHash: sha256(KEY_R), name: 'serve', orgId: ORG_R, policyId: `pol-${ORG_R}`, scopes: 'serve+admin' });
    await saveFrontier(db(), 'classification', [point(CHEAP, 0.9, 1.0)], 'manual', '2026-09-05');
    // Eight served requests; six succeeded. Well under a 0.98 floor, and
    // enough of them that the interval does not straddle it.
    for (let i = 0; i < 8; i++) {
      const id = await serve(KEY_R);
      await report(KEY_R, { request_id: id, success: i < 6 });
    }
  }, 120_000);

  it('cost per success is billed against the LOWER bound, so it exceeds raw cost', async () => {
    const a = await planFor(KEY_R);
    expect(a.reliability?.costPerSuccess).not.toBeNull();
    expect(a.reliability!.costPerSuccess!).toBeGreaterThan(a.costPer1K!);
  });

  it('the floor breaches when the whole interval sits below it, and says why', async () => {
    const a = await planFor(KEY_R);
    expect(a.reliability?.floor?.verdict).toBe('breached');
    expect(a.reliability!.floor!.n).toBe(8);
    expect(a.reliability!.floor!.reason).toContain('entirely below the floor');
  });

  it('a policy with no success floor gets no verdict — absent, never a passing zero', async () => {
    const id = await serve(KEY_A);
    await report(KEY_A, { request_id: id, success: true });
    const a = await planFor(KEY_A);
    expect(a.reliability?.floor).toBeNull();
    expect(a.reliability?.costPerSuccess).not.toBeUndefined();
  });
});
