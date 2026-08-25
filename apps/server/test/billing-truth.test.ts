// BILLING TRUTH (SERVING-ROADMAP S3, legs 1 and 3) — migration 0039.
//
// The operator bills usage-based, moving to outcome-based (a share of money
// saved) later. BYOK is not offered, so every served request is funded by
// Potion — which makes the SECOND number the one billing actually lacked:
// "saved versus what?" has no answer unless the counterfactual was recorded
// at serve time, and it cannot be reconstructed afterwards because the price
// table and the frontier both drift.
//
// The assertions that matter most are the ones about ABSENCE. A billing
// system's characteristic failure is not arithmetic — it is confidently
// summing rows whose provenance it does not actually know. So: a request that
// never executed must not be attributed to anyone, and an undefined
// comparison must come back null rather than as a zero that would enter a
// savings sum as "saved nothing".
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { createOrg, usageDaily } from '@potion/db';
import { generateInvoice } from '../src/billing/invoice.js';
import { baselineCostUsd } from '../src/routes/chat.js';
import type { Frontier, FrontierPoint } from '@potion/core';

// ---------------------------------------------------------------- unit ----

function pt(over: Partial<FrontierPoint>): FrontierPoint {
  return {
    clusterId: 'code-gen',
    strategyHash: 'h1',
    strategyConfig: { type: 'single', model: 'm' },
    quality: 0.9,
    costPer1K: 1,
    latencyP95: 800,
    providerMode: 'live',
    ...over,
  } as FrontierPoint;
}
function frontierOf(points: FrontierPoint[]): Frontier {
  return {
    id: 'f',
    clusterId: 'code-gen',
    version: 1,
    parentId: null,
    trigger: 'manual',
    points,
    pricesVersion: 'v1',
    createdAt: new Date(0).toISOString(),
  };
}

describe('baselineCostUsd — what it would have cost to just use the best model', () => {
  const cheap = pt({ strategyHash: 'cheap', quality: 0.85, costPer1K: 1 });
  const best = pt({ strategyHash: 'best', quality: 0.99, costPer1K: 4 });

  it('scales the REAL cost by the measured ratio between the two points', () => {
    // Chosen is 1/4 the cost of best, so a $0.01 request would have been
    // $0.04. Scaling the real cost (rather than reading best.costPer1K
    // directly) keeps both sides on the same measurement basis.
    expect(baselineCostUsd(frontierOf([cheap, best]), 'cheap', 0.01)).toBeCloseTo(0.04, 12);
  });

  it('is EQUAL to actual when the best point was the one served — savings 0, not negative', () => {
    expect(baselineCostUsd(frontierOf([cheap, best]), 'best', 0.04)).toBeCloseTo(0.04, 12);
  });

  it('scales with request size, so a big request shows a proportionally big saving', () => {
    const small = baselineCostUsd(frontierOf([cheap, best]), 'cheap', 0.001)!;
    const large = baselineCostUsd(frontierOf([cheap, best]), 'cheap', 0.1)!;
    expect(large / small).toBeCloseTo(100, 6);
  });

  it('returns NULL, never 0, when the comparison is undefined', () => {
    // Zero would enter a savings sum as "saved nothing", which is a claim.
    // Null reads as "not measured", which is the truth.
    expect(baselineCostUsd(null, 'cheap', 0.01)).toBeNull(); // no frontier (fallback path)
    expect(baselineCostUsd(frontierOf([]), 'cheap', 0.01)).toBeNull(); // empty frontier
    expect(baselineCostUsd(frontierOf([cheap]), 'unknown-hash', 0.01)).toBeNull(); // point not on it
    expect(baselineCostUsd(frontierOf([cheap, best]), 'cheap', undefined)).toBeNull(); // no cost
    expect(baselineCostUsd(frontierOf([pt({ strategyHash: 'z', costPer1K: 0 })]), 'z', 0.01)).toBeNull();
  });
});

// ------------------------------------------------------------ end to end ----

let app: FastifyInstance;
let cookie: string;
let apiKey: string;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ['POTION_SELF_SERVE', 'POTION_MAGIC_LINK_IN_RESPONSE', 'POTION_DEV_AUTH']) {
    saved[k] = process.env[k];
  }
  process.env.POTION_SELF_SERVE = '1';
  process.env.POTION_MAGIC_LINK_IN_RESPONSE = '1';
  process.env.POTION_DEV_AUTH = '0';
  app = await buildServer({ seed: false, platformBaseline: true });

  const signup = await app.inject({
    method: 'POST',
    url: '/auth/request-link',
    headers: { 'content-type': 'application/json' },
    payload: { email: 'billing@startup.test' },
  });
  const token = new URL(signup.json().devLink as string).searchParams.get('token')!;
  const verify = await app.inject({ method: 'GET', url: `/auth/verify?token=${encodeURIComponent(token)}` });
  cookie = String(verify.headers['set-cookie'] ?? '').split(';')[0]!;
  const created = await app.inject({
    method: 'POST',
    url: '/api/policies',
    headers: { cookie, 'content-type': 'application/json' },
    payload: { policy: { type: 'min_cost', qualityFloor: 0.8 }, createKey: true },
  });
  apiKey = created.json().apiKey as string;
}, 120_000);

