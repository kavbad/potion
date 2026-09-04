// Savings report tests (M3, ROADMAP #21, SPEC §12.4).
//   · buildSavingsReport: hand-computed to the cent; quality mean ignores
//     unscored (NULL) samples; confidence tiers at the 29/30 + 199/200
//     boundaries; empty window → zeroed report
//   · routes: seeded shadow_results + request_logs → the same hand-computed
//     SavingsReport over HTTP; org isolation; CSV export shape
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256, strategyHash, type Usage } from '@potion/core';
import {
  insertApiKey,
  insertRequestLog,
  insertShadowResult,
  upsertStrategyConfig,
  type ShadowResultRow,
} from '@potion/db';
import { buildServer } from '../src/server.js';
// G2.4 carryover: cross-tenant suites use TWO DISTINCT NON-DEFAULT orgs from the
// shared fixture — the demo org must never be the probed subject (see the
// fixture header; that assumption is what hid tenancy defect D1).
import { ORG_A, ORG_B, seedIsolationOrgs } from './fixtures/orgs.js';
import {
  VERIFIED_OFF,
  buildSavingsReport,
  confidenceFor,
  describeStrategyBrief,
  savingsCsv,
} from '../src/routes/reports.js';

/** ORG_A credential. These route tests used to call unauthenticated and ride
 * the dev bypass onto the demo org, which silently happened to be the org they
 * seeded — the accident the isolation fixture exists to expose. The subject
 * tenant is now named explicitly on every request. */
const RAW_A = 'pk_reports_org_a';
const RAW_B = 'pk_reports_org_b';

const CFG_CHEAP = { type: 'single', model: 'mock-cheap' } as const;
const H_CHEAP = strategyHash(CFG_CHEAP); // labeled via strategy_configs
const H_UNLABELED = 'eeeeffff00001111eeeeffff00001111'; // no config anywhere

// ---------- pure report math ----------

function unitRow(hash: string, costUsd: number, quality: number | null): ShadowResultRow {
  return {
    id: randomUUID(),
    orgId: 'org_x',
    requestId: null,
    clusterId: 'code-gen',
    primaryHash: 'primary',
    candidateHash: hash,
    candidateModel: 'mock-cheap',
    quality,
    costUsd,
    latencyMs: 10,
    createdAt: new Date('2026-08-02T13:00:00Z'),
  };
}

const SCOPE = { orgId: 'org_x', fromDay: '2026-08-02', toDay: '2026-08-03' };

