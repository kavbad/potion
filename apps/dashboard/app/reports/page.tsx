// /reports — shadow-mode savings report (M3 #21, SPEC §12.4). Server
// component: date-range picker (native GET form, no JS), actual-vs-projected
// spend bar chart (SSR SVG), per-alternative table with confidence badges,
// CSV export. Reads /api/reports/savings from apps/server.
import { BudgetCard } from '@/components/budget-card';
import { IncidentsTable } from '@/components/incidents-table';
import { SavingsChart } from '@/components/savings-chart';
import { SharePanel } from '@/components/share-panel';
import { ApiUnreachable, apiFetch } from '@/lib/api';
import { fetchOrRecover } from '@/lib/recover';
import { collectIncidents } from '@/lib/guarantee';
import { confidenceHint } from '@/lib/savings-chart';
import { formatUsd } from '@/lib/usage-chart';
import type {
  GuaranteeReportDto,
  GuaranteeReportEntryDto,
  GuaranteeStatusDto,
  SavingsAlternativeDto,
  SavingsReportDto,
} from '@/lib/types';

export const dynamic = 'force-dynamic';

function defaultRange(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - 29 * 24 * 3600 * 1000);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const params = await searchParams;
  const dflt = defaultRange();
  const from = params.from ?? dflt.from;
  const to = params.to ?? dflt.to;
  const qs = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

  let report: SavingsReportDto;
  try {
    report = await fetchOrRecover<SavingsReportDto>(`/api/reports/savings?${qs}`);
  } catch (e) {
    if (e instanceof ApiUnreachable) {
      return (
        <PageShell>
          <div className="rounded-lg border border-line bg-panel p-6 text-sm text-soft">
            The Potion API is not reachable. Start <code className="font-mono">apps/server</code>{' '}
            (default port 3000) and reload — the demo data seeds itself on first boot.
          </div>
        </PageShell>
      );
    }
    throw e;
  }

  const best = report.alternatives[0] ?? null; // report is sorted biggest saving first
  const bestSaving = best !== null && best.deltaUsd > 0 ? best : null;

  // M3 #22 guarantee: the incidents section (both reads tolerant — the
  // report page must render without them). The caller's role gates the
  // resolve action; /auth/me 401s in unsigned dev mode → treated as
  // non-admin (the button simply doesn't render).
  const guaranteeStatus = await apiFetch<GuaranteeStatusDto>('/api/guarantee/status').catch(
    () => null,
  );
  const incidents = collectIncidents(guaranteeStatus);
  const me = await apiFetch<{ role?: string }>('/auth/me').catch(() => null);
  const isAdmin = me?.role === 'admin';
  // G2.1: the retention report (tolerant — the page renders without it).
  const guaranteeReport = await apiFetch<GuaranteeReportDto>(
    `/api/reports/guarantee?${qs}`,
  ).catch(() => null);

  return (
    <PageShell>
      {/* date-range picker — native GET form, no JS required */}
      <form method="get" action="/reports" className="mb-8 flex flex-wrap items-end gap-3">
        <label className="text-xs text-faint">
          From
          <input
            type="date"
            name="from"
            defaultValue={from}
            className="mt-1 block rounded-md border border-line bg-panel px-3 py-2 text-sm text-ink"
          />
        </label>
        <label className="text-xs text-faint">
          To
          <input
            type="date"
            name="to"
            defaultValue={to}
            className="mt-1 block rounded-md border border-line bg-panel px-3 py-2 text-sm text-ink"
          />
        </label>
        <button
          type="submit"
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
        >
          Apply
        </button>
        <a
          href={`/api/reports/savings.csv?${qs}`}
          className="rounded-md border border-line bg-paper px-4 py-2 text-sm text-soft transition-colors hover:text-ink"
        >
          Export CSV
        </a>
        {/* M4 #31: mint a public read-only link to this report window */}
        <SharePanel
          kind="report"
          windowDays={Math.max(
            1,
            Math.round((new Date(to).getTime() - new Date(from).getTime()) / (24 * 3600 * 1000)) + 1,
          )}
        />
      </form>

      {/* M4 #35 budget autopilot: cap line + forecast + hard-stop toggle */}
      <BudgetCard />

      {/* G2.1: retention HEADLINE (standing decision — retention leads, raw
          scores are drill-down). Advisory tripwires banner + designation
          empty-state (visible rigor, never a silent default). */}
      {guaranteeReport && <RetentionSection report={guaranteeReport} />}

      {/* headline cards */}
      <div className="mb-8 grid grid-cols-2 gap-4 md:grid-cols-3">
        <StatCard label="Actual spend" value={formatUsd(report.actualSpendUsd)} />
        <StatCard label="Shadowed alternatives" value={String(report.alternatives.length)} />
        <StatCard
          label="Best projected saving"
          value={bestSaving ? `${formatUsd(bestSaving.deltaUsd)} · ${bestSaving.label}` : '—'}
        />
      </div>

      {/* actual vs projected spend chart */}
      <section className="mb-8 rounded-xl border border-line bg-panel px-8 py-8">
        <div className="mb-6 flex items-baseline justify-between">
          <h2 className="text-lg font-medium text-ink">Actual vs. projected spend</h2>
          <span className="text-xs text-faint">
            {from} → {to}
          </span>
        </div>
        <SavingsChart report={report} />
      </section>

      {/* per-alternative table */}
      <section className="rounded-xl border border-line bg-panel px-8 py-8">
        <h2 className="mb-6 text-lg font-medium text-ink">Shadowed alternatives</h2>
        {report.alternatives.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line px-6 py-10 text-center text-sm text-faint">
            Nothing shadowed in this window. Attach a{' '}
            <code className="font-mono">shadow</code> block to a policy (
            <code className="font-mono">
              {'{ "sampleRate": 0.1, "candidates": "frontier" }'}
            </code>
            ) and Potion will replay sampled traffic against the other frontier points after each
            response.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-faint">
                <th className="py-2 pr-4 font-medium">Alternative</th>
                <th className="py-2 pr-4 text-right font-medium">Projected spend</th>
                <th className="py-2 pr-4 text-right font-medium">Quality</th>
                <th className="py-2 pr-4 text-right font-medium">Δ vs actual</th>
                <th className="py-2 pr-4 text-right font-medium">Samples</th>
                <th className="py-2 text-right font-medium">Confidence</th>
              </tr>
            </thead>
            <tbody>
              {report.alternatives.map((a) => (
                <AlternativeRow key={a.strategyHash} alt={a} />
              ))}
            </tbody>
          </table>
        )}
        <p className="mt-6 text-xs leading-relaxed text-faint">
          Shadow mode replays a sample of your traffic against candidate strategies after each
          response — you never pay full price for an experiment. Projections scale each
          candidate&apos;s measured mean cost to your whole window; quality is the deterministic
          shadow score (0–1). Confidence tiers: low &lt;30, medium &lt;200, high ≥200 samples.
        </p>
      </section>

      {/* guarantee incidents (M3 #22): breach/rollback trail + admin resolve */}
      <section className="mt-8 rounded-xl border border-line bg-panel px-8 py-8">
        <div className="mb-6 flex items-baseline justify-between">
          <h2 className="text-lg font-medium text-ink">Guarantee incidents</h2>
          <span className="text-xs text-faint">
            {incidents.filter((i) => i.resolvedAt === null).length} open
          </span>
        </div>
        <IncidentsTable incidents={incidents} isAdmin={isAdmin} />
        <p className="mt-6 text-xs leading-relaxed text-faint">
          When a policy&apos;s guarantee floor is breached (rolling mean over the window, ≥5
          samples), Potion either rolls the cluster&apos;s operating point back to the previous
          frontier version&rsquo;s equivalent point or raises an alert-only incident. Resolving a
          rollback restores normal policy routing.
        </p>
      </section>
    </PageShell>
  );
}

