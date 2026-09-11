'use client';

// THE RECEIPTS SURFACE (S2, brief v4): every request, accounted for. A
// searchable list of receipt rows with a live tail for integration hour,
// each expanding into the receipt object. Day-2-first: three rows and a
// quiet page must feel as finished as three thousand.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ReceiptCard, Stamp } from '@/components/primitives';
import type { Receipt } from '@/components/try-request';
import type { RoutingActivityResponse, RoutingActivityRow } from '@/lib/types';

const POLL_MS = 4000;

/** The resolver's fallback reasons in the customer's words (2026-09-11: every
 * fallback row read "default (not measured yet)", including the ones where
 * a measured frontier existed and an unreachable bar sent the request to
 * its priciest point). */
const FALLBACK_LABEL: Record<string, string> = {
  no_frontier: 'default (not measured yet)',
  policy_infeasible: 'your bar is unreachable here — served the best measured point',
  reasoning_budget: 'reasoning model skipped under your output budget',
  no_point_resolvable: 'no measured route resolvable — served the default',
};

/** The comparator a recorded counterfactual actually came from — the caption
 * may only name what the row proves (caption-vs-provenance). */
function comparatorOf(basis: RoutingActivityRow['baselineBasis']): string {
  switch (basis) {
    case 'org-incumbent':
      return 'the model you named';
    case 'cluster-incumbent':
      return 'the model you designated for this kind of work';
    default:
      return 'the best measured model';
  }
}

function keptOfRow(r: RoutingActivityRow): number | null {
  if (r.baselineCostUsd === null || r.costUsd === null) return null;
  const kept = r.baselineCostUsd - r.costUsd;
  return kept > 0 ? kept : null;
}

/** A log row rendered as the receipt object — strictly what was recorded. */
function rowToReceipt(r: RoutingActivityRow): Receipt {
  return {
    clusterId: r.clusterId,
    clusterConfidence: null,
    strategyHash: r.strategy,
    model: r.servedModel ?? null,
    quality: null,
    costPer1K: null,
    p95Ms: null,
    rule: 'policy',
    floor: null,
    alternatives: [],
    provenance: (r.provenance as Receipt['provenance']) ?? null,
    costUsd: r.costUsd,
    latencyMs: r.latencyMs,
  };
}

