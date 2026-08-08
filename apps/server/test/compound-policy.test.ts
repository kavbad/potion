// G2.6 end-to-end — compound policy (quality floor + HARD latency bound) on
// the real serving path, over PGlite with mock providers. Zero network.
//
// The frontier is the M1b shape, because that result is the whole reason the
// premium feature exists: a cascade reaches near-frontier quality at roughly a
// third of the cost, but escalating makes it a two-call latency profile. A
// tight p95 bound prunes exactly that point, and the customer pays more for a
// constraint they may not need. Every assertion below is about making that
// trade VISIBLE rather than silent.
//
//   · the bound EXCLUDES (hard constraint), it never trades off against cost
//   · the trace/DTO/report carry the premium and the relaxation target
//   · latency binds against SERVING-grade p95 where the evidence supports it,
//     and says "harness" — provisionally — where it does not
//   · /v1/completions gets the SAME binding as /v1/chat/completions (a bound
//     enforced in one route is not enforced)
//   · unmeetable bound → serve the FASTEST QUALITY-QUALIFYING point, label the
//     violation, and raise ONE standing condition that auto-resolves
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256, strategyHash, type FrontierPoint, type Policy } from '@potion/core';
import {
  insertApiKey,
  insertPolicy,
  insertRequestLog,
  listOpenPolicyConditions,
  type PolicyInfeasibleDetail,
} from '@potion/db';
import { saveFrontier } from '@potion/pareto';
import { buildServer } from '../src/server.js';
import { clearServingLatencyCache } from '../src/latency-policy.js';
import { ORG_A, ORG_B, seedIsolationOrgs } from './fixtures/orgs.js';

// ---- the M1b frontier shape ----
const CFG_CHEAP = { type: 'single', model: 'mock-cheap' } as const;
const CFG_CASCADE = {
  type: 'cascade',
  models: ['mock-cheap', 'mock-frontier'],
  confidenceThreshold: 0.7,
} as const;
const CFG_STRONG = { type: 'single', model: 'mock-frontier' } as const;

const H_CHEAP = strategyHash(CFG_CHEAP);
const H_CASCADE = strategyHash(CFG_CASCADE);
const H_STRONG = strategyHash(CFG_STRONG);

function point(
  strategyConfig: FrontierPoint['strategyConfig'],
  quality: number,
  costPer1K: number,
  latencyP95: number,
): FrontierPoint {
  return {
    clusterId: 'code-gen',
    strategyHash: strategyHash(strategyConfig),
    strategyConfig,
    quality,
    costPer1K,
    latencyP95,
    providerMode: 'mock',
  };
}

const POINTS: FrontierPoint[] = [
  point(CFG_CHEAP, 0.72, 0.4, 300), // fast, under a 0.8 floor
  point(CFG_CASCADE, 0.88, 0.9, 2100), // the M1b point: ⅓ cost, SLOW
  point(CFG_STRONG, 0.9, 2.5, 1200), // full price, fast enough
];

// ---- keys ----
const KEY_TIGHT = 'pk_g26_tight'; // compound 0.8 / 1500ms → prunes the cascade
const KEY_LOOSE = 'pk_g26_loose'; // compound 0.8 / 2500ms → cascade wins
const KEY_IMPOSSIBLE = 'pk_g26_impossible'; // compound 0.8 / 400ms → violation
const KEY_ADMIN = 'pk_g26_admin';

const PROMPT = 'Write a python function that reverses a string';

let app: FastifyInstance;
const db = (): FastifyInstance['potion']['db']['db'] => app.potion.db.db;

