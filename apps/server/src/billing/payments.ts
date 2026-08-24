// R0 — the charge path, built to the ACCOUNT BOUNDARY (2026-08-24).
//
// Selection is by environment, exactly like the email transport:
// STRIPE_SECRET_KEY present → the real one; otherwise 'ledger', which
// records every intention locally and takes no money. That is what lets
// the whole billing flow — customer, payment method, invoice, charge,
// webhook — be built, tested and demoed today, with the operator's Stripe
// account as a key paste rather than a rebuild.
//
// NO SDK. Raw fetch against Stripe's form-encoded REST API, the same choice
// the Resend transport made: one less dependency to audit, and the wire is
// legible in the code that sends it.
//
// SAFETY POSTURE. Nothing here ever sees a card number: the payment method
// is collected by Stripe Checkout on Stripe's domain, and we store brand +
// last four for display only. The ledger transport cannot charge by
// construction — it has no network path — so an unconfigured production
// server fails to bill rather than silently billing wrongly.
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Invoice } from './invoice.js';

export interface PaymentCustomer {
  customerId: string;
  brand?: string;
  last4?: string;
  expMonth?: number;
  expYear?: number;
}

export interface ChargeResult {
  externalId: string;
  status: 'paid' | 'pending' | 'failed' | 'recorded';
  error?: string;
}

export interface CheckoutSession {
  /** Where to send the customer to enter a card. */
  url: string;
  sessionId: string;
}

export interface WebhookEvent {
  id: string;
  type: string;
  externalId?: string;
  data: Record<string, unknown>;
}

export interface PaymentsTransport {
  readonly kind: 'stripe' | 'ledger';
  /** Idempotently create the org's payment identity. */
  ensureCustomer(orgId: string, email: string | null, name: string): Promise<PaymentCustomer>;
  /** A hosted page where the customer enters a card. */
  startCheckout(customerId: string, returnUrl: string): Promise<CheckoutSession>;
  /** Collect one period's invoice. */
  chargeInvoice(customerId: string, invoice: Invoice): Promise<ChargeResult>;
  /** Verify and parse a webhook. Returns null when the signature fails. */
  verifyWebhook(rawBody: string, signatureHeader: string | undefined): WebhookEvent | null;
}

/**
 * The account-less transport. Every call succeeds and is recorded, no money
 * moves, and ids are prefixed `local_` so no downstream reader can mistake
 * one for a Stripe object. Charges land as 'recorded', NOT 'paid' — a
 * ledger charge must never be able to masquerade as collected money.
 */
export class LedgerPaymentsTransport implements PaymentsTransport {
  readonly kind = 'ledger' as const;

  ensureCustomer(orgId: string): Promise<PaymentCustomer> {
    return Promise.resolve({ customerId: `local_cus_${orgId}` });
  }

  startCheckout(customerId: string, returnUrl: string): Promise<CheckoutSession> {
    const sessionId = `local_cs_${randomUUID().slice(0, 8)}`;
    // Points back at the caller with a marker: the dashboard renders the
    // "no payment rails configured yet" state rather than a broken link.
    const sep = returnUrl.includes('?') ? '&' : '?';
    return Promise.resolve({ sessionId, url: `${returnUrl}${sep}checkout=unavailable&session=${sessionId}` });
  }

  chargeInvoice(_customerId: string, invoice: Invoice): Promise<ChargeResult> {
    return Promise.resolve({ externalId: `local_ch_${invoice.id}`, status: 'recorded' });
  }

  verifyWebhook(): WebhookEvent | null {
    return null; // nothing legitimately signs a ledger webhook
  }
}

const STRIPE_API = 'https://api.stripe.com/v1';

