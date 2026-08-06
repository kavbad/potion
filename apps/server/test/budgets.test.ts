// Budget autopilot route + serving-path tests (M4, ROADMAP #35, SPEC §13.7).
//   · GET /api/budgets: unconfigured → budget null + 'unconfigured'; after
//     PUT → row + MTD + forecast + warnAt + state transitions ok→warn→exceeded
//   · PUT validation (cap ≤ 0, warnPct out of 1..100 → 400) + admin gate
//     (viewer 403)
//   · serving path: hardStop=true + MTD ≥ cap → 429 OpenAI-shaped
//     {error:{type:'budget_exceeded', code:'budget_exceeded'}}; hardStop=
//     false (soft cap) NEVER blocks — the same spend serves 200
//   · cache: PUT takes effect IMMEDIATELY (the 60s hard-stop cache is busted
//     on write — no waiting a minute for a lowered cap to bite)
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256, strategyHash, type FrontierPoint } from '@potion/core';
import {
  DEFAULT_ORG_ID,
  createMembership,
  createUser,
  createSession,
  insertApiKey,
  insertPolicy,
  insertRequestLog,
} from '@potion/db';
import { saveFrontier } from '@potion/pareto';
import { buildServer } from '../src/server.js';
import { clearBudgetHardStopCache } from '../src/routes/budgets.js';

const ORG_A = DEFAULT_ORG_ID;
const KEY_A = 'pk_budgets_a';

const CFG = { type: 'single', model: 'mock-mid' } as const;
const POINT: FrontierPoint = {
  clusterId: 'code-gen',
  strategyHash: strategyHash(CFG),
  strategyConfig: CFG,
  quality: 0.9,
  costPer1K: 1.0,
  latencyP95: 100,
};

let app: FastifyInstance;
const db = () => app.potion.db.db;

