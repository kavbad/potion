// R0 (2026-08-24): the charge path, exercised end to end WITHOUT a Stripe
// account. The invariants that matter are the ones that protect a customer's
// money: a period cannot be billed twice, an unsigned webhook cannot mark
// anything paid, a ledger charge cannot masquerade as collected, and the
// figure we show equals the figure we would charge — to the cent.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHmac } from 'node:crypto';
import { sha256 } from '@potion/core';
import { createOrg, getInvoiceCharge, insertApiKey, upsertBillingCustomer } from '@potion/db';
import { buildServer } from '../src/server.js';
import { LedgerPaymentsTransport, StripePaymentsTransport, verifyStripeSignature } from '../src/billing/payments.js';
import { PRICING_MODEL_V2, type Invoice } from '../src/billing/invoice.js';
import type { VerifiedSavings } from '../src/verified-savings.js';

/**
 * A COMPLETE Invoice for the transport tests. chargeInvoice reads only
 * `id`, `period`, `currency` and `totals.totalUsd`, but the record is spelled
 * out in full so the fixture is checked against the real shape rather than
 * asserted past it.
 */
const NOT_VERIFIED: VerifiedSavings = {
  status: 'off',
  holdoutRate: null,
  incumbentModel: null,
  holdoutRequests: 0,
  minHoldoutRequests: 30,
  routedRequests: 0,
  routedSpendUsd: 0,
  meanIncumbentCostUsd: null,
  meanCi95: null,
  withoutPotionUsd: null,
  verifiedSavingsUsd: null,
  verifiedSavingsLowerUsd: null,
};

function invoiceFixture(over: { id: string; orgId?: string; period?: string; totalUsd: number }): Invoice {
  const orgId = over.orgId ?? 'org-abc';
  const p = over.period ?? '2026-08';
  return {
    id: over.id,
    object: 'potion.invoice',
    orgId,
    org: { id: orgId, name: 'Billing Co' },
    period: p,
    periodStart: `${p}-01T00:00:00.000Z`,
    periodEnd: `${p}-28T23:59:59.999Z`,
    currency: 'usd',
    pricingModel: PRICING_MODEL_V2,
    marginPct: 0,
    savingsSharePct: 0,
    lineItems: [],
    verified: NOT_VERIFIED,
    savingsShareLine: null,
    totals: {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      platformCostUsd: 0,
      marginUsd: 0,
      projectedSavedUsd: 0,
      // The basis the projection was formed on (ported 2026-09-10); null is
      // the honest value for a zero invoice with nothing to attribute.
      projectedBasis: null,
      savingsShareUsd: 0,
      totalUsd: over.totalUsd,
    },
    generatedAt: '2026-09-01T00:00:00.000Z',
  };
}

const ORG = 'org-billing';
const ADMIN_KEY = 'pk_billing_admin';
const SERVE_KEY = 'pk_billing_serve';
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer({ seed: false });
  const db = app.potion.db.db;
  await createOrg(db, { id: ORG, name: 'Billing Co' });
  await insertApiKey(db, { id: 'key-bill-admin', keyHash: sha256(ADMIN_KEY), name: 'admin', orgId: ORG, scopes: 'serve+admin' });
  await insertApiKey(db, { id: 'key-bill-serve', keyHash: sha256(SERVE_KEY), name: 'serve', orgId: ORG, scopes: 'serve' });
});
afterAll(async () => {
  await app.close();
});

const admin = { authorization: `Bearer ${ADMIN_KEY}` };
const period = `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, '0')}`;