describe('buildSavingsReport (hand-computed to the cent)', () => {
  it('projects mean candidate cost × request count, delta = actual − projected', () => {
    const report = buildSavingsReport(
      SCOPE,
      { actualSpendUsd: 100.0, requestCount: 1000 },
      [unitRow('h1', 0.05, 0.8), unitRow('h1', 0.07, 0.9), unitRow('h2', 0.2, null)],
      new Map(),
    );
    expect(report.actualSpendUsd).toBe(100.0);
    expect(report.alternatives).toHaveLength(2);
    const [h1, h2] = report.alternatives;
    // h1: mean cost 0.06 × 1000 = $60.00 projected; delta $40.00 — biggest saving first
    expect(h1!.strategyHash).toBe('h1');
    expect(h1!.projectedSpendUsd).toBeCloseTo(60.0, 10);
    expect(h1!.deltaUsd).toBeCloseTo(40.0, 10);
    expect(h1!.projectedQuality).toBeCloseTo(0.85, 10);
    expect(h1!.sampleSize).toBe(2);
    // h2: mean 0.2 × 1000 = $200 → delta −$100; NULL quality excluded from the mean
    expect(h2!.projectedSpendUsd).toBeCloseTo(200.0, 10);
    expect(h2!.deltaUsd).toBeCloseTo(-100.0, 10);
    expect(h2!.projectedQuality).toBe(0);
  });

  it('labels known configs, falls back to candidate_model + short hash', () => {
    const report = buildSavingsReport(
      SCOPE,
      { actualSpendUsd: 1, requestCount: 1 },
      [unitRow(H_CHEAP, 0.001, 0.5), unitRow(H_UNLABELED, 0.001, 0.5)],
      new Map([[H_CHEAP, CFG_CHEAP]]),
    );
    const labeled = report.alternatives.find((a) => a.strategyHash === H_CHEAP)!;
    const unlabeled = report.alternatives.find((a) => a.strategyHash === H_UNLABELED)!;
    expect(labeled.label).toBe('single · mock-cheap');
    expect(unlabeled.label).toBe(`mock-cheap (${H_UNLABELED.slice(0, 8)})`);
  });

  it('empty window → zeroed report', () => {
    const report = buildSavingsReport(
      SCOPE,
      { actualSpendUsd: 0, requestCount: 0 },
      [],
      new Map(),
    );
    expect(report).toEqual({ orgId: 'org_x', from: '2026-08-02', to: '2026-08-03', actualSpendUsd: 0, verified: VERIFIED_OFF, alternatives: [], withheld: [] });
  });

  it('WITHHELD SEAM (post-capstone item 3): uncertified-cluster samples are excluded AND reported — never silently blended', () => {
    const agentRow = { ...unitRow('h1', 0.05, 0.8), clusterId: 'agent-abc-uncert' };
    const report = buildSavingsReport(
      SCOPE,
      { actualSpendUsd: 100.0, requestCount: 1000 },
      [agentRow, { ...agentRow, id: randomUUID() }, unitRow('h1', 0.07, 0.9)],
      new Map(),
      new Map([['agent-abc-uncert', 'suite not certified — incumbent self-retention gate not passed']]),
    );
    // Only the non-withheld sample contributes: mean cost 0.07, not 0.0633.
    expect(report.alternatives).toHaveLength(1);
    expect(report.alternatives[0]!.projectedSpendUsd).toBeCloseTo(70.0, 10);
    expect(report.alternatives[0]!.sampleSize).toBe(1);
    // The withholding is REPORTED, with counts and the reason.
    expect(report.withheld).toEqual([
      {
        clusterId: 'agent-abc-uncert',
        samples: 2,
        reason: 'suite not certified — incumbent self-retention gate not passed',
      },
    ]);
    // The CSV names the withheld contribution too.
    const csv = savingsCsv(report);
    expect(csv).toContain('# withheld,agent-abc-uncert,2');
  });
});

describe('confidence tiers (boundaries)', () => {
  it('low <30, medium <200, high ≥200', () => {
    expect(confidenceFor(0)).toBe('low');
    expect(confidenceFor(29)).toBe('low');
    expect(confidenceFor(30)).toBe('medium');
    expect(confidenceFor(199)).toBe('medium');
    expect(confidenceFor(200)).toBe('high');
    expect(confidenceFor(10_000)).toBe('high');
  });

  it('tiers flow through the report at the 29/30 and 199/200 boundaries', () => {
    const rows = (n: number, hash: string) => Array.from({ length: n }, () => unitRow(hash, 0.01, 0.5));
    const report = buildSavingsReport(
      SCOPE,
      { actualSpendUsd: 1, requestCount: 1 },
      [...rows(29, 'n29'), ...rows(30, 'n30'), ...rows(199, 'n199'), ...rows(200, 'n200')],
      new Map(),
    );
    const tier = (h: string) => report.alternatives.find((a) => a.strategyHash === h)!.confidence;
    expect(tier('n29')).toBe('low');
    expect(tier('n30')).toBe('medium');
    expect(tier('n199')).toBe('medium');
    expect(tier('n200')).toBe('high');
  });
});

describe('describeStrategyBrief', () => {
  it('labels strategy configs compactly', () => {
    expect(describeStrategyBrief(CFG_CHEAP)).toBe('single · mock-cheap');
    expect(describeStrategyBrief({ type: 'best-of-n', model: 'm', n: 4, judge: { model: 'j' } })).toBe(
      'best-of-4 · m',
    );
  });
});

// ---------- routes over seeded data ----------

