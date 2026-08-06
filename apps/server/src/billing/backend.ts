// Billing backends (M2 Wave 2, ROADMAP #18) — where generated invoices go.
//
//   json-file  the Wave-2 implementation: writes <invoice-id>.json +
//              <invoice-id>.html to a local directory. Auditable, diffable,
//              zero external dependencies.
//   stripe     STUB — throws a TODO. Live Stripe invoicing needs an operator
//              business entity (Stripe account + tax registration) that does
//              not exist yet; the Invoice JSON is already Stripe-ready so the
//              future implementation is a field mapping (customer ← org,
//              line items ← stripe.{quantity,unit_amount,amount}), not a
//              redesign.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Invoice } from './invoice.js';

/** Where json-file invoices go by default (repo-root ./invoices, gitignored). */
export const DEFAULT_INVOICE_DIR = fileURLToPath(new URL('../../../invoices', import.meta.url));

export interface BillingBackendRef {
  /** Backend-specific locator (json-file: the .json path; stripe: invoice id). */
  ref: string;
}

export interface BillingBackend {
  readonly kind: string;
  /** Persist (or issue) an invoice plus its rendered HTML. */
  saveInvoice(invoice: Invoice, html: string): Promise<BillingBackendRef>;
}

/** Local json-file backend — the Wave-2 default. */
export class JsonFileBillingBackend implements BillingBackend {
  readonly kind = 'json-file';
  constructor(private readonly dir: string = DEFAULT_INVOICE_DIR) {}

  async saveInvoice(invoice: Invoice, html: string): Promise<BillingBackendRef> {
    await mkdir(this.dir, { recursive: true });
    const jsonPath = join(this.dir, `${invoice.id}.json`);
    const htmlPath = join(this.dir, `${invoice.id}.html`);
    await writeFile(jsonPath, `${JSON.stringify(invoice, null, 2)}\n`, 'utf8');
    await writeFile(htmlPath, html, 'utf8');
    return { ref: jsonPath };
  }
}

/**
 * Stripe backend — STUB. Constructing or using it throws a TODO: no live
 * Stripe until an operator business entity exists (see file header).
 */
export class StripeBillingBackend implements BillingBackend {
  readonly kind = 'stripe';
  constructor() {
    throw new Error(
      'TODO(#18): StripeBillingBackend — live Stripe invoicing requires an operator ' +
        'business entity (Stripe account, tax registration) which does not exist in ' +
        "Wave 2. Use the 'json-file' backend; the Invoice JSON shape is Stripe-ready.",
    );
  }

  saveInvoice(): Promise<BillingBackendRef> {
    throw new Error('TODO(#18): StripeBillingBackend.saveInvoice — stub, see constructor.');
  }
}

/** Resolve a backend by name (CLI --backend / POT­ION_BILLING_BACKEND). */
export function resolveBillingBackend(kind?: string, dir?: string): BillingBackend {
  const effective = (kind ?? process.env.POTION_BILLING_BACKEND ?? 'json-file').trim();
  if (effective === 'json-file') return new JsonFileBillingBackend(dir);
  if (effective === 'stripe') return new StripeBillingBackend();
  throw new Error(`unknown billing backend '${effective}' (want 'json-file' | 'stripe')`);
}
