'use client';

// ROUTING PROOF — the panel that has to be able to say "no".
//
// Every field here comes from `x-frontier-trace`, the header the caller
// already received, read back off the request log. The panel is therefore
// quoting our own answer rather than offering a second opinion about it, and
// the two cannot drift.
//
// The design constraint that shapes everything below: this must look
// DIFFERENT when routing is not happening. A summary that renders green on an
// empty result, or that counts a row with an unknown decision as routed,
// would be exactly the reassurance-shaped decoration this product exists to
// replace. So: unknown is rendered as unknown, zero decisions says zero, and
// requests that never had a routing decision (bad key, no policy, budget
// refusal) stay listed — they are the diagnostic someone connecting needs —
// but never enter the ratio.
import { useEffect, useState } from 'react';
import type { RoutingActivityResponse, RoutingActivityRow } from '@/lib/types';

function Chip({ tone, children }: { tone: 'good' | 'warn' | 'muted'; children: React.ReactNode }) {
  const cls =
    tone === 'good'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
      : tone === 'warn'
        ? 'border-amber-200 bg-amber-50 text-amber-700'
        : 'border-line bg-paper text-faint';
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${cls}`}>
      {children}
    </span>
  );
}

function decision(r: RoutingActivityRow): { tone: 'good' | 'warn' | 'muted'; label: string } {
  if (r.fallback === null) return { tone: 'muted', label: 'no decision' };
  if (r.routed) return { tone: 'good', label: 'routed' };
  return { tone: 'warn', label: 'defaulted' };
}

export function RoutingProof() {
  const [data, setData] = useState<RoutingActivityResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/routing-activity?limit=25', { cache: 'no-store' });
      if (!res.ok) throw new Error(`API ${res.status}`);
      setData((await res.json()) as RoutingActivityResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const summary = data?.summary;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-ink">Did it route my requests?</h2>
        <button
          onClick={() => void load()}
          disabled={busy}
          className="rounded border border-line bg-panel px-2 py-1 text-xs text-soft hover:text-ink disabled:opacity-50"
        >
          {busy ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {error && <p className="text-sm text-warn">{error}</p>}

      {summary && (
        <p className="text-sm leading-relaxed text-soft">
          {summary.withRoutingDecision === 0 ? (
            <>
              No requests yet. Send one to the endpoint above and it will appear here with the
              routing decision it received.
            </>
          ) : (
            <>
              <span className="font-medium text-ink">{summary.routed}</span> of{' '}
              <span className="font-medium text-ink">{summary.withRoutingDecision}</span> recent
              requests were routed on a measured frontier
              {summary.defaulted > 0 && (
                <>
                  ; <span className="font-medium text-warn">{summary.defaulted}</span> fell through
                  to the default strategy
                </>
              )}
              {summary.clustersSeen.length > 0 && (
                <> — across {summary.clustersSeen.length} workload type
                  {summary.clustersSeen.length === 1 ? '' : 's'}</>
              )}
              .
            </>
          )}
        </p>
      )}

      {data && data.requests.length > 0 && (
        <div className="overflow-x-auto border border-[#d9d5cb] bg-[#fbfaf7]">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-line text-faint">
              <tr>
                <th className="px-4 py-2 font-medium">When</th>
                <th className="px-4 py-2 font-medium">Workload</th>
                <th className="px-4 py-2 font-medium">Decision</th>
                <th className="px-4 py-2 font-medium">Strategy</th>
                <th className="px-4 py-2 font-medium">Evidence</th>
                <th className="px-4 py-2 font-medium">Latency</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.requests.map((r, i) => {
                const d = decision(r);
                return (
                  <tr key={`${r.ts}-${i}`}>
                    <td className="whitespace-nowrap px-4 py-2 text-soft">
                      {new Date(r.ts).toLocaleTimeString()}
                    </td>
                    <td className="px-4 py-2 text-ink">
                      {r.clusterId ?? <span className="text-faint">{r.status ?? '—'}</span>}
                    </td>
                    <td className="px-4 py-2">
                      <Chip tone={d.tone}>{d.label}</Chip>
                    </td>
                    <td className="px-4 py-2 font-mono text-faint">
                      {r.strategy ?? '—'}
                      {r.frontierVersion !== null && r.frontierVersion > 0 ? ` · v${r.frontierVersion}` : ''}
                    </td>
                    <td className="px-4 py-2">
                      {r.provenance === null ? (
                        <span className="text-faint">—</span>
                      ) : (
                        <Chip tone={r.provenance === 'live' ? 'good' : 'muted'}>{r.provenance}</Chip>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-soft">
                      {r.latencyMs === null ? '—' : `${Math.round(r.latencyMs)} ms`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs leading-relaxed text-faint">
        Every row is read back from the <code className="font-mono">x-frontier-trace</code> header
        your request received. <span className="font-medium text-soft">Routed</span> means a
        measured frontier existed AND your policy selected a point on it;{' '}
        <span className="font-medium text-soft">defaulted</span> means it did not, and the request
        rode the fallback strategy. Rows with no routing decision (rejected keys, budget stops)
        are shown but never counted either way.
      </p>
    </div>
  );
}