function AlternativeRow({ alt }: { alt: SavingsAlternativeDto }) {
  const saving = alt.deltaUsd > 0;
  return (
    <tr className="border-b border-line/60 last:border-0">
      <td className="py-2.5 pr-4">
        <span className="text-xs text-ink">{alt.label}</span>{' '}
        <span className="font-mono text-[10px] text-faint">{alt.strategyHash.slice(0, 8)}</span>
      </td>
      <td className="py-2.5 pr-4 text-right tabular-nums text-ink">{formatUsd(alt.projectedSpendUsd)}</td>
      <td className="py-2.5 pr-4 text-right tabular-nums text-soft">{alt.projectedQuality.toFixed(2)}</td>
      <td
        className={`py-2.5 pr-4 text-right tabular-nums ${saving ? 'text-accent' : 'text-soft'}`}
      >
        {saving ? '−' : '+'}
        {formatUsd(Math.abs(alt.deltaUsd))}
      </td>
      <td className="py-2.5 pr-4 text-right tabular-nums text-soft">{alt.sampleSize}</td>
      <td className="py-2.5 text-right">
        <ConfidenceBadge confidence={alt.confidence} />
      </td>
    </tr>
  );
}

/** Confidence badge — same badge language as the provenance badges on
 * /frontiers (amber = caution, accent = solid). */
