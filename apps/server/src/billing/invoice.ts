// Billing — invoice generation (M2 Wave 2, ROADMAP #18).
//
// Pricing model v1: PASS-THROUGH + CONFIGURABLE MARGIN. `[●]` open decision:
// the customer price of a request is our price-table cost of the served
// usage (usage_daily.platform_cost_usd, itself request_logs.usage.costUsd)
// plus margin_pct (default 0 ⇒ pure pass-through; usage_daily.cost_usd ==
// platform_cost_usd today). Per-cluster or per-model differentiated margins
// are a later pricing iteration — the line items already carry margin_pct
// per line so that change is data-compatible.
//
// Money math: everything is computed in INTEGER CENTS at line granularity
// (round-half-up), then totals are plain sums of line cents — invoices
// reconcile to the cent by construction, never by float luck.
//
// NO live Stripe: a real Stripe invoice needs an operator business entity
// (Stripe account, tax registration) that does not exist in Wave 2. The
// stripe BillingBackend is a stub that throws a TODO; the JSON shape below
// is Stripe-ready (per-line quantity/unit_amount/amount in cents, currency,
// customer = org) so the stub's future implementation is a field mapping,
// not a redesign.
import { listUsageDaily, periodFromDay, periodToDay, isPeriodString, type PotionDb } from '@potion/db';
import { getOrgById } from '@potion/db';

export const DEFAULT_MARGIN_PCT = 0;
export const PRICING_MODEL_V1 = 'pass-through-plus-margin' as const;
/** Pricing v2 (operator decision, 2026-08-25, from the external review's
 * alignment finding): model cost passes through AT COST, and Potion's
 * revenue is a share of the VERIFIED savings — the per-request counterfactual
 * recorded at serve time (usage_daily.baseline_cost_usd). The better Potion
 * routes, the more both sides make; save nothing, and Potion earns nothing
 * above cost. The receipt system IS the billing system. */
export const PRICING_MODEL_V2 = 'at-cost-plus-verified-savings-share' as const;
export const DEFAULT_SAVINGS_SHARE_PCT = 25;

export interface InvoiceLineItem {
  clusterId: string;
  /** Human-readable Stripe-style line description. */
  description: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** Our price-table cost of the served usage, cents-rounded. */
  platformCostUsd: number;
  /** [●] pricing decision: margin over platform cost (default 0). */
  marginPct: number;
  marginUsd: number;
  /** Verified savings on this line: recorded baseline minus platform cost,
   * floored at 0. Partial baseline coverage under-reports savings, which
   * favors the customer by construction. */
  verifiedSavedUsd: number;
  savingsSharePct: number;
  savingsShareUsd: number;
  /** What the customer pays for this line (= platform + margin + share). */
  totalUsd: number;
  /** Stripe-ready mapping (Stripe amounts are integer cents). */
  stripe: {
    currency: 'usd';
    /** Billable units = requests. */
    quantity: number;
    /** Average price per request, cents (informational; Stripe lines price
     * by quantity × unit_amount, we also carry the authoritative amount). */
    unitAmountCents: number;
    amountCents: number;
  };
}

export interface Invoice {
  id: string;
  object: 'potion.invoice';
  orgId: string;
  org: { id: string; name: string };
  /** 'YYYY-MM'. */
  period: string;
  periodStart: string;
  periodEnd: string;
  currency: 'usd';
  pricingModel: typeof PRICING_MODEL_V1 | typeof PRICING_MODEL_V2;
  marginPct: number;
  savingsSharePct: number;
  lineItems: InvoiceLineItem[];
  totals: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    platformCostUsd: number;
    marginUsd: number;
    verifiedSavedUsd: number;
    savingsShareUsd: number;
    totalUsd: number;
  };
  generatedAt: string;
}

/** Round half-up to integer cents. */
export function toCents(usd: number): number {
  return Math.round(usd * 100);
}

export function centsToUsd(cents: number): number {
  return cents / 100;
}

/**
 * generateInvoice(db, orgId, period) — build the Stripe-ready invoice JSON
 * for one org + 'YYYY-MM' period from usage_daily.
 *
 * READ-ONLY by design: the caller (CLI / invoice route) refreshes the
 * idempotent usage rollup for the period first, so the invoice is current
 * to the cent at generation time without this function having side effects.
 */
