// Usage aggregation + read routes tests (M2 Wave 2, ROADMAP #18).
//   · aggregateUsage correctness on seeded request_logs (hand-computed) and
//     idempotency (re-run converges, then converges again after new logs)
//   · org isolation on every /api/usage* endpoint
//   · CSV export shape
//   · /api/usage/current reads the in-flight day LIVE from request_logs
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256, type Usage } from '@potion/core';
import {
  aggregateUsage,
  insertApiKey,
  insertRequestLog,
  listUsageDaily,
  DEFAULT_ORG_ID,
} from '@potion/db';
import { buildServer } from '../src/server.js';
// G2.4 carryover: cross-tenant suites use TWO DISTINCT NON-DEFAULT orgs from the
// shared fixture — the demo org must never be the probed subject (see the
// fixture header; that assumption is what hid tenancy defect D1).
import { ORG_A, ORG_B, seedIsolationOrgs } from './fixtures/orgs.js';

const RAW_A = 'pk_usage_org_a';
const RAW_B = 'pk_usage_org_b';
const RAW_BAD = 'pk_usage_nope';

let app: FastifyInstance;
const db = () => app.potion.db.db;

function authedGet(url: string, rawKey?: string) {
  return app.inject({
    method: 'GET',
    url,
    ...(rawKey !== undefined ? { headers: { authorization: `Bearer ${rawKey}` } } : {}),
  });
}

function usage(inTok: number, outTok: number, cost: number): Usage {
  return { inputTokens: inTok, outputTokens: outTok, costUsd: cost, latencyMs: 10 };
}

beforeAll(async () => {
  app = await buildServer({ seed: false });
  await seedIsolationOrgs(db());
  await insertApiKey(db(), { id: 'key-usage-a', keyHash: sha256(RAW_A), name: 'a', orgId: ORG_A });
  await insertApiKey(db(), { id: 'key-usage-b', keyHash: sha256(RAW_B), name: 'b', orgId: ORG_B });

  // ---- seeded request_logs (hand-computed expectations below) ----
  const rows: Array<Parameters<typeof insertRequestLog>[1]> = [
    // org A · 2026-08-02 · code-gen: 2 ok rows → in 300, out 150, $0.03
    { ts: new Date('2026-08-02T10:00:00Z'), orgId: ORG_A, clusterId: 'code-gen', status: 'ok', usage: usage(100, 50, 0.01) },
    { ts: new Date('2026-08-02T11:00:00Z'), orgId: ORG_A, clusterId: 'code-gen', status: 'ok', usage: usage(200, 100, 0.02) },
    // org A · 2026-08-02 · extraction: 1 ok row → in 10, out 5, $0.001
    { ts: new Date('2026-08-02T12:00:00Z'), orgId: ORG_A, clusterId: 'extraction', status: 'ok', usage: usage(10, 5, 0.001) },
    // org A · 2026-08-02 · excluded rows: not status='ok'
    { ts: new Date('2026-08-02T12:30:00Z'), orgId: ORG_A, clusterId: 'code-gen', status: 'rate_limited' },
    { ts: new Date('2026-08-02T12:45:00Z'), orgId: ORG_A, clusterId: 'code-gen', status: 'error' },
    // org A · 2026-08-03 · code-gen: 1 ok row with NULL usage → counts as a request, zero tokens/$
    { ts: new Date('2026-08-03T09:00:00Z'), orgId: ORG_A, clusterId: 'code-gen', status: 'ok', usage: null },
    // org A · far-future row → outside any window 'today' can reach (was 2026-08-05T09:00Z — time-bombed when the sandbox clock reached that date)
    { ts: new Date('2027-06-15T09:00:00Z'), orgId: ORG_A, clusterId: 'code-gen', status: 'ok', usage: usage(999, 999, 9.99) },
    // org A · 2026-08-03 · extraction: 1 guarantee_judge row (G0.1 judge
    // scoring spend) → counts toward COST only, never requests/tokens
    { ts: new Date('2026-08-03T10:00:00Z'), orgId: ORG_A, clusterId: 'extraction', status: 'guarantee_judge', usage: usage(40, 8, 0.004) },
    // org A · 2026-08-03 · extraction: 1 rubric_gen row (G1.5 rubric
    // generation spend) → same contract: COST only
    { ts: new Date('2026-08-03T10:30:00Z'), orgId: ORG_A, clusterId: 'extraction', status: 'rubric_gen', usage: usage(500, 200, 0.002) },
    // org A · 2026-08-03 · extraction: 1 eval_live row (G1.7 live eval-sweep
    // spend) → same contract: COST only
    { ts: new Date('2026-08-03T11:00:00Z'), orgId: ORG_A, clusterId: 'extraction', status: 'eval_live', usage: usage(0, 0, 0.003) },
    // org B · 2026-08-02 · code-gen: 1 ok row → in 1000, out 500, $0.50
    { ts: new Date('2026-08-02T10:00:00Z'), orgId: ORG_B, clusterId: 'code-gen', status: 'ok', usage: usage(1000, 500, 0.5) },
  ];
  for (const r of rows) await insertRequestLog(db(), r);
}, 90_000);