describe('the charge path, before an account exists', () => {
  it('the ledger transport is what an unconfigured server selects', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/billing', headers: admin });
    expect(res.statusCode).toBe(200);
    expect(res.json().transport).toBe('ledger');
  });

  it('what we SHOW equals what we would CHARGE, to the cent', async () => {
    const billing = (await app.inject({ method: 'GET', url: '/api/billing', headers: admin })).json();
    const invoice = (await app.inject({ method: 'GET', url: `/api/invoices/${period}`, headers: admin })).json().invoice;
    // the dashboard figure is the invoice figure, not a parallel estimate
    expect(billing.current.totalUsd).toBe(invoice.totals.totalUsd);
    expect(billing.current.requests).toBe(invoice.totals.requests);
    // and the invoice's own lines sum to its total, in integer cents
    const lineCents = invoice.lineItems.reduce((a: number, l: { totalUsd: number }) => a + Math.round(l.totalUsd * 100), 0);
    expect(lineCents).toBe(Math.round(invoice.totals.totalUsd * 100));
  });

  it('a malformed period is refused rather than guessed at', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/invoices/august', headers: admin });
    expect(res.statusCode).toBe(400);
  });

  it('a serve-scoped key may not start checkout or charge', async () => {
    const serve = { authorization: `Bearer ${SERVE_KEY}` };
    expect((await app.inject({ method: 'POST', url: '/api/billing/payment-method', headers: serve, payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/billing/charge/${period}`, headers: serve })).statusCode).toBe(403);
  });

  it('charging without a payment method refuses instead of failing silently', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/billing/charge/${period}`, headers: admin });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/no payment method/i);
  });

  it('a ledger charge records intent and NEVER claims to be paid', async () => {
    const db = app.potion.db.db;
    await upsertBillingCustomer(db, { orgId: ORG, customerId: 'local_cus_test', transport: 'ledger', status: 'active' });
    const res = await app.inject({ method: 'POST', url: `/api/billing/charge/${period}`, headers: admin });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('recorded'); // not 'paid'
    const row = await getInvoiceCharge(db, ORG, period);
    expect(row?.status).toBe('recorded');
    expect(row?.transport).toBe('ledger');
  });

  it('THE MONEY INVARIANT: a period cannot be charged twice', async () => {
    const db = app.potion.db.db;
    const before = await getInvoiceCharge(db, ORG, period);
    await app.inject({ method: 'POST', url: `/api/billing/charge/${period}`, headers: admin });
    const after = await getInvoiceCharge(db, ORG, period);
    expect(after?.id).toBe(before?.id); // same row, updated — never a second charge
    const all = (await app.inject({ method: 'GET', url: '/api/billing', headers: admin })).json().charges;
    expect(all.filter((c: { period: string }) => c.period === period)).toHaveLength(1);
  });

  it('an unsigned webhook cannot mark anything paid', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      payload: { id: 'evt_1', type: 'payment_intent.succeeded', data: { object: { id: 'local_ch_x' } } },
    });
    expect(res.statusCode).toBe(400);
    const row = await getInvoiceCharge(app.potion.db.db, ORG, period);
    expect(row?.status).toBe('recorded'); // untouched
  });
});

describe('stripe signature verification', () => {
  const secret = 'whsec_test';
  const body = '{"id":"evt_2","type":"payment_intent.succeeded"}';
  const sign = (t: number): string => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

  it('accepts a fresh, correctly signed body', () => {
    const now = 1_700_000_000;
    expect(verifyStripeSignature(body, sign(now), secret, 300, now)).toBe(true);
  });

  it('rejects a tampered body, a wrong secret, and a missing header', () => {
    const now = 1_700_000_000;
    expect(verifyStripeSignature(`${body} `, sign(now), secret, 300, now)).toBe(false);
    expect(verifyStripeSignature(body, sign(now), 'whsec_other', 300, now)).toBe(false);
    expect(verifyStripeSignature(body, undefined, secret, 300, now)).toBe(false);
  });

  it('rejects a REPLAY: validly signed but outside the tolerance window', () => {
    const then = 1_700_000_000;
    expect(verifyStripeSignature(body, sign(then), secret, 300, then + 3600)).toBe(false);
  });
});

describe('the ledger transport itself', () => {
  it('cannot charge: it reports recorded, with a local_ id nothing can mistake for Stripe', async () => {
    const t = new LedgerPaymentsTransport();
    const r = await t.chargeInvoice('local_cus_x', invoiceFixture({ id: 'inv_1', totalUsd: 12.34 }));
    expect(r.status).toBe('recorded');
    expect(r.externalId.startsWith('local_')).toBe(true);
    expect(t.verifyWebhook()).toBeNull();
  });
});

