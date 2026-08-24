// Billing state (R0, migration 0054): who can be charged, and what we tried
// to charge them. Deliberately thin — Stripe is the source of truth for
// money once it exists; these rows are the LOCAL audit trail, which must
// stand on its own when a webhook is late, lost, or replayed.
import { and, desc, eq } from 'drizzle-orm';
import type { PotionDb } from '../db.js';
import { billingCustomers, invoiceCharges, type BillingCustomerRow, type InvoiceChargeRow } from '../schema.js';

export type ChargeStatus = 'pending' | 'paid' | 'failed' | 'recorded';

export async function getBillingCustomer(db: PotionDb, orgId: string): Promise<BillingCustomerRow | null> {
  const rows = await db.select().from(billingCustomers).where(eq(billingCustomers.orgId, orgId)).limit(1);
  return rows[0] ?? null;
}

export async function upsertBillingCustomer(
  db: PotionDb,
  row: {
    orgId: string;
    customerId: string;
    transport: string;
    brand?: string | null;
    last4?: string | null;
    expMonth?: number | null;
    expYear?: number | null;
    status?: string;
  },
): Promise<BillingCustomerRow> {
  const set = {
    customerId: row.customerId,
    transport: row.transport,
    brand: row.brand ?? null,
    last4: row.last4 ?? null,
    expMonth: row.expMonth ?? null,
    expYear: row.expYear ?? null,
    status: row.status ?? 'none',
    updatedAt: new Date(),
  };
  const out = await db
    .insert(billingCustomers)
    .values({ orgId: row.orgId, ...set })
    .onConflictDoUpdate({ target: billingCustomers.orgId, set })
    .returning();
  return out[0]!;
}

export async function getInvoiceCharge(db: PotionDb, orgId: string, period: string): Promise<InvoiceChargeRow | null> {
  const rows = await db
    .select()
    .from(invoiceCharges)
    .where(and(eq(invoiceCharges.orgId, orgId), eq(invoiceCharges.period, period)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listInvoiceCharges(db: PotionDb, orgId: string): Promise<InvoiceChargeRow[]> {
  return db.select().from(invoiceCharges).where(eq(invoiceCharges.orgId, orgId)).orderBy(desc(invoiceCharges.period));
}

/**
 * Record a charge attempt. IDEMPOTENT per (org, period) by unique index:
 * a retry updates the existing row rather than double-billing a period —
 * the invariant that matters most in this file.
 */
export async function recordInvoiceCharge(
  db: PotionDb,
  row: {
    id: string;
    orgId: string;
    period: string;
    amountCents: number;
    status: ChargeStatus;
    transport: string;
    externalId?: string | null;
    error?: string | null;
    invoiceJson?: unknown;
  },
): Promise<InvoiceChargeRow> {
  const set = {
    amountCents: row.amountCents,
    status: row.status,
    transport: row.transport,
    externalId: row.externalId ?? null,
    error: row.error ?? null,
    ...(row.invoiceJson !== undefined ? { invoiceJson: row.invoiceJson } : {}),
    updatedAt: new Date(),
  };
  const out = await db
    .insert(invoiceCharges)
    .values({ id: row.id, orgId: row.orgId, period: row.period, ...set })
    .onConflictDoUpdate({ target: [invoiceCharges.orgId, invoiceCharges.period], set })
    .returning();
  return out[0]!;
}

/** Webhook landing: move a charge to its terminal state by external id. */
export async function settleInvoiceChargeByExternalId(
  db: PotionDb,
  externalId: string,
  status: ChargeStatus,
  error?: string,
): Promise<InvoiceChargeRow | null> {
  const out = await db
    .update(invoiceCharges)
    .set({ status, error: error ?? null, updatedAt: new Date() })
    .where(eq(invoiceCharges.externalId, externalId))
    .returning();
  return out[0] ?? null;
}
