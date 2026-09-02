// R0 — the customer's side of money (2026-08-24).
//
//   GET  /api/billing                what this period costs so far, the card
//                                    on file, and every past charge
//   GET  /api/invoices/:period       the invoice itself, to the cent
//   POST /api/billing/payment-method (admin) a hosted page to add a card
//   POST /webhooks/stripe            signature-verified settlement
//
// Every route works today under the 'ledger' transport, which records
// intentions and takes no money. That is the point: the flow is complete
// and exercised before an account exists, so enabling real charging is a
// key paste rather than a build.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  getBillingCustomer,
  getInvoiceCharge,
  getOrgById,
  getUserById,
  listInvoiceCharges,
  recordInvoiceCharge,
  settleInvoiceChargeByExternalId,
  upsertBillingCustomer,
  isPeriodString,
  periodFromDay,
  periodToDay,
  aggregateUsage,
} from '@potion/db';
import { openAiError, requireRole } from '../auth.js';
import { generateInvoice, type Invoice } from '../billing/invoice.js';
import { paymentsFromEnv, type PaymentsTransport } from '../billing/payments.js';
import type { PotionContext } from '../context.js';

function currentPeriod(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Refresh the idempotent rollup for the period, then build the invoice. */
async function invoiceFor(ctx: PotionContext, orgId: string, period: string): Promise<Invoice> {
  await aggregateUsage(ctx.db.db, { fromDay: periodFromDay(period), toDay: periodToDay(period) });
  return generateInvoice(ctx.db.db, orgId, period, { prices: ctx.prices, providerMode: ctx.providerMode });
}

export function registerBillingRoutes(
  app: FastifyInstance,
  ctx: PotionContext,
  opts: { payments?: PaymentsTransport } = {},
): void {
  const db = ctx.db.db;
  const payments = opts.payments ?? paymentsFromEnv();

  app.get('/api/billing', async (req, reply) => {
    const org = req.potionOrg;
    if (!org) return reply.code(401).send(openAiError('authentication required', 'invalid_request_error', 'authentication_required'));
    const period = currentPeriod();
    const [invoice, customer, charges] = await Promise.all([
      invoiceFor(ctx, org.orgId, period),
      getBillingCustomer(db, org.orgId),
      listInvoiceCharges(db, org.orgId),
    ]);
    return reply.send({
      period,
      // What this period costs SO FAR — the same numbers the invoice will
      // carry, not a separate estimate that could disagree with the bill.
      current: {
        totalUsd: invoice.totals.totalUsd,
        requests: invoice.totals.requests,
        lineItems: invoice.lineItems.map((l) => ({
          clusterId: l.clusterId,
          description: l.description,
          requests: l.requests,
          totalUsd: l.totalUsd,
        })),
      },
      paymentMethod: customer?.last4
        ? { brand: customer.brand, last4: customer.last4, expMonth: customer.expMonth, expYear: customer.expYear }
        : null,
      /** 'ledger' means no payment rails are configured yet — the dashboard
       *  says so plainly rather than showing a broken Add-card button. */
      transport: payments.kind,
      charges: charges.map((c) => ({
        period: c.period,
        amountUsd: c.amountCents / 100,
        status: c.status,
        transport: c.transport,
        at: c.createdAt.toISOString(),
      })),
    });
  });

  app.get('/api/invoices/:period', async (req, reply) => {
    const org = req.potionOrg;
    if (!org) return reply.code(401).send(openAiError('authentication required', 'invalid_request_error', 'authentication_required'));
    const { period } = req.params as { period: string };
    if (!isPeriodString(period)) {
      return reply.code(400).send(openAiError(`invalid period '${period}' — want YYYY-MM`, 'invalid_request_error'));
    }
    const invoice = await invoiceFor(ctx, org.orgId, period);
    const charge = await getInvoiceCharge(db, org.orgId, period);
    return reply.send({ invoice, charge: charge ? { status: charge.status, amountUsd: charge.amountCents / 100 } : null });
  });

  const PmBody = z.object({ returnUrl: z.string().url().max(500).optional() }).strict();
  app.post('/api/billing/payment-method', { preHandler: [requireRole('admin')] }, async (req, reply) => {
    const org = req.potionOrg!;
    const parsed = PmBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send(openAiError(parsed.error.issues.map((i) => i.message).join('; '), 'invalid_request_error'));
    const orgRow = await getOrgById(db, org.orgId);
    const user = org.userId ? await getUserById(db, org.userId) : null;
    try {
      const customer = await payments.ensureCustomer(org.orgId, user?.email ?? null, orgRow?.name ?? org.orgId);
      await upsertBillingCustomer(db, {
        orgId: org.orgId,
        customerId: customer.customerId,
        transport: payments.kind,
        status: 'awaiting_card',
      });
      const session = await payments.startCheckout(
        customer.customerId,
        parsed.data.returnUrl ?? `${process.env.POTION_APP_URL ?? 'https://withpotion.com'}/settings/billing`,
        org.orgId,
      );
      return reply.send({ url: session.url, sessionId: session.sessionId, transport: payments.kind });
    } catch (e) {
      return reply
        .code(502)
        .send(openAiError(`could not start checkout: ${e instanceof Error ? e.message : String(e)}`, 'server_error', 'checkout_failed'));
    }
  });

  /**
   * Stripe settlement. PUBLIC by necessity and signature-verified: an
   * unsigned or stale-signed body is refused, so this endpoint cannot be
   * used to mark invoices paid. Under the ledger transport verification
   * always fails, which is the correct posture for a server with no rails.
   */
  // Registered in its OWN fastify scope with a string content-type parser:
  // the signature is over Stripe's raw bytes, and a re-stringified parse is
  // NOT those bytes (key order, whitespace). Without this every real
  // signature would fail — found by asking "what breaks the day the keys
  // are pasted" before the keys existed.
  void app.register(async (scoped) => {
    scoped.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));
    scoped.post('/webhooks/stripe', async (req, reply) => {
    const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
    const evt = payments.verifyWebhook(raw, req.headers['stripe-signature'] as string | undefined);
    if (!evt) return reply.code(400).send({ error: { message: 'signature verification failed', type: 'invalid_request_error' } });
    if (evt.externalId) {
      if (evt.type === 'payment_intent.succeeded') await settleInvoiceChargeByExternalId(db, evt.externalId, 'paid');
      else if (evt.type === 'payment_intent.payment_failed') {
        await settleInvoiceChargeByExternalId(db, evt.externalId, 'failed', 'payment failed at the provider');
      } else if (evt.type === 'checkout.session.completed') {
        // The card is on file; Stripe holds it, we keep display metadata only.
        const cust = typeof evt.data.customer === 'string' ? evt.data.customer : null;
        if (cust) {
          const orgId = typeof evt.data.client_reference_id === 'string' ? evt.data.client_reference_id : null;
          if (orgId) await upsertBillingCustomer(db, { orgId, customerId: cust, transport: payments.kind, status: 'active' });
        }
      }
    }
    return reply.send({ received: true });
    });
  });

  /** Charge one period. Admin-only and idempotent per (org, period). */
  app.post('/api/billing/charge/:period', { preHandler: [requireRole('admin')] }, async (req, reply) => {
    const org = req.potionOrg!;
    const { period } = req.params as { period: string };
    if (!isPeriodString(period)) {
      return reply.code(400).send(openAiError(`invalid period '${period}' — want YYYY-MM`, 'invalid_request_error'));
    }
    const existing = await getInvoiceCharge(db, org.orgId, period);
    if (existing && existing.status === 'paid') {
      return reply.code(409).send(openAiError(`${period} is already paid`, 'invalid_request_error', 'already_paid'));
    }
    const customer = await getBillingCustomer(db, org.orgId);
    if (!customer) {
      return reply.code(409).send(openAiError('no payment method on file', 'invalid_request_error', 'no_payment_method'));
    }
    const invoice = await invoiceFor(ctx, org.orgId, period);
    const result = await payments.chargeInvoice(customer.customerId, invoice);
    const row = await recordInvoiceCharge(db, {
      id: existing?.id ?? `ch-${period}-${org.orgId}`,
      orgId: org.orgId,
      period,
      amountCents: Math.round(invoice.totals.totalUsd * 100),
      status: result.status,
      transport: payments.kind,
      externalId: result.externalId,
      ...(result.error !== undefined ? { error: result.error } : {}),
      invoiceJson: invoice,
    });
    return reply.send({ period, status: row.status, amountUsd: row.amountCents / 100, transport: payments.kind });
  });
}