function chat(rawKey: string) {
  return app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${rawKey}`, 'content-type': 'application/json' },
    payload: { model: 'potion-auto', messages: [{ role: 'user', content: PROMPT }] },
  });
}

function legacyCompletions(rawKey: string) {
  return app.inject({
    method: 'POST',
    url: '/v1/completions',
    headers: { authorization: `Bearer ${rawKey}`, 'content-type': 'application/json' },
    payload: { model: 'potion-auto', prompt: PROMPT },
  });
}

/** Parse an x-frontier-trace into a field map. */
function trace(res: { headers: Record<string, unknown> }): Record<string, string> {
  const raw = String(res.headers['x-frontier-trace'] ?? '');
  return Object.fromEntries(
    raw.split(';').filter(Boolean).map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i), kv.slice(i + 1)];
    }),
  );
}

const compound = (qualityFloor: number, p95Ms: number): Policy => ({
  type: 'compound',
  qualityFloor,
  p95Ms,
});

beforeAll(async () => {
  app = await buildServer({ seed: false });
  await seedIsolationOrgs(db());
  await saveFrontier(db(), 'code-gen', POINTS, 'manual', 'test-prices');

  const specs: Array<{ id: string; key: string; config: Policy }> = [
    { id: 'pol-tight', key: KEY_TIGHT, config: compound(0.8, 1500) },
    { id: 'pol-loose', key: KEY_LOOSE, config: compound(0.8, 2500) },
    // 400ms admits the CHEAP point (300ms) — which is below the quality floor.
    // The richer infeasible shape: the bound is satisfiable, the floor is
    // satisfiable, their INTERSECTION is empty, so both relaxation directions
    // are real and the fallback must not reach for the fast-but-worse point.
    { id: 'pol-impossible', key: KEY_IMPOSSIBLE, config: compound(0.8, 400) },
  ];
  for (const s of specs) {
    await insertPolicy(db(), { id: s.id, orgId: ORG_A, name: s.id, config: s.config });
    await insertApiKey(db(), {
      id: `key-${s.id}`,
      keyHash: sha256(s.key),
      name: s.id,
      orgId: ORG_A,
      policyId: s.id,
    });
  }
  await insertApiKey(db(), {
    id: 'key-g26-admin',
    keyHash: sha256(KEY_ADMIN),
    name: 'admin',
    orgId: ORG_A,
    policyId: 'pol-tight',
    scopes: 'serve+admin',
  });
}, 90_000);

afterAll(async () => {
  await app.close();
});

// ---------------------------------------------------------------------------
// selection: the hard constraint
// ---------------------------------------------------------------------------

describe('compound policy on the serving path', () => {
  it('a 1500ms bound EXCLUDES the cheaper cascade and serves the strong point', async () => {
    const res = await chat(KEY_TIGHT);
    expect(res.statusCode).toBe(200);
    const t = trace(res);
    expect(t.policy).toBe('compound'); // a distinct type in every audit surface
    expect(t.strategy).toBe(H_STRONG.slice(0, 8));
    expect(t.fallback).toBe('0'); // feasible — not a fallback
  });

  it('relaxing the bound to 2500ms lets the cascade win on cost', async () => {
    const t = trace(await chat(KEY_LOOSE));
    expect(t.strategy).toBe(H_CASCADE.slice(0, 8));
    expect(t.fallback).toBe('0');
  });

  it('the trace declares WHICH CLOCK the bound was evaluated against', async () => {
    // No served traffic yet → the harness number, explicitly provisional.
    // A policy that binds a benchmark to a customer's SLO without saying so is
    // the substitution this whole item exists to prevent.
    expect(trace(await chat(KEY_TIGHT)).latency_src).toBe('harness');
  });

  it('surfaces the COST PREMIUM the bound is charging, with a relax target', async () => {
    const t = trace(await chat(KEY_TIGHT));
    // (2.5 − 0.9) / 2.5 = 0.64
    expect(t.latency_premium).toBe('0.64');
    expect(Number(t.relax_ms)).toBeGreaterThanOrEqual(2100);
    // …and the relaxed policy genuinely reaches the cheaper point.
    expect(trace(await chat(KEY_LOOSE)).strategy).toBe(H_CASCADE.slice(0, 8));
  });

  it('emits NO premium marker when the bound is not costing anything', async () => {
    const t = trace(await chat(KEY_LOOSE));
    expect(t.latency_premium).toBeUndefined();
    expect(t.relax_ms).toBeUndefined();
    expect(t.latency_src).toBe('harness'); // src is ALWAYS present though
  });
});

// ---------------------------------------------------------------------------
// route parity — the "handled in one route is not handled" class
// ---------------------------------------------------------------------------

describe('the bound binds on EVERY serving route, not just chat', () => {
  it('/v1/completions selects identically and carries the same latency markers', async () => {
    const chatT = trace(await chat(KEY_TIGHT));
    const legacyT = trace(await legacyCompletions(KEY_TIGHT));
    expect(legacyT.strategy).toBe(chatT.strategy);
    expect(legacyT.policy).toBe('compound');
    expect(legacyT.latency_src).toBe(chatT.latency_src);
    expect(legacyT.latency_premium).toBe(chatT.latency_premium);
    expect(legacyT.relax_ms).toBe(chatT.relax_ms);
  });

  it('/v1/completions labels the violation too', async () => {
    const t = trace(await legacyCompletions(KEY_IMPOSSIBLE));
    expect(t.latency_violated).toBe('1');
  });
});

// ---------------------------------------------------------------------------
// serving-grade evidence
// ---------------------------------------------------------------------------

describe('serving-grade latency binding', () => {
  it('flips the selection once REAL traffic contradicts the benchmark', async () => {
    // The harness says the cascade is 2100ms and the loose 2500ms bound admits
    // it. Seed 40 served requests showing it is really 3400ms end-to-end.
    for (let i = 0; i < 40; i++) {
      await insertRequestLog(db(), {
        ts: new Date(Date.now() - 60_000),
        orgId: ORG_A,
        clusterId: 'code-gen',
        strategyHash: H_CASCADE,
        latencyMs: 3400,
        status: 'ok',
      });
    }
    clearServingLatencyCache();
    const t = trace(await chat(KEY_LOOSE));
    expect(t.latency_src).toBe('serving'); // measured, no longer provisional
    expect(t.strategy).toBe(H_STRONG.slice(0, 8)); // the cascade is now excluded
    // …and the premium appears, because the bound is now costing money.
    expect(t.latency_premium).toBeDefined();
  });

  it('another org’s traffic never moves this org’s bind (rollup is org-scoped)', async () => {
    for (let i = 0; i < 60; i++) {
      await insertRequestLog(db(), {
        ts: new Date(Date.now() - 60_000),
        orgId: ORG_B,
        clusterId: 'code-gen',
        strategyHash: H_STRONG,
        latencyMs: 99_000,
        status: 'ok',
      });
    }
    clearServingLatencyCache();
    // ORG_A's strong point has no serving rows, so it keeps its harness 1200ms
    // and stays inside the 1500ms bound. If org B's 99s leaked in, the bound
    // would admit nothing and this would be a violation.
    const t = trace(await chat(KEY_TIGHT));
    expect(t.latency_violated).toBeUndefined();
    expect(t.strategy).toBe(H_STRONG.slice(0, 8));
  });

  it('platform work (non-ok rows) never moves the customer’s p95', async () => {
    for (let i = 0; i < 60; i++) {
      await insertRequestLog(db(), {
        ts: new Date(Date.now() - 60_000),
        orgId: ORG_A,
        clusterId: 'code-gen',
        strategyHash: H_STRONG,
        latencyMs: 99_000,
        status: 'guarantee_judge',
      });
    }
    clearServingLatencyCache();
    expect(trace(await chat(KEY_TIGHT)).latency_violated).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// infeasibility: serve fastest QUALITY-qualifying, label it, raise ONE condition
// ---------------------------------------------------------------------------

describe('unmeetable bound — the labeled violation', () => {
  it('serves the FASTEST point that still meets the QUALITY floor', async () => {
    const res = await chat(KEY_IMPOSSIBLE);
    expect(res.statusCode).toBe(200); // never a refusal
    const t = trace(res);
    // The strong point (1200ms) is the fastest of the two above the 0.8 floor.
    // The cheap point is 300ms — four times faster and inside the bound — and
    // must still be refused: quality is the dimension the customer cannot
    // check for themselves.
    expect(t.strategy).toBe(H_STRONG.slice(0, 8));
    expect(t.strategy).not.toBe(H_CHEAP.slice(0, 8));
    expect(t.fallback).toBe('1');
  });

  it('labels the violation on the trace — never a silent SLO miss', async () => {
    expect(trace(await chat(KEY_IMPOSSIBLE)).latency_violated).toBe('1');
  });

  it('mints exactly ONE standing condition across many violating requests', async () => {
    for (let i = 0; i < 5; i++) await chat(KEY_IMPOSSIBLE);
    const open = (await listOpenPolicyConditions(db(), ORG_A)).filter(
      (r) => (r.detail as PolicyInfeasibleDetail).policyId === 'pol-impossible',
    );
    expect(open).toHaveLength(1);
    const d = open[0]!.detail as PolicyInfeasibleDetail;
    expect(d.condition).toBe('latency_bound_infeasible');
    expect(d.boundMs).toBe(400);
    expect(d.servedP95Ms).toBe(1200);
    // BOTH relaxation directions ride on the condition.
    expect(d.relaxLatencyToMs).toBeGreaterThanOrEqual(1200);
    expect(d.relaxQualityToFloor).toBeCloseTo(0.72, 5);
  });

  it('surfaces the condition on /api/guarantee/status with both relaxations', async () => {
    await chat(KEY_IMPOSSIBLE);
    const res = await app.inject({
      method: 'GET',
      url: '/api/guarantee/status',
      headers: { authorization: `Bearer ${KEY_ADMIN}` },
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json().infeasiblePolicies as Array<Record<string, unknown>>;
    const row = rows.find((r) => r.policyId === 'pol-impossible')!;
    expect(row).toBeDefined();
    expect(row.boundMs).toBe(400);
    expect(row.relaxLatencyToMs).not.toBeNull();
    expect(row.relaxQualityToFloor).not.toBeNull();
    expect(row.latencySource).toBeDefined();
    expect(typeof row.since).toBe('string');
  });

  it('a FEASIBLE policy raises nothing', async () => {
    await chat(KEY_TIGHT);
    const open = (await listOpenPolicyConditions(db(), ORG_A)).filter(
      (r) => (r.detail as PolicyInfeasibleDetail).policyId === 'pol-tight',
    );
    expect(open).toHaveLength(0);
  });

  it('auto-resolves the condition when the policy becomes feasible again', async () => {
    // Widen the bound past the served p95 — the same policy row, relaxed.
    await chat(KEY_IMPOSSIBLE);
    expect(
      (await listOpenPolicyConditions(db(), ORG_A)).filter(
        (r) => (r.detail as PolicyInfeasibleDetail).policyId === 'pol-impossible',
      ),
    ).toHaveLength(1);

    await db()
      .update((await import('@potion/db')).policies)
      .set({ config: compound(0.8, 5000) })
      .where((await import('drizzle-orm')).eq((await import('@potion/db')).policies.id, 'pol-impossible'));

    const t = trace(await chat(KEY_IMPOSSIBLE));
    expect(t.latency_violated).toBeUndefined();
    const open = (await listOpenPolicyConditions(db(), ORG_A)).filter(
      (r) => (r.detail as PolicyInfeasibleDetail).policyId === 'pol-impossible',
    );
    expect(open).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// the DTO — the developer's per-request surface
// ---------------------------------------------------------------------------

describe('GET /api/frontiers/:clusterId — operatingPoint', () => {
  it('carries latency evidence with its provenance, matching the serving bind', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/frontiers/code-gen',
      headers: { authorization: `Bearer ${KEY_TIGHT}` },
    });
    expect(res.statusCode).toBe(200);
    const op = res.json().operatingPoint as Record<string, unknown>;
    const ev = op.latencyEvidence as Record<string, unknown>;
    expect(ev).not.toBeNull();
    expect(['serving', 'harness']).toContain(ev.source);
    expect(typeof ev.n).toBe('number');
    expect(typeof ev.provisional).toBe('boolean');
    // The two sources measure different spans; the DTO says which.
    expect(['end-to-end', 'strategy-only']).toContain(ev.span);
  });

  it('the DTO premium AGREES with the trace premium (one computation, two surfaces)', async () => {
    const t = trace(await chat(KEY_TIGHT));
    const res = await app.inject({
      method: 'GET',
      url: '/api/frontiers/code-gen',
      headers: { authorization: `Bearer ${KEY_TIGHT}` },
    });
    const premium = (res.json().operatingPoint as Record<string, unknown>).latencyPremium as {
      savingsPct: number;
      binding: string;
      relaxLatencyToMs: number | null;
    };
    expect(premium.binding).toBe('latency');
    expect(premium.savingsPct.toFixed(2)).toBe(t.latency_premium);
    expect(Math.round(premium.relaxLatencyToMs!)).toBe(Number(t.relax_ms));
  });

  it('a non-latency policy gets a null premium (no phantom trade to report)', async () => {
    await insertPolicy(db(), {
      id: 'pol-plain',
      orgId: ORG_A,
      name: 'plain',
      config: { type: 'min_cost', qualityFloor: 0.8 },
    });
    await insertApiKey(db(), {
      id: 'key-plain',
      keyHash: sha256('pk_g26_plain'),
      name: 'plain',
      orgId: ORG_A,
      policyId: 'pol-plain',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/frontiers/code-gen',
      headers: { authorization: 'Bearer pk_g26_plain' },
    });
    const op = res.json().operatingPoint as Record<string, unknown>;
    expect(op.latencyPremium).toBeNull();
    expect(op.latencyViolation).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// the report — the policy owner's per-month surface
// ---------------------------------------------------------------------------

describe('guarantee report — realized latency premium', () => {
  it('prices the premium in DOLLARS against the period’s actual served volume', async () => {
    const today = new Date().toISOString().slice(0, 10);
    // 1000 served requests on the strong point at $0.0025 each.
    for (let i = 0; i < 20; i++) {
      await insertRequestLog(db(), {
        ts: new Date(),
        orgId: ORG_A,
        clusterId: 'code-gen',
        strategyHash: H_STRONG,
        policyId: 'pol-tight',
        status: 'ok',
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.0025, latencyMs: 1200 },
      });
    }
    const res = await app.inject({
      method: 'GET',
      url: `/api/reports/guarantee?from=${today}&to=${today}`,
      headers: { authorization: `Bearer ${KEY_ADMIN}` },
    });
    expect(res.statusCode).toBe(200);
    const sections = res.json().latencyPremiums as Array<Record<string, number | string>>;
    const s = sections.find((x) => x.policyId === 'pol-tight')!;
    expect(s).toBeDefined();
    // Earlier tests in this file also served under pol-tight, so the counts
    // are asserted as a RELATIONSHIP rather than a magic number — which is
    // the real claim anyway: the premium is actual minus the counterfactual
    // at the SAME volume, not a projection off a fixed sample.
    const requests = Number(s.requests);
    expect(requests).toBeGreaterThanOrEqual(20);
    expect(Number(s.actualSpendUsd)).toBeGreaterThanOrEqual(0.05 - 1e-9);
    // The counterfactual: the same volume on the PRUNED cascade at $0.9/1K.
    expect(Number(s.unboundedSpendUsd)).toBeCloseTo((requests / 1000) * 0.9, 9);
    expect(Number(s.premiumUsd)).toBeCloseTo(
      Number(s.actualSpendUsd) - Number(s.unboundedSpendUsd),
      9,
    );
    expect(Number(s.premiumUsd)).toBeGreaterThan(0); // the bound cost real money
    expect(Number(s.relaxLatencyToMs)).toBeGreaterThan(0);
    expect(Number(s.relaxQualityToFloor)).toBeGreaterThan(0);
  });

  it('renders the premium section in the HTML artifact, below the retention headline', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await app.inject({
      method: 'GET',
      url: `/api/reports/guarantee?from=${today}&to=${today}&format=html`,
      headers: { authorization: `Bearer ${KEY_ADMIN}` },
    });
    expect(res.statusCode).toBe(200);
    const html = res.body;
    expect(html).toContain('Latency premium');
    expect(html).toContain('Total realized premium');
    // The retention thesis stays the headline: the premium section comes after.
    const retentionAt = html.indexOf('Headline metric: baseline retention');
    const premiumAt = html.indexOf('Latency premium');
    expect(premiumAt).toBeGreaterThan(0);
    expect(premiumAt).toBeLessThan(retentionAt);
  });

  it('an org with no compound policy gets NO premium section (report unchanged)', async () => {
    const today = new Date().toISOString().slice(0, 10);
    await insertApiKey(db(), {
      id: 'key-b-admin-g26',
      keyHash: sha256('pk_g26_b_admin'),
      name: 'b-admin',
      orgId: ORG_B,
      scopes: 'serve+admin',
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/reports/guarantee?from=${today}&to=${today}`,
      headers: { authorization: 'Bearer pk_g26_b_admin' },
    });
    expect(res.json().latencyPremiums).toEqual([]);
    const html = await app.inject({
      method: 'GET',
      url: `/api/reports/guarantee?from=${today}&to=${today}&format=html`,
      headers: { authorization: 'Bearer pk_g26_b_admin' },
    });
    expect(html.body).not.toContain('Latency premium');
  });
});
