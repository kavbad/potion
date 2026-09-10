// Billing tests (M2 Wave 2, ROADMAP #18): invoice JSON shape + totals to
// the cent (hand-computed), margin math, HTML render, backends, and the
// /api/usage/invoice route.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256 } from '@potion/core';
import { insertApiKey, insertRequestLog, usageDaily } from '@potion/db';
import { ORG_A, ORG_A_NAME, seedIsolationOrgs } from './fixtures/orgs.js';
import { buildServer } from '../src/server.js';
import { generateInvoice, toCents } from '../src/billing/invoice.js';
import { renderInvoiceHtml } from '../src/billing/render-html.js';
import {
  JsonFileBillingBackend,
  StripeBillingBackend,
  resolveBillingBackend,
} from '../src/billing/backend.js';

// ORG_A comes from the shared isolation fixture — binding a subject org to
// the DEFAULT org is the assumption that hid tenancy defect D1.
const RAW_A = 'pk_billing_org_a';

let app: FastifyInstance;
const db = () => app.potion.db.db;
// The invoice id is derived from the ORG, so it follows the fixture rather
// than naming the default org the subject used to be.
const INVOICE_ID = `inv_${ORG_A}_2026-08`;

beforeAll(async () => {
  app = await buildServer({ seed: false });
  // ORG_A is a real, non-default org and has to be created before anything
  // is hung off it — which is the point of not reusing the default.
  await seedIsolationOrgs(db());
  await insertApiKey(db(), { id: 'key-billing-a', keyHash: sha256(RAW_A), name: 'a', orgId: ORG_A });

  // usage_daily rows for ORG_A, period 2026-08 (hand math below):
  //   code-gen:   2026-08-01 $0.10 (2 req, 100/50 tok) + 2026-08-02 $0.05 (1 req, 50/25)
  //   extraction: 2026-08-01 $0.08 (4 req, 400/200)
  //   outside:    2026-09-01 $7.77 (excluded from the 2026-08 invoice)
  await db()
    .insert(usageDaily)
    .values([
      { orgId: ORG_A, day: '2026-08-01', clusterId: 'code-gen', requests: 2, inputTokens: 100, outputTokens: 50, costUsd: 0.1, platformCostUsd: 0.1 },
      { orgId: ORG_A, day: '2026-08-02', clusterId: 'code-gen', requests: 1, inputTokens: 50, outputTokens: 25, costUsd: 0.05, platformCostUsd: 0.05 },
      { orgId: ORG_A, day: '2026-08-01', clusterId: 'extraction', requests: 4, inputTokens: 400, outputTokens: 200, costUsd: 0.08, platformCostUsd: 0.08 },
      { orgId: ORG_A, day: '2026-09-01', clusterId: 'code-gen', requests: 9, inputTokens: 900, outputTokens: 900, costUsd: 7.77, platformCostUsd: 7.77 },
    ]);

  // one live request_log so the invoice ROUTE's rollup refresh has data too
  await insertRequestLog(db(), {
    ts: new Date('2026-08-03T10:00:00Z'),
    orgId: ORG_A,
    clusterId: 'code-gen',
    status: 'ok',
    usage: { inputTokens: 5, outputTokens: 5, costUsd: 0.0005, latencyMs: 1 },
  });
}, 90_000);

afterAll(async () => {
  await app.close();
});

// 0086: every invoice states its verified-savings basis. These fixtures
// have no incumbents/holdout, so the block is honestly 'off'/'no-incumbent'
// and every cent matches the pre-0086 hand math.
const BASIS = { prices: { version: 'test', updatedAt: '', entries: [] }, providerMode: 'mock' as const };