const usage = (cost: number): Usage => ({ inputTokens: 10, outputTokens: 5, costUsd: cost, latencyMs: 10 });

let app: FastifyInstance;
const db = () => app.potion.db.db;

beforeAll(async () => {
  app = await buildServer({ seed: false });
  await seedIsolationOrgs(db());
  await insertApiKey(db(), { id: 'key-reports-a', keyHash: sha256(RAW_A), name: 'a', orgId: ORG_A });
  await insertApiKey(db(), { id: 'key-reports-b', keyHash: sha256(RAW_B), name: 'b', orgId: ORG_B });
  await upsertStrategyConfig(db(), H_CHEAP, CFG_CHEAP);

  // request_logs — org A: 2 ok rows ($0.03, 2 requests) + 1 excluded error row
  await insertRequestLog(db(), { ts: new Date('2026-08-02T10:00:00Z'), orgId: ORG_A, clusterId: 'code-gen', status: 'ok', usage: usage(0.01) });
  await insertRequestLog(db(), { ts: new Date('2026-08-02T11:00:00Z'), orgId: ORG_A, clusterId: 'code-gen', status: 'ok', usage: usage(0.02) });
  await insertRequestLog(db(), { ts: new Date('2026-08-02T12:00:00Z'), orgId: ORG_A, clusterId: 'code-gen', status: 'error' });
  // request_logs — org B: 1 ok row ($0.50)
  await insertRequestLog(db(), { ts: new Date('2026-08-02T10:00:00Z'), orgId: ORG_B, clusterId: 'code-gen', status: 'ok', usage: usage(0.5) });

  // shadow_results — org A: H_CHEAP ×2 (labeled), H_UNLABELED ×1
  const at = (iso: string) => new Date(iso);
  await insertShadowResult(db(), { orgId: ORG_A, requestId: 'r1', clusterId: 'code-gen', primaryHash: 'p', candidateHash: H_CHEAP, candidateModel: 'mock-cheap', quality: 0.5, costUsd: 0.001, latencyMs: 12, createdAt: at('2026-08-02T13:00:00Z') });
  await insertShadowResult(db(), { orgId: ORG_A, requestId: 'r2', clusterId: 'code-gen', primaryHash: 'p', candidateHash: H_CHEAP, candidateModel: 'mock-cheap', quality: 0.7, costUsd: 0.003, latencyMs: 15, createdAt: at('2026-08-02T14:00:00Z') });
  await insertShadowResult(db(), { orgId: ORG_A, requestId: 'r3', clusterId: 'code-gen', primaryHash: 'p', candidateHash: H_UNLABELED, candidateModel: 'mock-mid', quality: 0.9, costUsd: 0.01, latencyMs: 30, createdAt: at('2026-08-03T09:00:00Z') });
  // shadow_results — org B: H_CHEAP ×1 (must NOT leak into org A's report)
  await insertShadowResult(db(), { orgId: ORG_B, requestId: 'r9', clusterId: 'code-gen', primaryHash: 'p', candidateHash: H_CHEAP, candidateModel: 'mock-cheap', quality: 0.8, costUsd: 0.4, latencyMs: 20, createdAt: at('2026-08-02T13:30:00Z') });
}, 90_000);

afterAll(async () => {
  await app.close();
});

const QS = 'from=2026-08-02&to=2026-08-03';