function chat() {
  return app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${KEY_A}`, 'content-type': 'application/json' },
    payload: { model: 'potion-auto', messages: [{ role: 'user', content: 'hello' }] },
  });
}

function putBudget(payload: unknown, headers: Record<string, string> = {}) {
  return app.inject({ method: 'PUT', url: '/api/budgets', payload, headers });
}

beforeAll(async () => {
  app = await buildServer({ seed: false });
  await saveFrontier(db(), 'code-gen', [POINT], 'manual', 'test-prices');
  await insertPolicy(db(), {
    id: 'pol-budgets',
    orgId: ORG_A,
    name: 'budgets-default',
    config: { type: 'max_quality', costCeilingPer1K: 5 },
  });
  await insertApiKey(db(), {
    id: 'key-budgets-a',
    keyHash: sha256(KEY_A),
    name: 'a',
    orgId: ORG_A,
    policyId: 'pol-budgets',
  });
  await createUser(db(), { id: 'usr_b_viewer', email: 'viewer@b.dev', name: 'viewer' });
  await createMembership(db(), { orgId: ORG_A, userId: 'usr_b_viewer', role: 'viewer' });
  await createSession(db(), {
    id: 'ses_b_viewer',
    userId: 'usr_b_viewer',
    tokenHash: sha256('ps_b_viewer'),
    orgId: ORG_A,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  clearBudgetHardStopCache();
});

afterAll(async () => {
  await app.close();
});

describe('GET/PUT /api/budgets', () => {
  it('unconfigured org → budget null, state unconfigured, zero spend', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/budgets' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.budget).toBeNull();
    expect(body.state).toBe('unconfigured');
    expect(body.mtdUsd).toBe(0);
    expect(typeof body.forecastUsd).toBe('number');
    expect(body.warnAtUsd).toBeNull();
  });

  it('PUT creates the row; GET reflects cap, warn threshold, state ok', async () => {
    const put = await putBudget({ monthlyCapUsd: 100, hardStop: false, warnPct: 80 });
    expect(put.statusCode).toBe(200);
    expect(put.json().budget).toMatchObject({ monthlyCapUsd: 100, hardStop: false, warnPct: 80 });

    const get = await app.inject({ method: 'GET', url: '/api/budgets' });
    const body = get.json();
    expect(body.budget.monthlyCapUsd).toBe(100);
    expect(body.warnAtUsd).toBe(80);
    expect(body.state).toBe('ok');
  });

  it('PUT defaults merge with the existing row (omitted fields kept)', async () => {
    const put = await putBudget({ monthlyCapUsd: 200 });
    expect(put.statusCode).toBe(200);
    expect(put.json().budget).toMatchObject({ monthlyCapUsd: 200, hardStop: false, warnPct: 80 });
  });

  it('validation: cap ≤ 0, warnPct out of range → 400', async () => {
    expect((await putBudget({ monthlyCapUsd: 0 })).statusCode).toBe(400);
    expect((await putBudget({ monthlyCapUsd: -5 })).statusCode).toBe(400);
    expect((await putBudget({ monthlyCapUsd: 10, warnPct: 0 })).statusCode).toBe(400);
    expect((await putBudget({ monthlyCapUsd: 10, warnPct: 101 })).statusCode).toBe(400);
  });

  it('viewer may GET but not PUT (403)', async () => {
    const cookie = { cookie: 'potion_session=ps_b_viewer' };
    const get = await app.inject({ method: 'GET', url: '/api/budgets', headers: cookie });
    expect(get.statusCode).toBe(200);
    const put = await putBudget({ monthlyCapUsd: 50 }, cookie);
    expect(put.statusCode).toBe(403);
  });
});

describe('serving-path hard stop', () => {
  it('soft cap never blocks; hard cap 429s with the OpenAI budget shape; PUT busts the cache', async () => {
    // $0.40 MTD for org A today.
    const today = new Date().toISOString().slice(0, 10);
    await insertRequestLog(db(), {
      ts: new Date(`${today}T09:00:00Z`),
      orgId: ORG_A,
      clusterId: 'code-gen',
      status: 'ok',
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.4, latencyMs: 10 },
    });

    // Soft cap at $0.10 (MTD 4× over) → still serves.
    await putBudget({ monthlyCapUsd: 0.1, hardStop: false, warnPct: 80 });
    clearBudgetHardStopCache();
    const soft = await chat();
    expect(soft.statusCode).toBe(200);

    // Same cap, hard stop → 429 budget_exceeded, OpenAI-shaped.
    const hard = await putBudget({ monthlyCapUsd: 0.1, hardStop: true });
    expect(hard.statusCode).toBe(200);
    const blocked = await chat();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual({
      error: {
        message: expect.stringContaining('budget cap'),
        type: 'budget_exceeded',
        param: null,
        code: 'budget_exceeded',
      },
    });
    expect(blocked.headers['content-type']).toContain('application/json');

    // State read reflects 'exceeded'.
    const get = await app.inject({ method: 'GET', url: '/api/budgets' });
    expect(get.json().state).toBe('exceeded');

    // Raising the cap serves again IMMEDIATELY (no 60s cache wait).
    await putBudget({ monthlyCapUsd: 1e6, hardStop: true });
    const open = await chat();
    expect(open.statusCode).toBe(200);

    // Disarm.
    await putBudget({ monthlyCapUsd: 1e6, hardStop: false });
    clearBudgetHardStopCache();
  });

  it('GET reports warn state between warnAt and cap', async () => {
    // MTD is $0.40 (seeded above) plus the two mock serves — comfortably
    // inside [warnAt, cap) for cap $1.00 at 80%? No — MTD < $0.80. Use a
    // tight cap: cap $0.45, warn 80% → warnAt $0.36 < MTD < cap → 'warn'.
    await putBudget({ monthlyCapUsd: 0.45, hardStop: false, warnPct: 80 });
    const get = await app.inject({ method: 'GET', url: '/api/budgets' });
    const body = get.json();
    expect(body.mtdUsd).toBeGreaterThan(0.36);
    expect(body.mtdUsd).toBeLessThan(0.45);
    expect(body.state).toBe('warn');
    await putBudget({ monthlyCapUsd: 1e6, hardStop: false });
    clearBudgetHardStopCache();
  });
});