describe('generateInvoice (hand-computed to the cent)', () => {
  it('default margin 0: pass-through, line items per cluster, exact totals', async () => {
    const inv = await generateInvoice(db(), ORG_A, '2026-08', BASIS);
    expect(inv).toMatchObject({
      id: INVOICE_ID,
      object: 'potion.invoice',
      orgId: ORG_A,
      org: { id: ORG_A, name: ORG_A_NAME },
      period: '2026-08',
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
      currency: 'usd',
      // Default is pricing v2 (2026-08-25); with no recorded baselines the
      // share is $0 and every total below is identical to v1 pass-through.
      pricingModel: 'at-cost-plus-verified-savings-share',
      marginPct: 0,
      savingsSharePct: 25,
    });
    // lines sorted by clusterId; 2026-09 row excluded
    expect(inv.lineItems.map((l) => l.clusterId)).toEqual(['code-gen', 'extraction']);
    const [cg, ex] = inv.lineItems;
    expect(cg).toMatchObject({
      requests: 3, inputTokens: 150, outputTokens: 75,
      platformCostUsd: 0.15, marginUsd: 0, totalUsd: 0.15,
    });
    expect(cg!.stripe).toMatchObject({ currency: 'usd', quantity: 3, amountCents: 15 });
    expect(ex).toMatchObject({
      requests: 4, inputTokens: 400, outputTokens: 200,
      platformCostUsd: 0.08, marginUsd: 0, totalUsd: 0.08,
    });
    expect(inv.totals).toEqual({
      requests: 7, inputTokens: 550, outputTokens: 275,
      platformCostUsd: 0.23, marginUsd: 0,
      // projectedBasis (0089 read side): these fixtures carry no baseline
      // basis, so the invoice says so rather than implying an incumbent.
      projectedSavedUsd: 0, projectedBasis: null, savingsShareUsd: 0, totalUsd: 0.23,
    });
  });

  it('margin 10%: integer-cent rounding per line, totals = sum of lines', async () => {
    // hand math: code-gen platform 15c → margin round(1.5)=2c → 17c
    //            extraction platform 8c → margin round(0.8)=1c → 9c
    //            totals: platform 23c, margin 3c, total 26c
    const inv = await generateInvoice(db(), ORG_A, '2026-08', BASIS, { marginPct: 10 });
    expect(inv.marginPct).toBe(10);
    const [cg, ex] = inv.lineItems;
    expect(cg).toMatchObject({ platformCostUsd: 0.15, marginUsd: 0.02, totalUsd: 0.17 });
    expect(cg!.stripe.amountCents).toBe(17);
    expect(ex).toMatchObject({ platformCostUsd: 0.08, marginUsd: 0.01, totalUsd: 0.09 });
    expect(inv.totals).toMatchObject({ platformCostUsd: 0.23, marginUsd: 0.03, totalUsd: 0.26 });
    // to-the-cent invariant: totals are exactly the sums of the line cents
    const lineTotalCents = inv.lineItems.reduce((s, l) => s + toCents(l.totalUsd), 0);
    expect(toCents(inv.totals.totalUsd)).toBe(lineTotalCents);
  });

  it('G2.1 relabel: a cost-only line (0 requests) reads scoring & evaluation, not routed requests', async () => {
    // September has request rows only for code-gen; add a cost-only cluster
    // (guarantee judging / eval sweeps roll up with requests: 0).
    await db()
      .insert(usageDaily)
      .values([{ orgId: ORG_A, day: '2026-09-02', clusterId: 'agent-x-billing', requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0.5, platformCostUsd: 0.5 }]);
    const inv = await generateInvoice(db(), ORG_A, '2026-09', BASIS);
    const costOnly = inv.lineItems.find((l) => l.clusterId === 'agent-x-billing')!;
    expect(costOnly.description).toContain('Potion scoring & evaluation services');
    expect(costOnly.description).not.toContain('routed requests');
    const served = inv.lineItems.find((l) => l.clusterId === 'code-gen')!;
    expect(served.description).toContain('Potion routed requests');
  });

  it('rejects unknown orgs and malformed periods', async () => {
    await expect(generateInvoice(db(), 'org_nope', '2026-08', BASIS)).rejects.toThrow("unknown org");
    await expect(generateInvoice(db(), ORG_A, '2026-13', BASIS)).rejects.toThrow();
    await expect(generateInvoice(db(), ORG_A, '2026/08', BASIS)).rejects.toThrow();
  });
});

describe('renderInvoiceHtml', () => {
  it('renders a print-friendly standalone HTML invoice', async () => {
    const inv = await generateInvoice(db(), ORG_A, '2026-08', BASIS, { marginPct: 10 });
    const html = renderInvoiceHtml(inv);
    expect(html).toContain('<!doctype html>');
    expect(html).toContain(`Invoice ${INVOICE_ID}`);
    expect(html).toContain(ORG_A_NAME);
    expect(html).toContain("Potion routed requests — cluster 'code-gen' (2026-08)");
    expect(html).toContain('@media print');
    expect(html).toContain('Total due');
    expect(html).toContain('$0.26'); // grand total with margin
    expect(html).toContain('margin 10%');
  });
});

