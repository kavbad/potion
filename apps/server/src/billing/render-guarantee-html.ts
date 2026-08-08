// Print-friendly HTML guarantee report renderer (G2.1) — pure function
// GuaranteeReport → HTML string, the renderInvoiceHtml pattern: inline CSS
// only, no assets, no JS, prints/PDFs cleanly. The layout enforces the
// standing decisions: RETENTION is the headline (big number + verdict),
// raw serve scores are a drill-down table below, every figure carries its
// provenance, and undesignated clusters show their "retention unavailable"
// reason instead of a fabricated baseline.
import type { GuaranteeReport, GuaranteeReportEntry } from '../routes/guarantee-report.js';

function esc(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function q3(n: number | null): string {
  return n === null ? '—' : n.toFixed(3);
}

/** G2.2: the starved-verification banner — a named state, never silence. */
function verificationBanner(e: GuaranteeReportEntry): string {
  const v = e.verification;
  if (v.state === 'unverifiable') {
    const last = v.lastAttempt
      ? `last attempt: ${esc(v.lastAttempt.outcome)}${v.lastAttempt.detail ? ` — ${esc(v.lastAttempt.detail)}` : ''}`
      : 'no verify attempt recorded yet';
    return `
      <div class="unverifiable">
        <strong>Guarantee currently unverifiable.</strong>
        The open advisory is ${v.openAdvisoryAgeMin ?? '?'}min old (SLA bound ${v.verifySlaMin}min),
        ${v.verifyAttempts} verify attempt(s); ${last}.
        ${v.escalatedAt ? `Escalated ${esc(v.escalatedAt)}.` : 'Escalation pending the next sweep.'}
        The SLA clock keeps running from advisory creation.
      </div>`;
  }
  if (v.state === 'pending') {
    return `<p class="adv">Verification pending — open advisory ${v.openAdvisoryAgeMin ?? 0}min old
      (bound ${v.verifySlaMin}min, ${v.verifyAttempts} attempt(s)).</p>`;
  }
  return '';
}

function headlineCard(e: GuaranteeReportEntry): string {
  if (e.retention === null) {
    return `
      <div class="card muted">
        <div class="k">Baseline retention</div>
        <div class="v">unavailable</div>
        <div class="why">${esc(e.retentionUnavailableReason ?? 'no verdict')}</div>
      </div>`;
  }
  const r = e.retention;
  const cls = r.verdict === 'all-clear' ? 'ok' : 'breach';
  return `
    <div class="card ${cls}">
      <div class="k">Baseline retention (headline)</div>
      <div class="v">${pct(r.mean)}</div>
      <div class="verdict">${esc(r.verdict)}</div>
      <div class="why">
        CI95 [${pct(r.ci95[0])}, ${pct(r.ci95[1])}] vs floor ${pct(r.floor)} ·
        ${r.pairs} pairs (${r.excludedPairs} excluded) · confidence ${esc(r.confidence)} ·
        mode ${esc(r.providerMode)} · seed ${r.seed} · ${esc(r.at)}
      </div>
    </div>`;
}

function entrySection(e: GuaranteeReportEntry): string {
  const floorRow = e.derivedFloor
    ? `<p class="prov">Serve advisory floor ${q3(e.derivedFloor.floor)} — derived from the incumbent's own
       serve distribution (n=${e.derivedFloor.provenance.n}, mean ${q3(e.derivedFloor.provenance.mean)},
       CI95 [${q3(e.derivedFloor.provenance.ci95[0])}, ${q3(e.derivedFloor.provenance.ci95[1])}],
       window ${e.derivedFloor.provenance.windowMin}min, seed ${e.derivedFloor.provenance.seed}).</p>`
    : '';
  const incumbentRow = e.incumbent
    ? `<p class="prov">Incumbent: <code>${esc(e.incumbent.strategyHash)}</code> designated ${esc(e.incumbent.designatedAt)}.</p>`
    : `<p class="prov muted-text">No incumbent designated — legacy absolute-floor path (labeled).</p>`;
  const advisories =
    e.openAdvisories.length > 0
      ? `<p class="adv">⚠ ${e.openAdvisories.length} open advisory tripwire(s) — suite-verify pending.</p>`
      : '';
  const incidentRows = e.incidents
    .map(
      (i) => `
      <tr>
        <td>${esc(i.createdAt)}</td>
        <td>${esc(i.kind)}</td>
        <td>${esc(i.leg)}</td>
        <td>${i.resolvedAt ? `resolved ${esc(i.resolvedAt)}` : 'open'}</td>
      </tr>`,
    )
    .join('');
  const seriesRows = e.qualitySeries
    .map(
      (d) => `
      <tr><td>${esc(d.day)}</td><td class="num">${q3(d.mean)}</td><td class="num">${d.samples}</td></tr>`,
    )
    .join('');
  return `
  <section>
    <h2>${esc(e.policyId)} · ${esc(e.clusterId)}</h2>
    ${verificationBanner(e)}
    ${headlineCard(e)}
    ${incumbentRow}
    ${floorRow}
    ${advisories}
    ${
      e.incidents.length > 0
        ? `<h3>Incidents (labeled by leg — advisory rows are never contractual)</h3>
    <table><thead><tr><th>at</th><th>kind</th><th>leg</th><th>state</th></tr></thead>
      <tbody>${incidentRows}</tbody></table>`
        : ''
    }
    <h3>Raw serve-path quality (drill-down — workload-specific scale, never the headline)</h3>
    <table><thead><tr><th>day</th><th>mean</th><th>samples</th></tr></thead>
      <tbody>${seriesRows}</tbody></table>
  </section>`;
}

export function renderGuaranteeReportHtml(report: GuaranteeReport): string {
  const legacyBanner = report.legacyPath
    ? `<p class="banner">This org has NO incumbent designations: every verdict below uses the
       legacy absolute-floor path. Designate incumbents to enable retention verdicts.</p>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Potion guarantee report — ${esc(report.orgId)} ${esc(report.from)}..${esc(report.to)}</title>
<style>
  body { font: 14px/1.5 -apple-system, "Segoe UI", sans-serif; color: #111; margin: 2rem auto; max-width: 52rem; padding: 0 1rem; }
  h1 { font-size: 1.4rem; } h2 { font-size: 1.1rem; margin-top: 2rem; } h3 { font-size: 0.95rem; margin: 1rem 0 0.25rem; }
  table { border-collapse: collapse; width: 100%; margin: 0.25rem 0 1rem; }
  th, td { border: 1px solid #ddd; padding: 0.3rem 0.5rem; text-align: left; font-size: 0.85rem; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .card { border: 2px solid #ccc; border-radius: 8px; padding: 0.75rem 1rem; margin: 0.5rem 0; }
  .card.ok { border-color: #2e7d32; } .card.breach { border-color: #c62828; }
  .card .k { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; color: #666; }
  .card .v { font-size: 2rem; font-weight: 700; }
  .card.ok .verdict { color: #2e7d32; font-weight: 600; } .card.breach .verdict { color: #c62828; font-weight: 600; }
  .card .why, .prov { font-size: 0.8rem; color: #555; }
  .muted .v { color: #888; } .muted-text { color: #888; }
  .adv { color: #b26a00; font-weight: 600; }
  .banner { background: #fff8e1; border: 1px solid #f0c36d; padding: 0.5rem 0.75rem; border-radius: 6px; }
  .unverifiable { background: #fdecea; border: 2px solid #c62828; padding: 0.6rem 0.85rem; border-radius: 6px; margin: 0.5rem 0; font-size: 0.9rem; }
  code { font-size: 0.8rem; background: #f5f5f5; padding: 0 0.2rem; }
  @media print { body { margin: 0.5rem; } }
</style>
</head>
<body>
<h1>Potion quality-guarantee report</h1>
<p>Org <strong>${esc(report.orgId)}</strong> · window ${esc(report.from)} → ${esc(report.to)} ·
   generated ${esc(report.generatedAt)}</p>
${legacyBanner}
${report.entries.length === 0 ? '<p>No guarantee evidence in this window.</p>' : report.entries.map(entrySection).join('\n')}
<p class="prov">Headline metric: baseline retention — the serving strategy's score relative to the
designated incumbent on identical derived-suite items. Raw scores are workload-specific
(reference-anchored scales) and appear only as drill-down. Serve-leg advisories are tripwires;
only suite-verify evidence renders contractual verdicts (trust hierarchy).</p>
</body>
</html>
`;
}