afterAll(async () => {
  await app.close();
});

describe('aggregateUsage rollup (hand-computed)', () => {
  it('rolls request_logs into usage_daily at org/day/cluster grain', async () => {
    const written = await aggregateUsage(db(), { fromDay: '2026-08-02', toDay: '2026-08-03' });
    // A×(08-02 code-gen, 08-02 extraction, 08-03 code-gen, 08-03 extraction[judge-only]) + B×08-02 code-gen
    expect(written).toHaveLength(5);

    const aRows = await listUsageDaily(db(), ORG_A, { fromDay: '2026-08-02', toDay: '2026-08-03' });
    expect(aRows.map((r) => [r.day, r.clusterId])).toEqual([
      ['2026-08-02', 'code-gen'],
      ['2026-08-02', 'extraction'],
      ['2026-08-03', 'code-gen'],
      ['2026-08-03', 'extraction'],
    ]);
    const [cg, ex, d3, judgeOnly] = aRows;
    // G0.1 contract: judge-scoring spend is COST, never served traffic —
    // a judge-only (org, day, cluster) group bills with 0 requests. G1.5
    // rubric_gen + G1.7 eval_live follow the same rule:
    // $0.004 + $0.002 + $0.003 = $0.009, 0 requests.
    expect(judgeOnly).toMatchObject({ requests: 0, inputTokens: 0, outputTokens: 0 });
    expect(judgeOnly!.costUsd).toBeCloseTo(0.009, 10);
    // hand math: code-gen 08-02 = rows 1+2 (rate_limited/error excluded)
    expect(cg).toMatchObject({ requests: 2, inputTokens: 300, outputTokens: 150 });
    expect(cg!.costUsd).toBeCloseTo(0.03, 10);
    expect(cg!.platformCostUsd).toBeCloseTo(0.03, 10); // pricing v1 pass-through
    expect(ex).toMatchObject({ requests: 1, inputTokens: 10, outputTokens: 5 });
    expect(ex!.costUsd).toBeCloseTo(0.001, 10);
    expect(d3).toMatchObject({ requests: 1, inputTokens: 0, outputTokens: 0, costUsd: 0 });

    const bRows = await listUsageDaily(db(), ORG_B, { fromDay: '2026-08-02', toDay: '2026-08-03' });
    expect(bRows).toHaveLength(1);
    expect(bRows[0]).toMatchObject({
      day: '2026-08-02',
      clusterId: 'code-gen',
      requests: 1,
      inputTokens: 1000,
      outputTokens: 500,
    });
    expect(bRows[0]!.costUsd).toBeCloseTo(0.5, 10);
  });

  it('is idempotent: re-running converges, then re-converges after new logs', async () => {
    const before = await listUsageDaily(db(), ORG_A, { fromDay: '2026-08-02', toDay: '2026-08-03' });
    await aggregateUsage(db(), { fromDay: '2026-08-02', toDay: '2026-08-03' });
    const after = await listUsageDaily(db(), ORG_A, { fromDay: '2026-08-02', toDay: '2026-08-03' });
    expect(after).toEqual(before);

    // new ok row lands for 2026-08-02 code-gen → full-replace upsert catches it
    await insertRequestLog(db(), {
      ts: new Date('2026-08-02T18:00:00Z'),
      orgId: ORG_A,
      clusterId: 'code-gen',
      status: 'ok',
      usage: usage(7, 3, 0.0007),
    });
    await aggregateUsage(db(), { fromDay: '2026-08-02', toDay: '2026-08-03' });
    const updated = await listUsageDaily(db(), ORG_A, { fromDay: '2026-08-02', toDay: '2026-08-02' });
    const cg = updated.find((r) => r.clusterId === 'code-gen')!;
    expect(cg).toMatchObject({ requests: 3, inputTokens: 307, outputTokens: 153 });
    expect(cg.costUsd).toBeCloseTo(0.0307, 10);
  });
});