describe('BillingBackend', () => {
  it('json-file backend writes invoice .json + .html', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'potion-invoices-'));
    try {
      const inv = await generateInvoice(db(), ORG_A, '2026-08', BASIS);
      const html = renderInvoiceHtml(inv);
      const { ref } = await new JsonFileBillingBackend(dir).saveInvoice(inv, html);
      expect(ref).toBe(join(dir, `${INVOICE_ID}.json`));
      const parsed = JSON.parse(readFileSync(ref, 'utf8'));
      expect(parsed.totals.totalUsd).toBe(0.23);
      expect(readFileSync(join(dir, `${INVOICE_ID}.html`), 'utf8')).toContain('Total due');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('G2.1: saveReport writes <id>.json + .html next to the invoices', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'potion-reports-'));
    try {
      const { ref } = await new JsonFileBillingBackend(dir).saveReport(
        'org_demo-2026-08-guarantee',
        { orgId: 'org_demo', entries: [] },
        '<html>report</html>',
      );
      expect(ref).toBe(join(dir, 'org_demo-2026-08-guarantee.json'));
      expect(JSON.parse(readFileSync(ref, 'utf8')).orgId).toBe('org_demo');
      expect(readFileSync(join(dir, 'org_demo-2026-08-guarantee.html'), 'utf8')).toContain('report');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stripe backend is a stub that throws a TODO (no live Stripe in Wave 2)', () => {
    expect(() => new StripeBillingBackend()).toThrow(/TODO\(#18\)/);
    expect(() => resolveBillingBackend('stripe')).toThrow(/TODO\(#18\)/);
    expect(resolveBillingBackend('json-file')).toBeInstanceOf(JsonFileBillingBackend);
  });
});

describe('GET /api/usage/invoice', () => {
  it('returns the Stripe-ready invoice JSON (refreshing the rollup first)', async () => {
    // the live request_log for 2026-08-03 ($0.0005) rolls up: code-gen
    // platform becomes $0.1505 → 15c after cent rounding; totals stay stable.
    const res = await app.inject({
      method: 'GET',
      url: '/api/usage/invoice?period=2026-08&margin_pct=10',
      headers: { authorization: `Bearer ${RAW_A}` },
    });
    expect(res.statusCode).toBe(200);
    const inv = res.json();
    expect(inv).toMatchObject({ id: INVOICE_ID, orgId: ORG_A, marginPct: 10 });
    expect(inv.lineItems).toHaveLength(2);
    expect(toCents(inv.totals.totalUsd)).toBe(
      inv.lineItems.reduce((s: number, l: { totalUsd: number }) => s + toCents(l.totalUsd), 0),
    );
    expect(inv.totals.requests).toBe(8); // 7 seeded + 1 live
  });

  it('format=html returns the rendered invoice', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/usage/invoice?period=2026-08&format=html',
      headers: { authorization: `Bearer ${RAW_A}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain(`Invoice ${INVOICE_ID}`);
  });

  it('validates the period param', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/usage/invoice?period=august',
      headers: { authorization: `Bearer ${RAW_A}` },
    });
    expect(res.statusCode).toBe(400);
  });
});

// 0089's READ SIDE (2026-09-06). usage_daily rolls up baseline_cost_usd and
// drops baseline_basis, so an invoice could state a projected-savings figure
// without saying what it was measured against. Those are different claims:
// against a NAMED incumbent the number is reproducible by the customer;
// against best-of-frontier it is a counterfactual versus the priciest
// measured option, which was never their alternative. A design partner was
// handed the second and asked to reconcile it as if it were the first.
describe('projected savings name their comparator', () => {
  const ORG_B = 'org-basis';
  const PERIOD = '2026-07';

  beforeAll(async () => {
    const { createOrg } = await import('@potion/db');
    await createOrg(db(), { id: ORG_B, name: 'Basis' });
    await db().insert(usageDaily).values([
      { orgId: ORG_B, day: '2026-07-01', clusterId: 'code-gen', requests: 2, inputTokens: 100, outputTokens: 50, costUsd: 0.1, platformCostUsd: 0.1, baselineCostUsd: 0.5 },
      { orgId: ORG_B, day: '2026-07-01', clusterId: 'extraction', requests: 1, inputTokens: 50, outputTokens: 25, costUsd: 0.05, platformCostUsd: 0.05, baselineCostUsd: 0.2 },
    ]);
    // code-gen was compared against a NAMED incumbent; extraction had none,
    // so its "savings" are against the frontier's premium point.
    await insertRequestLog(db(), {
      ts: new Date('2026-07-02T10:00:00Z'), orgId: ORG_B, clusterId: 'code-gen', status: 'ok',
      baselineBasis: 'org-incumbent',
      usage: { inputTokens: 5, outputTokens: 5, costUsd: 0.0005, latencyMs: 1 },
    });
    await insertRequestLog(db(), {
      ts: new Date('2026-07-02T10:01:00Z'), orgId: ORG_B, clusterId: 'extraction', status: 'ok',
      baselineBasis: 'best-of-frontier',
      usage: { inputTokens: 5, outputTokens: 5, costUsd: 0.0005, latencyMs: 1 },
    });
  }, 60_000);

  it('labels each line with the basis its savings were computed against', async () => {
    const inv = await generateInvoice(db(), ORG_B, PERIOD, BASIS);
    const line = (c: string) => inv.lineItems.find((l) => l.clusterId === c)!;
    expect(line('code-gen').projectedBasis).toBe('org-incumbent');
    expect(
      line('extraction').projectedBasis,
      'a savings figure with no named incumbent must say so, not read as "what you saved"',
    ).toBe('best-of-frontier');
  });

  it("says 'mixed' rather than picking whichever basis sorted first", async () => {
    const inv = await generateInvoice(db(), ORG_B, PERIOD, BASIS);
    expect(inv.totals.projectedBasis).toBe('mixed');
  });
});
