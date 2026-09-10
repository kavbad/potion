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
import {
  getOrgIncumbents,
  getOrgById,
  holdoutWindowStats,
  isPeriodString,
  listUsageDaily,
  periodFromDay,
  periodToDay,
  type PotionDb,
} from '@potion/db';
import type { PriceTable } from '@potion/core';
import { eligibleIncumbent } from '../routing/holdout.js';
import { buildVerifiedSavings, type VerifiedSavings } from '../verified-savings.js';
import { baselineBasisByCluster } from '@potion/db';

export const DEFAULT_MARGIN_PCT = 0;
export const PRICING_MODEL_V1 = 'pass-through-plus-margin' as const;
/** Pricing v2 (operator decision, 2026-08-25, from the external review's
 * alignment finding): model cost passes through AT COST, and Potion's
 * revenue is a share of the VERIFIED savings. THE BASIS SWAPPED 2026-09-01
 * (0086): "verified" now means the randomized-holdout LOWER BOUND — the
 * org's own incumbent, measured live on a consented slice — never the
 * serve-time estimated counterfactual, which stays on the invoice as
 * labeled CONTEXT (projected, not billed). No live baseline → no savings
 * share: save nothing PROVABLY, and Potion earns nothing above cost. The
 * better Potion routes, the more both sides make. */
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
  /** PROJECTED savings on this line (serve-time estimated counterfactual
   * minus platform cost, floored at 0) — CONTEXT, never billed. The
   * billable savings number is the invoice-level verified lower bound. */
  projectedSavedUsd: number;
  /**
   * WHAT THAT NUMBER WAS MEASURED AGAINST (0089's read side).
   *
   * 'org-incumbent' / 'cluster-incumbent' — the model the customer told us
   * they use. A figure they can reproduce.
   * 'best-of-frontier' — NO incumbent was named, so the comparator is the
   * priciest measured option. That was never anyone's alternative, so the
   * number is not reproducible by the customer and must not be read as
   * "what you saved".
   * 'mixed' — the period spans a change; honest, and better than picking
   * whichever basis sorted first.
   * null — nothing carried a baseline.
   *
   * A savings caption that cannot name its comparator is the same class of
   * defect as a savings figure with no evidence behind it. */
  projectedBasis: 'org-incumbent' | 'cluster-incumbent' | 'best-of-frontier' | 'mixed' | null;
  /** What the customer pays for this line (= platform + margin). */
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
  /** THE BASIS (0086): what the org's own randomized traffic proved this
   * period. status !== 'verified' → the share line is null and the invoice
   * says why — never a zero dressed as proof. */
  verified: VerifiedSavings;
  /** The one billable savings line: share % × the verified LOWER bound.
   * null when there is nothing verified to share. */
  savingsShareLine: { description: string; basisUsd: number; amountCents: number } | null;
  totals: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    platformCostUsd: number;
    marginUsd: number;
    /** Context, never billed. */
    projectedSavedUsd: number;
    /** The basis across every line — 'mixed' when they disagree. */
    projectedBasis: 'org-incumbent' | 'cluster-incumbent' | 'best-of-frontier' | 'mixed' | null;
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
  /** REQUIRED (0086): the verified-savings basis inputs. Making this a
   * parameter a caller could omit would quietly zero the share — the drift
   * disease; every caller states its provider mode and price table. */
  basis: { prices: PriceTable; providerMode: 'mock' | 'live' },
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

  // THE VERIFIED BASIS (0086): the period's randomized-holdout economics,
  // the same one-implementation math the Savings report renders.
  const inc = await getOrgIncumbents(db, orgId);
  const stats = await holdoutWindowStats(db, orgId, {
    from: new Date(`${range.fromDay}T00:00:00.000Z`),
    to: new Date(new Date(`${range.toDay}T00:00:00.000Z`).getTime() + 24 * 3600 * 1000),
  });
  const eligible = inc === null ? { model: null as string | null } : eligibleIncumbent(inc.models, basis.prices, basis.providerMode);
  const verified = buildVerifiedSavings(
    { consent: inc?.holdoutConsent ?? false, rate: inc?.holdoutRate ?? 0, incumbentModel: eligible.model },
    stats,
    `invoice|${orgId}|${period}`,
  );

  // The comparator behind projectedSavedUsd, per cluster. Read from the
  // request rows rather than usage_daily, which rolls up the baseline COST
  // and drops the basis that makes it meaningful.
  const basisRows = await baselineBasisByCluster(db, orgId, range);
  const basisByCluster = new Map<string, InvoiceLineItem['projectedBasis']>();
  for (const clusterId of new Set(basisRows.map((r) => r.clusterId))) {
    const distinct = [
      ...new Set(
        basisRows
          .filter((r) => r.clusterId === clusterId && r.basis !== null && r.requests > 0)
          .map((r) => r.basis as string),
      ),
    ];
    basisByCluster.set(
      clusterId,
      distinct.length === 0 ? null : distinct.length > 1 ? 'mixed' : (distinct[0] as InvoiceLineItem['projectedBasis']),
    );
  }

  const lineItems: InvoiceLineItem[] = [...byCluster.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([clusterId, acc]) => {
      // Integer-cent math at line granularity — see file header.
      const platformCents = toCents(acc.platformCostUsd);
      const marginCents = Math.round((platformCents * marginPct) / 100);
      const projectedCents = Math.max(0, toCents(acc.baselineCostUsd) - platformCents);
      const totalCents = platformCents + marginCents;
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
        projectedSavedUsd: centsToUsd(projectedCents),
        projectedBasis: basisByCluster.get(clusterId) ?? null,
        totalUsd: centsToUsd(totalCents),
        stripe: {
          currency: 'usd' as const,
          quantity: acc.requests,
          unitAmountCents: acc.requests > 0 ? totalCents / acc.requests : 0,
          amountCents: totalCents,
        },
      };
    });

  const lineTotals = lineItems.reduce(
    (acc, l) => ({
      requests: acc.requests + l.requests,
      inputTokens: acc.inputTokens + l.inputTokens,
      outputTokens: acc.outputTokens + l.outputTokens,
      platformCostUsd: centsToUsd(toCents(acc.platformCostUsd) + toCents(l.platformCostUsd)),
      marginUsd: centsToUsd(toCents(acc.marginUsd) + toCents(l.marginUsd)),
      projectedSavedUsd: centsToUsd(toCents(acc.projectedSavedUsd) + toCents(l.projectedSavedUsd)),
      totalUsd: centsToUsd(toCents(acc.totalUsd) + toCents(l.totalUsd)),
    }),
    { requests: 0, inputTokens: 0, outputTokens: 0, platformCostUsd: 0, marginUsd: 0, projectedSavedUsd: 0, totalUsd: 0 },
  );

  // One basis for the whole invoice, or 'mixed'. A line that contributed no
  // projected savings cannot claim a basis for the total, so it is ignored:
  // otherwise a single zero-savings best-of-frontier line would relabel an
  // otherwise incumbent-backed invoice.
  const contributingBases = [
    ...new Set(
      lineItems
        .filter((l) => l.projectedSavedUsd > 0 && l.projectedBasis !== null)
        .map((l) => l.projectedBasis as string),
    ),
  ];
  const projectedBasis: InvoiceLineItem['projectedBasis'] =
    contributingBases.length === 0
      ? null
      : contributingBases.length > 1
        ? 'mixed'
        : (contributingBases[0] as InvoiceLineItem['projectedBasis']);

  // The one billable savings line: share % of the verified LOWER bound,
  // floored at 0 (a negative bound bills nothing — it never charges the
  // customer for uncertainty).
  const lowerCents =
    verified.status === 'verified' && verified.verifiedSavingsLowerUsd !== null
      ? Math.max(0, toCents(verified.verifiedSavingsLowerUsd))
      : 0;
  const shareCents = Math.round((lowerCents * savingsSharePct) / 100);
  const savingsShareLine =
    shareCents > 0
      ? {
          description:
            `Verified savings share — ${savingsSharePct}% of the live-baseline lower bound ` +
            `(${verified.holdoutRequests} randomized requests vs ${verified.routedRequests} routed, ${period})`,
          basisUsd: centsToUsd(lowerCents),
          amountCents: shareCents,
        }
      : null;
  const totals = {
    ...lineTotals,
    projectedBasis,
    savingsShareUsd: centsToUsd(shareCents),
    totalUsd: centsToUsd(toCents(lineTotals.totalUsd) + shareCents),
  };

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
    verified,
    savingsShareLine,
    totals,
    generatedAt: new Date().toISOString(),
  };
}