describe('GET /api/reports/savings', () => {
  it('returns the hand-computed SavingsReport for the calling org', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/reports/savings?${QS}`,
      headers: { authorization: `Bearer ${RAW_A}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.orgId).toBe(ORG_A);
    expect(body.from).toBe('2026-08-02');
    expect(body.to).toBe('2026-08-03');
    expect(body.actualSpendUsd).toBeCloseTo(0.03, 10); // error row excluded

    expect(body.alternatives).toHaveLength(2); // org B's H_CHEAP sample must NOT leak in
    const [cheap, unlabeled] = body.alternatives;
    // H_CHEAP: mean cost 0.002 × 2 requests = $0.004; quality mean 0.6; delta 0.03 − 0.004 = 0.026
    expect(cheap.strategyHash).toBe(H_CHEAP);
    expect(cheap.label).toBe('single · mock-cheap');
    expect(cheap.projectedSpendUsd).toBeCloseTo(0.004, 10);
    expect(cheap.projectedQuality).toBeCloseTo(0.6, 10);
    expect(cheap.deltaUsd).toBeCloseTo(0.026, 10);
    expect(cheap.sampleSize).toBe(2);
    expect(cheap.confidence).toBe('low');
    // H_UNLABELED: mean 0.01 × 2 = $0.02; delta 0.01; fallback label
    expect(unlabeled.strategyHash).toBe(H_UNLABELED);
    expect(unlabeled.label).toBe(`mock-mid (${H_UNLABELED.slice(0, 8)})`);
    expect(unlabeled.projectedSpendUsd).toBeCloseTo(0.02, 10);
    expect(unlabeled.deltaUsd).toBeCloseTo(0.01, 10);
    expect(unlabeled.sampleSize).toBe(1);
  });

  it('org isolation: org B sees its own spend + samples only', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/reports/savings?${QS}`,
      headers: { authorization: `Bearer ${RAW_B}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.orgId).toBe(ORG_B);
    expect(body.actualSpendUsd).toBeCloseTo(0.5, 10);
    expect(body.alternatives).toHaveLength(1);
    const [cheap] = body.alternatives;
    // org B H_CHEAP: 1 sample, mean 0.4 × 1 request = $0.40; delta 0.10
    expect(cheap.sampleSize).toBe(1);
    expect(cheap.projectedSpendUsd).toBeCloseTo(0.4, 10);
    expect(cheap.deltaUsd).toBeCloseTo(0.1, 10);
    expect(cheap.projectedQuality).toBeCloseTo(0.8, 10);
  });

  it('empty window → zeroed report', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/reports/savings?from=2020-01-01&to=2020-01-02',
      headers: { authorization: `Bearer ${RAW_A}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      orgId: ORG_A,
      from: '2020-01-01',
      to: '2020-01-02',
      actualSpendUsd: 0,
      // G1 (0086): the holdout block rides every report — 'off' here (the
      // fixture org never consented), never invented zeros dressed as proof.
      verified: VERIFIED_OFF,
      alternatives: [],
      withheld: [],
    });
  });

  it('rejects malformed dates', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/reports/savings?from=nope&to=2026-08-03' });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/reports/savings.csv', () => {
  it('exports the same alternatives as CSV with attachment disposition', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/reports/savings.csv?${QS}`,
      headers: { authorization: `Bearer ${RAW_A}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain(
      `attachment; filename="potion-savings_${ORG_A}_2026-08-02_2026-08-03.csv"`,
    );
    const lines = res.body.trim().split('\n');
    expect(lines[0]).toBe(
      'strategy_hash,label,sample_size,confidence,projected_spend_usd,projected_quality,delta_usd,actual_spend_usd',
    );
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe(`${H_CHEAP},single · mock-cheap,2,low,0.004,0.6,0.026,0.03`);
    expect(lines[2]).toBe(`${H_UNLABELED},mock-mid (${H_UNLABELED.slice(0, 8)}),1,low,0.02,0.9,0.01,0.03`);
  });

  it('savingsCsv quoting: labels with commas are quoted', () => {
    const csv = savingsCsv({
      orgId: 'o',
      from: '2026-08-02',
      to: '2026-08-03',
      actualSpendUsd: 1,
      verified: VERIFIED_OFF,
      alternatives: [
        {
          strategyHash: 'h',
          label: 'ensemble · a,b',
          projectedSpendUsd: 0.5,
          projectedQuality: 0.5,
          deltaUsd: 0.5,
          sampleSize: 1,
          confidence: 'low',
        },
      ],
      withheld: [],
    });
    expect(csv.split('\n')[1]).toBe('h,"ensemble · a,b",1,low,0.5,0.5,0.5,1');
  });
});