export function ReceiptsLedger() {
  const [data, setData] = useState<RoutingActivityResponse | null>(null);
  const [query, setQuery] = useState('');
  const [live, setLive] = useState(true);
  const [openTs, setOpenTs] = useState<string | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/routing-activity?limit=100', { cache: 'no-store' }).catch(() => null);
    if (!res?.ok) return setUnreachable(true);
    setUnreachable(false);
    setData((await res.json()) as RoutingActivityResponse);
  }, []);

  useEffect(() => {
    void load();
    if (!live) return;
    timer.current = setInterval(() => void load(), POLL_MS);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [live, load]);

  const rows = (data?.requests ?? []).filter((r) => {
    if (!query.trim()) return true;
    const q = query.trim().toLowerCase();
    return [r.clusterId, r.servedModel, r.model, r.strategy, r.status, r.policyType]
      .some((f) => (f ?? '').toLowerCase().includes(q));
  });

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search: workload, model, strategy, status…"
          className="min-w-0 flex-1 border border-[#d9d5cb] bg-white px-3.5 py-2 text-sm text-ink placeholder:text-faint focus:border-ink focus:outline-none"
        />
        <button
          type="button"
          onClick={() => setLive((v) => !v)}
          className={`border px-3 py-2 font-mono text-[12px] uppercase tracking-[0.12em] ${live ? 'border-accent text-accent' : 'border-[#d9d5cb] text-faint hover:text-soft'}`}
          title="Tail new requests as they land"
        >
          {live ? '● live' : '○ paused'}
        </button>
      </div>

      {unreachable && (
        <div className="border border-[#d9d5cb] bg-[#fbfaf7] p-5 text-sm text-soft">
          The Potion API is not reachable right now — the ledger will resume on its own.
        </div>
      )}

      {!unreachable && rows.length === 0 && (
        <div className="border border-dashed border-[#d9d5cb] px-6 py-12 text-center text-sm text-faint">
          {query ? 'Nothing matches that search.' : 'No requests yet. Send one to your endpoint and it appears here, with its receipt, within seconds.'}
        </div>
      )}

      <div>
        {rows.map((r) => {
          const kept = keptOfRow(r);
          const open = openTs === r.ts;
          const ok = r.status === 'ok';
          return (
            <div key={`${r.ts}-${r.strategy ?? r.status ?? ''}`} className="border-b border-dashed border-[#d9d5cb]">
              <button
                type="button"
                onClick={() => setOpenTs(open ? null : r.ts)}
                className="grid w-full grid-cols-[92px_1fr_auto] items-baseline gap-3 py-2.5 text-left text-[13.5px] hover:bg-[#fbfaf7] sm:gap-4"
              >
                <span className="font-mono text-[12px] text-faint">{new Date(r.ts).toLocaleTimeString()}</span>
                <span className="min-w-0 truncate text-soft">
                  {ok ? (
                    <>
                      <span className="font-medium text-ink">{r.clusterId ?? 'unclassified'}</span>
                      {' → '}
                      {r.servedModel ?? (r.strategy ? r.strategy.slice(0, 8) : '—')}
                      {r.policyType === 'pinned' && <> <Stamp kind="pinned">pinned</Stamp></>}
                      {r.fallback === 1 && <span className="text-faint"> · {FALLBACK_LABEL[r.fallbackReason ?? ''] ?? 'default (not measured yet)'}</span>}
                      {r.routerVersion !== null && <span className="font-mono text-[12px] text-faint"> · plan v{r.routerVersion}</span>}
                    </>
                  ) : (
                    <span className="text-warn">{r.status}</span>
                  )}
                </span>
                <span className="font-mono text-[12px]">
                  {kept !== null ? (
                    <span className="font-semibold text-kept">kept ${kept.toFixed(5)}</span>
                  ) : r.costUsd !== null ? (
                    <span className="text-faint">${r.costUsd.toFixed(5)}</span>
                  ) : (
                    <span className="text-faint">—</span>
                  )}
                </span>
              </button>
              {open && ok && (
                <div className="pb-4 pl-[92px] sm:pl-24">
                  <ReceiptCard r={rowToReceipt(r)} subtitle={`${new Date(r.ts).toLocaleString()} · from your request log`} />
                  {r.baselineBasis === 'policy-infeasible' && r.baselineCostUsd !== null ? (
                    <p className="mt-2 max-w-md font-mono text-[12px] leading-relaxed text-warn">
                      no saving to claim: nothing measured clears your quality bar for this kind of work, so the best measured point served and it is also the counterfactual (${r.baselineCostUsd.toFixed(5)}). Relax the bar in Controls and cheaper measured points can serve.
                    </p>
                  ) : kept !== null && r.baselineCostUsd !== null ? (
                    <p className="mt-2 max-w-md font-mono text-[12px] leading-relaxed text-faint">
                      counterfactual recorded at serve time: {comparatorOf(r.baselineBasis)} would have cost ${r.baselineCostUsd.toFixed(5)} — kept ${kept.toFixed(5)}.
                    </p>
                  ) : null}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {data && data.summary.withRoutingDecision > 0 && (
        <p className="mt-5 font-mono text-[12px] leading-relaxed text-faint">
          {data.summary.routed} of {data.summary.withRoutingDecision} recent requests routed on a measured frontier
          {data.summary.defaulted > 0 ? ` · ${data.summary.defaulted} served the default` : ''}
          {data.router ? <> · served by <a href="/" className="text-accent underline">{data.router.name} v{data.router.version}</a></> : ''} · rows read back from each response&rsquo;s own trace.
        </p>
      )}
    </div>
  );
}
