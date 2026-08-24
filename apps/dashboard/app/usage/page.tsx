// /usage — metered usage + billing (M2 Wave 2, ROADMAP #17/#18). Server
// component: date-range picker (native GET form), stacked bar of
// requests/day by cluster, per-cluster cost table, invoice download, and a
// native POST button that triggers the idempotent usage rollup.
import { UsageChart } from '@/components/usage-chart';
import { FrontierStatus } from '@/components/frontier-status';
import { ApiUnreachable } from '@/lib/api';
import { fetchOrRecover } from '@/lib/recover';
import { formatInt, formatUsd } from '@/lib/usage-chart';
import type {
  UsageByClusterResponse,
  UsageByDayResponse,
  UsageCurrentResponse,
} from '@/lib/types';

export const dynamic = 'force-dynamic';

function defaultRange(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - 13 * 24 * 3600 * 1000);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

export default async function UsagePage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const params = await searchParams;
  const dflt = defaultRange();
  const from = params.from ?? dflt.from;
  const to = params.to ?? dflt.to;
  const qs = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

  let byDay: UsageByDayResponse;
  let byCluster: UsageByClusterResponse;
  let current: UsageCurrentResponse;
  try {
    [byDay, byCluster, current] = await Promise.all([
      fetchOrRecover<UsageByDayResponse>(`/api/usage?${qs}&group_by=day`),
      fetchOrRecover<UsageByClusterResponse>(`/api/usage?${qs}&group_by=cluster`),
      fetchOrRecover<UsageCurrentResponse>(`/api/usage/current`),
    ]);
  } catch (e) {
    if (e instanceof ApiUnreachable) {
      return (
        <PageShell>
          <div className="border border-[#d9d5cb] bg-[#fbfaf7] p-6 text-sm text-soft">
            The Potion API is not reachable. Start <code className="font-mono">apps/server</code>{' '}
            (default port 3000) and reload — the demo data seeds itself on first boot.
          </div>
        </PageShell>
      );
    }
    throw e;
  }

  const invoicePeriod = to.slice(0, 7); // the month containing the range end
  const windowTotals = byCluster.rows.reduce(
    (acc, r) => ({ requests: acc.requests + r.requests, costUsd: acc.costUsd + r.costUsd }),
    { requests: 0, costUsd: 0 },
  );

  return (
    <PageShell>
      {/* date-range picker — native GET form, no JS required */}
      <form method="get" action="/usage" className="mb-8 flex flex-wrap items-end gap-3">
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
        <span className="text-xs text-faint">
          {formatInt(windowTotals.requests)} requests · {formatUsd(windowTotals.costUsd)} in window
        </span>
      </form>

      {/* live today / month-to-date cards (read from request_logs, not the batch rollup) */}
      <div className="mb-8 grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="Today — requests" value={formatInt(current.today.requests)} />
        <StatCard label="Today — cost" value={formatUsd(current.today.costUsd)} />
        <StatCard label="Month-to-date — requests" value={formatInt(current.mtd.requests)} />
        <StatCard label="Month-to-date — cost" value={formatUsd(current.mtd.costUsd)} />
      </div>
      {(current.mtd.baselineCostUsd ?? 0) > current.mtd.costUsd && (
        <p className="mb-6 text-[13px] leading-relaxed text-soft">
          Saved month-to-date: <span className="text-ink">{formatUsd((current.mtd.baselineCostUsd ?? 0) - current.mtd.costUsd)}</span> — measured against
          the model you named for each kind of work where you named one, otherwise against the best measured model on that frontier.
        </p>
      )}
      {(current.measurementUsd ?? 0) > 0 && (
        <p className="mt-3 font-mono text-[11px] leading-relaxed text-faint">
          Measuring your workloads (to route each kind of work to the right model): <span className="text-ink">{formatUsd(current.measurementUsd ?? 0)}</span> month-to-date, billed to this account and not counted in the cost above.
        </p>
      )}
      <div className="hidden">
      </div>

      {/* stacked bar: requests/day by cluster */}
      <section className="mb-8 border border-[#d9d5cb] bg-[#fbfaf7] px-8 py-8">
        <div className="mb-6 flex items-baseline justify-between">
          <h2 className="text-lg font-medium text-ink">Requests per day</h2>
          <span className="text-xs text-faint">
            {from} → {to} · stacked by cluster
          </span>
        </div>
        <UsageChart rows={byDay.rows} />
      </section>

      {/* per-cluster cost table */}
      <section className="mb-8 border border-[#d9d5cb] bg-[#fbfaf7] px-8 py-8">
        <h2 className="mb-6 text-lg font-medium text-ink">Cost by cluster</h2>
        {byCluster.rows.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line px-6 py-10 text-center text-sm text-faint">
            No rolled-up usage in this window yet.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-faint">
                <th className="py-2 pr-4 font-medium">Cluster</th>
                <th className="py-2 pr-4 text-right font-medium">Requests</th>
                <th className="py-2 pr-4 text-right font-medium">Tokens (in / out)</th>
                <th className="py-2 pr-4 text-right font-medium">Cost</th>
                <th className="py-2 text-right font-medium">Avg $/1K</th>
              </tr>
            </thead>
            <tbody>
              {byCluster.rows.map((r) => (
                <tr key={r.clusterId} className="border-b border-line/60 last:border-0">
                  <td className="py-2.5 pr-4 font-mono text-xs text-ink">{r.clusterId}</td>
                  <td className="py-2.5 pr-4 text-right tabular-nums text-soft">{formatInt(r.requests)}</td>
                  <td className="py-2.5 pr-4 text-right tabular-nums text-soft">
                    {formatInt(r.inputTokens)} / {formatInt(r.outputTokens)}
                  </td>
                  <td className="py-2.5 pr-4 text-right tabular-nums text-ink">{formatUsd(r.costUsd)}</td>
                  <td className="py-2.5 text-right tabular-nums text-soft">
                    {r.requests > 0 ? `$${r.avgCostPer1K.toFixed(3)}` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* invoice + rollup */}
      <section className="border border-[#d9d5cb] bg-[#fbfaf7] px-8 py-8">
        <h2 className="mb-2 text-lg font-medium text-ink">Billing</h2>
        <p className="mb-6 text-sm leading-relaxed text-soft">
          Pricing v1 is pass-through plus a configurable margin (default 0%). Invoices are
          generated offline as Stripe-ready JSON + a print-friendly HTML render.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <a
            href={`/api/usage/invoice?period=${invoicePeriod}&format=html`}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
          >
            Download invoice — {invoicePeriod}
          </a>
          <a
            href={`/api/usage/export.csv?${qs}`}
            className="rounded-md border border-line bg-paper px-4 py-2 text-sm text-soft transition-colors hover:text-ink"
          >
            Export CSV
          </a>
          <form method="post" action={`/api/usage/aggregate?${qs}`}>
            <button
              type="submit"
              className="rounded-md border border-line bg-paper px-4 py-2 text-sm text-soft transition-colors hover:text-ink"
            >
              Refresh rollup
            </button>
          </form>
        </div>
        <p className="mt-4 text-xs leading-relaxed text-faint">
          Historical rows come from the daily batch rollup (usage_daily); the rollup is
          idempotent — “Refresh rollup” re-runs it for this window. Today’s numbers above are
          always live from request_logs.
        </p>
      </section>
    </PageShell>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-[#d9d5cb] bg-[#fbfaf7] px-5 py-4">
      <div className="text-xs text-faint">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums text-ink">{value}</div>
    </div>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-4xl">
      <h1 className="text-[2rem] font-medium leading-[1.12] tracking-[-0.02em] text-ink">Usage &amp; billing</h1>
      <p className="mb-10 mt-2 text-sm leading-relaxed text-soft">
        What your key actually served: requests, tokens, and cost per cluster per day — and the
        invoice it adds up to.
      </p>
      <FrontierStatus />
      {children}
    </div>
  );
}