describe('a REAL signed webhook survives the raw-body path', () => {
  // Separate server: paymentsFromEnv must select the Stripe transport, and
  // the signature must verify over the RAW bytes fastify received — the
  // exact thing a parsed-then-restringified body breaks (key order).
  let app2: FastifyInstance;
  const secret = 'whsec_rawbody_test';
  beforeAll(async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_neverdialled';
    process.env.STRIPE_WEBHOOK_SECRET = secret;
    app2 = await buildServer({ seed: false });
  });
  afterAll(async () => {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    await app2.close();
  });

  it('accepts the signed raw body — including whitespace no re-stringify would reproduce', async () => {
    const raw = '{ "id": "evt_raw",   "type": "payment_intent.succeeded", "data": { "object": { "id": "pi_raw" } } }';
    const t = Math.floor(Date.now() / 1000);
    const sig = `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`;
    const res = await app2.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': sig },
      payload: raw,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
  });

  it('refuses a tampered byte even with a fresh timestamp', async () => {
    const raw = '{"id":"evt_raw2","type":"payment_intent.succeeded"}';
    const t = Math.floor(Date.now() / 1000);
    const sig = `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`;
    const res = await app2.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': sig },
      payload: raw.replace('evt_raw2', 'evt_evil'),
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---- the three integration bugs the 2026-08-25 external review found ------
//
// All three would have surfaced only on the day a real key was pasted:
// setup-mode Checkout without currency; a completion webhook reading
// client_reference_id nothing set; an off-session confirm with no
// payment_method (which hunts the legacy default_source Checkout never
// creates). Pinned here against a scripted fetch so they stay fixed.
describe('stripe transport sends what the live API actually needs', () => {
  function scripted(responses: Array<{ ok: boolean; body: unknown }>): { fetch: typeof fetch; calls: Array<{ url: string; init?: RequestInit | undefined }> } {
    const calls: Array<{ url: string; init?: RequestInit | undefined }> = [];
    const fetchImpl = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(url), init });
      const r = responses.shift() ?? { ok: true, body: {} };
      return { ok: r.ok, status: r.ok ? 200 : 402, json: async () => r.body } as Response;
    }) as typeof fetch;
    return { fetch: fetchImpl, calls };
  }

  it('startCheckout carries currency and client_reference_id', async () => {
    const { fetch: f, calls } = scripted([{ ok: true, body: { id: 'cs_1', url: 'https://checkout' } }]);
    const t = new StripePaymentsTransport('sk_test_x', undefined, f);
    await t.startCheckout('cus_1', 'https://app/settings/billing', 'org-abc');
    const form = new URLSearchParams(String(calls[0]!.init?.body));
    expect(form.get('mode')).toBe('setup');
    expect(form.get('currency')).toBe('usd');
    expect(form.get('client_reference_id')).toBe('org-abc');
  });

  it('chargeInvoice names the payment method it found on the customer', async () => {
    const { fetch: f, calls } = scripted([
      { ok: true, body: { data: [{ id: 'pm_42' }] } },
      { ok: true, body: { id: 'pi_1', status: 'succeeded' } },
    ]);
    const t = new StripePaymentsTransport('sk_test_x', undefined, f);
    const r = await t.chargeInvoice('cus_1', invoiceFixture({ id: 'inv_9', orgId: 'org-abc', period: '2026-08', totalUsd: 10 }));
    expect(r.status).toBe('paid');
    expect(calls[0]!.url).toContain('/customers/cus_1/payment_methods?type=card');
    const form = new URLSearchParams(String(calls[1]!.init?.body));
    expect(form.get('payment_method')).toBe('pm_42');
    expect(form.get('off_session')).toBe('true');
  });

  it('chargeInvoice fails honestly when no card is on file — no blind confirm', async () => {
    const { fetch: f, calls } = scripted([{ ok: true, body: { data: [] } }]);
    const t = new StripePaymentsTransport('sk_test_x', undefined, f);
    const r = await t.chargeInvoice('cus_1', invoiceFixture({ id: 'inv_9', orgId: 'org-abc', period: '2026-08', totalUsd: 10 }));
    expect(r.status).toBe('failed');
    expect(r.error).toContain('no card payment method');
    expect(calls.length).toBe(1); // never attempted the PaymentIntent
  });
});