/** Stripe's `t=…,v1=…` scheme, verified in constant time. */
export function verifyStripeSignature(
  rawBody: string,
  header: string | undefined,
  secret: string,
  toleranceSec = 300,
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(
    header
      .split(',')
      .map((p) => p.split('='))
      .filter((kv): kv is [string, string] => kv.length === 2)
      .map(([k, v]) => [k!.trim(), v!.trim()]),
  );
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || !v1) return false;
  // Replay window: an old-but-validly-signed body must not be replayable.
  if (Math.abs(nowSec - t) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(v1, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export class StripePaymentsTransport implements PaymentsTransport {
  readonly kind = 'stripe' as const;
  constructor(
    private readonly apiKey: string,
    private readonly webhookSecret: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async post(path: string, form: Record<string, string>, idempotencyKey?: string): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(`${STRIPE_API}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: new URLSearchParams(form).toString(),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const err = (body.error ?? {}) as { message?: string };
      // Never log the key or the full body — status and Stripe's message only.
      throw new Error(`stripe ${path}: HTTP ${res.status}${err.message ? ` — ${err.message}` : ''}`);
    }
    return body;
  }

  async ensureCustomer(orgId: string, email: string | null, name: string): Promise<PaymentCustomer> {
    // Idempotency-Key on the org id: a retry returns the SAME customer
    // rather than creating a second one that would split their history.
    const body = await this.post(
      '/customers',
      { name, 'metadata[potion_org_id]': orgId, ...(email ? { email } : {}) },
      `potion-customer-${orgId}`,
    );
    return { customerId: String(body.id) };
  }

  async startCheckout(customerId: string, returnUrl: string): Promise<CheckoutSession> {
    const body = await this.post('/checkout/sessions', {
      mode: 'setup',
      customer: customerId,
      success_url: `${returnUrl}${returnUrl.includes('?') ? '&' : '?'}checkout=done`,
      cancel_url: `${returnUrl}${returnUrl.includes('?') ? '&' : '?'}checkout=cancelled`,
    });
    return { sessionId: String(body.id), url: String(body.url) };
  }

  async chargeInvoice(customerId: string, invoice: Invoice): Promise<ChargeResult> {
    const cents = Math.round(invoice.totals.totalUsd * 100);
    if (cents <= 0) return { externalId: `zero_${invoice.id}`, status: 'paid' };
    try {
      const body = await this.post(
        '/payment_intents',
        {
          amount: String(cents),
          currency: invoice.currency,
          customer: customerId,
          confirm: 'true',
          off_session: 'true',
          description: `Potion usage — ${invoice.period}`,
          'metadata[potion_invoice_id]': invoice.id,
          'metadata[potion_period]': invoice.period,
        },
        // The period is the natural idempotency key: one charge per period,
        // however many times a retry or a redelivery calls this.
        `potion-invoice-${invoice.orgId}-${invoice.period}`,
      );
      const status = String(body.status);
      return { externalId: String(body.id), status: status === 'succeeded' ? 'paid' : 'pending' };
    } catch (e) {
      return { externalId: `failed_${invoice.id}`, status: 'failed', error: e instanceof Error ? e.message : String(e) };
    }
  }

  verifyWebhook(rawBody: string, signatureHeader: string | undefined): WebhookEvent | null {
    if (!this.webhookSecret) return null;
    if (!verifyStripeSignature(rawBody, signatureHeader, this.webhookSecret)) return null;
    try {
      const evt = JSON.parse(rawBody) as { id: string; type: string; data?: { object?: Record<string, unknown> } };
      const obj = evt.data?.object ?? {};
      return {
        id: evt.id,
        type: evt.type,
        ...(typeof obj.id === 'string' ? { externalId: obj.id } : {}),
        data: obj,
      };
    } catch {
      return null;
    }
  }
}

/** The transport the environment selects, logged once at boot by the caller. */
export function paymentsFromEnv(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): PaymentsTransport {
  const key = env.STRIPE_SECRET_KEY?.trim();
  if (!key) return new LedgerPaymentsTransport();
  return new StripePaymentsTransport(key, env.STRIPE_WEBHOOK_SECRET?.trim(), fetchImpl);
}