afterAll(async () => {
  await app?.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function servedRows(): Promise<Array<Record<string, unknown>>> {
  const res = await app.potion.db.db.execute(
    "select status, paid_by, baseline_cost_usd, (usage->>'costUsd')::float8 as cost_usd " +
      'from request_logs order by id desc limit 50',
  );
  return (res.rows ?? []) as Array<Record<string, unknown>>;
}

describe('every served request records WHAT FUNDED IT and WHAT IT SAVED', () => {
  it('a platform-served request is attributed to the platform and carries a baseline', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: {
        model: 'potion-auto',
        messages: [{ role: 'user', content: 'Write a Python function that merges two sorted lists.' }],
      },
    });
    expect(res.statusCode).toBe(200);

    const row = (await servedRows()).find((r) => r.status === 'ok')!;
    expect(row, 'no served row was logged').toBeTruthy();
    // This org brought no key, so Potion's key funded it — the billable case.
    expect(row.paid_by).toBe('platform');
    // …and the counterfactual is present and at least the actual cost (the
    // best-quality point is never cheaper than the point min_cost selected).
    expect(row.baseline_cost_usd).not.toBeNull();
    expect(Number(row.baseline_cost_usd)).toBeGreaterThanOrEqual(Number(row.cost_usd));
  }, 60_000);

  it('a request that never EXECUTED is attributed to nobody', async () => {
    // A rejected key costs no one anything. Recording it as platform-paid
    // would put un-served traffic on an invoice.
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer pk_not_a_real_key', 'content-type': 'application/json' },
      payload: { model: 'potion-auto', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(bad.statusCode).toBe(401);
    const row = (await servedRows()).find((r) => r.status === 'auth_failed')!;
    expect(row).toBeTruthy();
    expect(row.paid_by).toBeNull();
  });

  it('the rollup carries the counterfactual alongside COGS', async () => {
    // BYOK is no longer offered, so there is no funding source to separate —
    // every served request is ours. What the rollup must carry for pricing is
    // the BASELINE: the outcome-pricing numerator, summed only over rows that
    // actually recorded one so partial coverage under-reports rather than
    // inventing a saving.
    const { aggregateUsage, sumRollup, utcDay } = await import('@potion/db');
    const day = utcDay();
    const rows = await aggregateUsage(app.potion.db.db, { fromDay: day, toDay: day });
    const totals = sumRollup(rows);

    expect(totals.costUsd).toBeGreaterThan(0);
    expect(totals.baselineCostUsd).toBeGreaterThan(0);
    // Routing never costs MORE than always using the best model, so the
    // counterfactual is an upper bound on what we actually spent.
    expect(totals.baselineCostUsd).toBeGreaterThanOrEqual(totals.costUsd);
  }, 60_000);
});

// ---- pricing v2 (operator decision 2026-08-25): verified-savings share ----
describe('pricing v2: at cost plus a share of verified savings', () => {
  it('the share is computed from the recorded counterfactual, and the customer always nets positive', async () => {
    const db = app.potion.db.db;
    await createOrg(db, { id: 'org-v2price', name: 'V2 Price Co' });
    // A rolled-up day where routing verifiably saved money: baseline $10, cost $2.
    await db.insert(usageDaily).values({
      orgId: 'org-v2price', day: '2026-08-03', clusterId: 'code-gen',
      requests: 100, inputTokens: 1000, outputTokens: 2000,
      costUsd: 2, platformCostUsd: 2, baselineCostUsd: 10,
    });
    // And a day with no baseline coverage: contributes cost, zero claimed savings.
    await db.insert(usageDaily).values({
      orgId: 'org-v2price', day: '2026-08-04', clusterId: 'extraction',
      requests: 10, inputTokens: 100, outputTokens: 200,
      costUsd: 1, platformCostUsd: 1, baselineCostUsd: 0,
    });
    const inv = await generateInvoice(db, 'org-v2price', '2026-08');
    expect(inv.pricingModel).toBe('at-cost-plus-verified-savings-share');
    expect(inv.savingsSharePct).toBe(25);
    expect(inv.totals.platformCostUsd).toBe(3);
    expect(inv.totals.verifiedSavedUsd).toBe(8); // max(0, 10-2) + max(0, 0-1)
    expect(inv.totals.savingsShareUsd).toBe(2); // 25% of 8
    expect(inv.totals.totalUsd).toBe(5); // cost 3 + share 2
    // The alignment property: what the customer pays is always less than
    // cost-without-Potion (baseline) on covered traffic.
    expect(inv.totals.totalUsd).toBeLessThan(10 + 1);
    // share=0 degrades to v1 pass-through exactly.
    const v1 = await generateInvoice(db, 'org-v2price', '2026-08', { savingsSharePct: 0 });
    expect(v1.pricingModel).toBe('pass-through-plus-margin');
    expect(v1.totals.totalUsd).toBe(3);
  });
});