export async function generateInvoice(
  db: PotionDb,
  orgId: string,
  period: string,
  opts: { marginPct?: number; savingsSharePct?: number } = {},
): Promise<Invoice> {
  if (!isPeriodString(period)) {
    throw new Error(`invalid period '${period}' (want YYYY-MM)`);
  }
  const marginPct = opts.marginPct ?? DEFAULT_MARGIN_PCT;
  if (!Number.isFinite(marginPct) || marginPct < 0) {
    throw new Error(`marginPct must be a finite number >= 0 (got ${marginPct})`);
  }
  const savingsSharePct = opts.savingsSharePct ?? DEFAULT_SAVINGS_SHARE_PCT;
  if (!Number.isFinite(savingsSharePct) || savingsSharePct < 0 || savingsSharePct >= 100) {
    throw new Error(`savingsSharePct must be in [0, 100) (got ${savingsSharePct})`);
  }
  const org = await getOrgById(db, orgId);
  if (!org) throw new Error(`unknown org '${orgId}'`);

  const range = { fromDay: periodFromDay(period), toDay: periodToDay(period) };
  const rows = await listUsageDaily(db, orgId, range);

  // One line per cluster: sum the org's daily rows for the period.
  const byCluster = new Map<
    string,
    { requests: number; inputTokens: number; outputTokens: number; platformCostUsd: number; baselineCostUsd: number }
  >();
  for (const r of rows) {
    const acc = byCluster.get(r.clusterId) ?? {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      platformCostUsd: 0,
      baselineCostUsd: 0,
    };
    acc.requests += r.requests;
    acc.inputTokens += r.inputTokens;
    acc.outputTokens += r.outputTokens;
    acc.platformCostUsd += r.platformCostUsd;
    acc.baselineCostUsd += r.baselineCostUsd;
    byCluster.set(r.clusterId, acc);
  }

  const lineItems: InvoiceLineItem[] = [...byCluster.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([clusterId, acc]) => {
      // Integer-cent math at line granularity — see file header.
      const platformCents = toCents(acc.platformCostUsd);
      const marginCents = Math.round((platformCents * marginPct) / 100);
      const savedCents = Math.max(0, toCents(acc.baselineCostUsd) - platformCents);
      const shareCents = Math.round((savedCents * savingsSharePct) / 100);
      const totalCents = platformCents + marginCents + shareCents;
      return {
        clusterId,
        // G2.1 relabel: a cost-only line (0 served requests — guarantee
        // judging, rubric generation, live eval sweeps) is scoring &
        // evaluation work, not routed traffic; the label must say so.
        description:
          acc.requests === 0
            ? `Potion scoring & evaluation services — cluster '${clusterId}' (${period})`
            : `Potion routed requests — cluster '${clusterId}' (${period})`,
        requests: acc.requests,
        inputTokens: acc.inputTokens,
        outputTokens: acc.outputTokens,
        platformCostUsd: centsToUsd(platformCents),
        marginPct,
        marginUsd: centsToUsd(marginCents),
        verifiedSavedUsd: centsToUsd(savedCents),
        savingsSharePct,
        savingsShareUsd: centsToUsd(shareCents),
        totalUsd: centsToUsd(totalCents),
        stripe: {
          currency: 'usd' as const,
          quantity: acc.requests,
          unitAmountCents: acc.requests > 0 ? totalCents / acc.requests : 0,
          amountCents: totalCents,
        },
      };
    });

  const totals = lineItems.reduce(
    (acc, l) => ({
      requests: acc.requests + l.requests,
      inputTokens: acc.inputTokens + l.inputTokens,
      outputTokens: acc.outputTokens + l.outputTokens,
      platformCostUsd: centsToUsd(toCents(acc.platformCostUsd) + toCents(l.platformCostUsd)),
      marginUsd: centsToUsd(toCents(acc.marginUsd) + toCents(l.marginUsd)),
      verifiedSavedUsd: centsToUsd(toCents(acc.verifiedSavedUsd) + toCents(l.verifiedSavedUsd)),
      savingsShareUsd: centsToUsd(toCents(acc.savingsShareUsd) + toCents(l.savingsShareUsd)),
      totalUsd: centsToUsd(toCents(acc.totalUsd) + toCents(l.totalUsd)),
    }),
    { requests: 0, inputTokens: 0, outputTokens: 0, platformCostUsd: 0, marginUsd: 0, verifiedSavedUsd: 0, savingsShareUsd: 0, totalUsd: 0 },
  );

  return {
    id: `inv_${orgId}_${period}`,
    object: 'potion.invoice',
    orgId,
    org: { id: org.id, name: org.name },
    period,
    periodStart: range.fromDay,
    periodEnd: range.toDay,
    currency: 'usd',
    pricingModel: savingsSharePct > 0 ? PRICING_MODEL_V2 : PRICING_MODEL_V1,
    marginPct,
    savingsSharePct,
    lineItems,
    totals,
    generatedAt: new Date().toISOString(),
  };
}