function ConfidenceBadge({ confidence }: { confidence: 'low' | 'medium' | 'high' }) {
  const cls =
    confidence === 'high'
      ? 'border-accent bg-accent-soft text-accent'
      : confidence === 'medium'
        ? 'border-line bg-paper text-soft'
        : 'border-warn bg-amber-50 text-warn';
  return (
    <span
      title={confidenceHint(confidence)}
      className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${cls}`}
    >
      {confidence}
    </span>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-line bg-panel px-5 py-4">
      <div className="text-xs text-faint">{label}</div>
      <div className="mt-1 truncate text-xl font-semibold tabular-nums text-ink" title={value}>
        {value}
      </div>
    </div>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-4xl">
      <h1 className="text-2xl font-semibold tracking-tight">Savings</h1>
      <p className="mb-10 mt-2 text-sm leading-relaxed text-soft">
        What you spent vs. what the shadowed alternatives would have spent — measured on your own
        traffic, after the fact, at zero risk.
      </p>
      {children}
    </div>
  );
}


// ---- G2.1 retention section (trust hierarchy) ----

function RetentionSection({ report }: { report: GuaranteeReportDto }) {
  const openAdvisories = report.entries.reduce((n, e) => n + e.openAdvisories.length, 0);
  const unverifiable = report.entries.filter((e) => e.verification?.state === 'unverifiable');
  return (
    <section className="mb-8 rounded-xl border border-line bg-panel px-8 py-8">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-lg font-medium text-ink">Quality guarantee — baseline retention</h2>
        <span className="text-xs text-faint">
          {report.from} → {report.to}
        </span>
      </div>
      {unverifiable.length > 0 && (
        <div className="mb-4 rounded-lg border-2 border-warn bg-amber-50 px-4 py-3 text-sm text-warn">
          <strong>Guarantee currently unverifiable</strong> for {unverifiable.length} workload
          {unverifiable.length === 1 ? '' : 's'}: suite verification has not produced a verdict
          within the SLA bound. The clock keeps running from advisory creation; verification
          retries continue and this state is escalated as its own alert
          (guarantee_unverifiable), distinct from a breach.
        </div>
      )}
      {openAdvisories > 0 && (
        <div className="mb-4 rounded-lg border border-warn bg-amber-50 px-4 py-3 text-sm text-warn">
          {openAdvisories} open advisory tripwire{openAdvisories === 1 ? '' : 's'} — serve-path
          floor crossings awaiting suite verification. Advisories never change routing; only
          suite evidence renders a contractual verdict.
        </div>
      )}
      {report.legacyPath && (
        <div className="mb-4 rounded-lg border border-dashed border-line px-6 py-8 text-center text-sm text-faint">
          No incumbent designated yet — retention is unavailable and guarantees use the legacy
          absolute-floor path. Designate your current production strategy as the incumbent (
          <code className="font-mono">POST /api/guarantee/clusters/:clusterId/incumbent</code>
          ) to switch this workload to retention verdicts.
        </div>
      )}
      {report.entries.length === 0 ? (
        <p className="text-sm text-faint">No guarantee evidence in this window.</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {report.entries.map((e) => (
            <RetentionEntryCard key={`${e.policyId}|${e.clusterId}`} entry={e} />
          ))}
        </div>
      )}
      <p className="mt-6 text-xs leading-relaxed text-faint">
        The headline is retention: your serving strategy&apos;s score relative to your designated
        incumbent on identical replay-suite items. Raw scores are workload-specific
        (reference-anchored scales) and appear only as the sparkline drill-down.
      </p>
    </section>
  );
}

function RetentionEntryCard({ entry }: { entry: GuaranteeReportEntryDto }) {
  const r = entry.retention;
  return (
    <div className="rounded-lg border border-line bg-paper px-5 py-4">
      <div className="mb-1 text-xs text-faint">
        {entry.policyId} · <span className="font-mono">{entry.clusterId}</span>
      </div>
      {entry.verification && entry.verification.state !== 'none' && (
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide">
          <span
            className={
              entry.verification.state === 'unverifiable'
                ? 'text-warn'
                : entry.verification.state === 'pending'
                  ? 'text-soft'
                  : 'text-accent'
            }
          >
            {entry.verification.state}
            {entry.verification.state !== 'verified' &&
              entry.verification.openAdvisoryAgeMin !== null &&
              ` · ${entry.verification.openAdvisoryAgeMin}min / ${entry.verification.verifySlaMin}min`}
          </span>
        </div>
      )}
      {r ? (
        <>
          <div className="flex items-baseline gap-3">
            <span className="text-2xl font-semibold tabular-nums text-ink">
              {(r.mean * 100).toFixed(1)}%
            </span>
            <span
              className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                r.verdict === 'all-clear'
                  ? 'border-accent bg-accent-soft text-accent'
                  : 'border-warn bg-amber-50 text-warn'
              }`}
            >
              {r.verdict}
            </span>
          </div>
          <div className="mt-1 text-[11px] text-faint">
            CI95 [{(r.ci95[0] * 100).toFixed(1)}%, {(r.ci95[1] * 100).toFixed(1)}%] vs floor{' '}
            {(r.floor * 100).toFixed(0)}% · {r.pairs} pairs ({r.excludedPairs} excluded) ·{' '}
            {r.confidence} · {r.providerMode}
          </div>
        </>
      ) : (
        <div className="text-sm text-soft">{entry.retentionUnavailableReason ?? 'retention unavailable'}</div>
      )}
      {entry.incumbent && (
        <div className="mt-2 text-[11px] text-faint">
          incumbent <span className="font-mono">{entry.incumbent.strategyHash.slice(0, 12)}</span>
          {entry.derivedFloor &&
            ` · serve floor ${entry.derivedFloor.floor.toFixed(3)} (n=${entry.derivedFloor.provenance.n})`}
        </div>
      )}
      <QualitySparkline series={entry.qualitySeries} />
    </div>
  );
}

/** SSR SVG sparkline of the daily serve-path quality means (drill-down —
 * gaps stay gaps: days without samples break the line). */
function QualitySparkline({
  series,
}: {
  series: Array<{ day: string; mean: number | null; samples: number }>;
}) {
  const w = 240;
  const h = 36;
  const n = series.length;
  if (n === 0) return null;
  const x = (i: number) => (n === 1 ? w / 2 : (i / (n - 1)) * (w - 4) + 2);
  const y = (q: number) => h - 3 - q * (h - 6);
  let d = '';
  let pen = false;
  for (let i = 0; i < n; i++) {
    const m = series[i]!.mean;
    if (m === null) {
      pen = false;
      continue;
    }
    d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(m).toFixed(1)} `;
    pen = true;
  }
  if (d === '') return null;
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="mt-3 h-9 w-full"
      role="img"
      aria-label="daily serve-path quality"
    >
      <path d={d.trim()} fill="none" stroke="currentColor" strokeWidth="1.5" className="text-accent" />
    </svg>
  );
}