describe('usage read routes (org isolation)', () => {
  it('GET /api/usage group_by=day: per-day rows with per-cluster breakdown, org A only', async () => {
    const res = await authedGet('/api/usage?from=2026-08-02&to=2026-08-03&group_by=day', RAW_A);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.orgId).toBe(ORG_A);
    expect(body.rows).toHaveLength(2);
    const [d2, d3] = body.rows;
    expect(d2.day).toBe('2026-08-02');
    expect(d2.requests).toBe(4); // 3 code-gen + 1 extraction (post second rollup)
    expect(d2.inputTokens).toBe(317);
    expect(d2.clusters.map((c: { clusterId: string }) => c.clusterId)).toEqual(['code-gen', 'extraction']);
    expect(d3).toMatchObject({ day: '2026-08-03', requests: 1, inputTokens: 0 });
  });

  it('GET /api/usage group_by=cluster: per-cluster totals + avg $/1K, org B only', async () => {
    const res = await authedGet('/api/usage?from=2026-08-02&to=2026-08-03&group_by=cluster', RAW_B);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.orgId).toBe(ORG_B);
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({
      clusterId: 'code-gen',
      requests: 1,
      inputTokens: 1000,
      outputTokens: 500,
    });
    expect(body.rows[0].costUsd).toBeCloseTo(0.5, 10);
    expect(body.rows[0].avgCostPer1K).toBeCloseTo(500, 5); // $0.50 / 1 req × 1000
  });

  it('GET /api/usage without credentials falls back to the default org (local tool)', async () => {
    // G2.4 carryover: this asserted ORG_A back when ORG_A *was* the default
    // org. The claim is about the fallback target, so name it.
    const res = await authedGet('/api/usage?from=2026-08-02&to=2026-08-02');
    expect(res.statusCode).toBe(200);
    expect(res.json().orgId).toBe(DEFAULT_ORG_ID);
  });

  it('GET /api/usage with an invalid key is 401 (never silently widened)', async () => {
    const res = await authedGet('/api/usage?from=2026-08-02&to=2026-08-02', RAW_BAD);
    expect(res.statusCode).toBe(401);
  });

  it('GET /api/usage/current reads today + MTD live from request_logs', async () => {
    const now = new Date();
    await insertRequestLog(db(), {
      ts: now,
      orgId: ORG_B,
      clusterId: 'extraction',
      status: 'ok',
      usage: usage(40, 20, 0.004),
    });
    const res = await authedGet('/api/usage/current', RAW_B);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const today = now.toISOString().slice(0, 10);
    expect(body.today).toMatchObject({ day: today, requests: 1, inputTokens: 40, outputTokens: 20 });
    expect(body.today.costUsd).toBeCloseTo(0.004, 10);
    expect(body.mtd.requests).toBeGreaterThanOrEqual(1);
    // org isolation on the live path too
    const aRes = await authedGet('/api/usage/current', RAW_A);
    expect(aRes.json().today.requests).toBe(0);
  });
});

describe('CSV export', () => {
  it('GET /api/usage/export.csv returns org-scoped day×cluster CSV', async () => {
    const res = await authedGet('/api/usage/export.csv?from=2026-08-02&to=2026-08-03', RAW_A);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');
    const lines = res.body.trim().split('\n');
    expect(lines[0]).toBe(
      'day,cluster_id,requests,input_tokens,output_tokens,cost_usd,platform_cost_usd',
    );
    expect(lines).toHaveLength(5); // header + 4 org-A rows (org B invisible)
    expect(lines[1]).toMatch(/^2026-08-02,code-gen,3,307,153,/);
    expect(lines[2]).toMatch(/^2026-08-02,extraction,1,10,5,/);
    expect(lines[3]).toMatch(/^2026-08-03,code-gen,1,0,0,0,0$/);
    // G0.1: judge-scoring spend row — 0 requests/tokens, cost billed
    expect(lines[4]).toMatch(/^2026-08-03,extraction,0,0,0,0\.009,0\.009$/);
    // org B's CSV has only its own row
    const bRes = await authedGet('/api/usage/export.csv?from=2026-08-02&to=2026-08-03', RAW_B);
    expect(bRes.body.trim().split('\n')).toHaveLength(2);
  });
});
