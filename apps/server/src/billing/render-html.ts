// Print-friendly HTML invoice renderer (M2 Wave 2, ROADMAP #18) — pure
// function Invoice → HTML string. Inline CSS only (no assets, no JS) so the
// file prints/PDFs cleanly from any browser (`@page` + `@media print`
// rules strip the chrome and keep the table on one flow).
import type { Invoice } from './invoice.js';

function esc(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function int(n: number): string {
  return n.toLocaleString('en-US');
}

/** Render a clean, print-friendly HTML invoice. */
export function renderInvoiceHtml(invoice: Invoice): string {
  const rows = invoice.lineItems
    .map(
      (l) => `
      <tr>
        <td>${esc(l.description)}</td>
        <td class="num">${int(l.requests)}</td>
        <td class="num">${int(l.inputTokens)}</td>
        <td class="num">${int(l.outputTokens)}</td>
        <td class="num">${usd(l.platformCostUsd)}</td>
        <td class="num">${usd(l.projectedSavedUsd)}</td>
        <td class="num">${usd(l.totalUsd)}</td>
      </tr>`,
    )
    .join('');

  const empty = invoice.lineItems.length === 0
    ? `\n      <tr><td colspan="7" class="empty">No metered usage in this period.</td></tr>`
    : '';

  // THE BASIS (0086): the share bills the verified LOWER bound or nothing;
  // absent states say why in words, never a zero dressed as proof.
  const v = invoice.verified;
  const basisRow =
    v.status === 'verified'
      ? `<div class="row"><span>Verified savings, live baseline (${int(v.holdoutRequests)} randomized requests · lower bound)</span><span>${usd(Math.max(0, v.verifiedSavingsLowerUsd ?? 0))}</span></div>`
      : `<div class="row"><span>Verified savings</span><span>${esc(
          v.status === 'off'
            ? 'live baseline off — no savings share billed'
            : v.status === 'no-incumbent'
              ? 'no servable incumbent — no savings share billed'
              : `baseline measuring (${v.holdoutRequests} of ${v.minHoldoutRequests}) — no savings share billed`,
        )}</span></div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Invoice ${esc(invoice.id)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    color: #1a1a1a; margin: 0; padding: 48px; max-width: 880px; margin-left: auto; margin-right: auto;
  }
  .masthead { display: flex; justify-content: space-between; align-items: baseline;
    border-bottom: 2px solid #1a1a1a; padding-bottom: 16px; margin-bottom: 32px; }
  .brand { font-size: 24px; font-weight: 700; letter-spacing: -0.02em; }
  .brand span { color: #6d5ef0; }
  h1 { font-size: 18px; margin: 0; font-weight: 600; }
  .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 32px; }
  .meta h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em;
    color: #777; margin: 0 0 6px; font-weight: 600; }
  .meta p { margin: 2px 0; font-size: 14px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 24px; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em;
    color: #777; border-bottom: 1px solid #ccc; padding: 8px 8px 8px 0; }
  td { border-bottom: 1px solid #eee; padding: 10px 8px 10px 0; vertical-align: top; }
  .num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .empty { text-align: center; color: #777; padding: 24px 0; }
  .totals { margin-left: auto; width: 320px; font-size: 14px; }
  .totals .row { display: flex; justify-content: space-between; padding: 6px 0; }
  .totals .grand { border-top: 2px solid #1a1a1a; font-weight: 700; font-size: 16px; margin-top: 6px; padding-top: 10px; }
  .foot { margin-top: 48px; font-size: 12px; color: #777; line-height: 1.6; }
  .badge { display: inline-block; border: 1px solid #ccc; border-radius: 999px;
    padding: 2px 10px; font-size: 11px; color: #555; }
  @page { margin: 18mm; }
  @media print {
    body { padding: 0; max-width: none; }
    .badge { border-color: #999; }
  }
</style>
</head>
<body>
  <div class="masthead">
    <div class="brand">Potion<span>.</span></div>
    <h1>Invoice ${esc(invoice.id)}</h1>
  </div>

  <div class="meta">
    <div>
      <h2>Billed to</h2>
      <p><strong>${esc(invoice.org.name)}</strong></p>
      <p>Org: <code>${esc(invoice.org.id)}</code></p>
    </div>
    <div>
      <h2>Details</h2>
      <p>Period: ${esc(invoice.periodStart)} → ${esc(invoice.periodEnd)} (UTC)</p>
      <p>Generated: ${esc(invoice.generatedAt)}</p>
      <p>Currency: USD · <span class="badge">pricing: ${esc(invoice.pricingModel)}, margin ${invoice.marginPct}%</span></p>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th>Line item</th>
        <th class="num">Requests</th>
        <th class="num">Input tokens</th>
        <th class="num">Output tokens</th>
        <th class="num">Platform cost</th>
        <th class="num">Projected savings (not billed)</th>
        <th class="num">Total</th>
      </tr>
    </thead>
    <tbody>${rows}${empty}
    </tbody>
  </table>

  <div class="totals">
    <div class="row"><span>Requests</span><span>${int(invoice.totals.requests)}</span></div>
    <div class="row"><span>Tokens (in / out)</span><span>${int(invoice.totals.inputTokens)} / ${int(invoice.totals.outputTokens)}</span></div>
    <div class="row"><span>Model cost, at cost</span><span>${usd(invoice.totals.platformCostUsd)}</span></div>
    <div class="row"><span>Projected savings this period (context, not billed)</span><span>${usd(invoice.totals.projectedSavedUsd)}</span></div>
    ${basisRow}
    <div class="row"><span>Savings share (${invoice.savingsSharePct}% of the verified lower bound)</span><span>${usd(invoice.totals.savingsShareUsd)}</span></div>
    ${invoice.totals.marginUsd > 0 ? `<div class="row"><span>Margin (${invoice.marginPct}%)</span><span>${usd(invoice.totals.marginUsd)}</span></div>` : ''}
    <div class="row grand"><span>Total due</span><span>${usd(invoice.totals.totalUsd)}</span></div>
  </div>

  <div class="foot">
    <p>Model cost passes through at cost (price-table cost of served usage, rolled up daily,
    UTC days). The savings share bills only VERIFIED savings: the conservative lower bound
    measured by the randomized live baseline your org consented to — never a projection.
    Projected savings appear for context and are not billed.</p>
    <p>This invoice was generated offline (json-file billing backend). Live Stripe
    invoicing ships once an operator business entity exists — the JSON form of this
    invoice is Stripe-ready.</p>
  </div>
</body>
</html>
`;
}
