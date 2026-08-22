// /traces (M5 #36, SPEC §14) — agent observability. Sessions rolled up from
// ingested OTel-ish spans: cost attribution per trace and per span, loop
// signals (same tool, same args, ≥3×), retention controls, and the agent
// clusters the traces:cluster worker synthesizes from redacted embeddings —
// each linking to its frontier.
import { TraceClusterButton, TraceRetentionForm } from '@/components/traces-actions';
import { ApiUnreachable, apiFetch } from '@/lib/api';
import { fetchOrRecover } from '@/lib/recover';
import type {
  FrontierListResponse,
  TraceRetentionResponse,
  TraceSession,
  TracesResponse,
  TraceWaterfallResponse,
} from '@/lib/types';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

interface MeResponse {
  role: 'admin' | 'member' | 'viewer';
}

export default async function TracesPage({
  searchParams,
}: {
  searchParams: Promise<{ trace?: string }>;
}) {
  const { trace } = await searchParams;

  let data: TracesResponse;
  try {
    data = await fetchOrRecover<TracesResponse>('/api/traces?limit=100');
  } catch (e) {
    if (e instanceof ApiUnreachable) {
      return (
        <PageShell>
          <div className="rounded-lg border border-line bg-panel p-6 text-sm text-soft">
            The Potion API is not reachable. Start <code className="font-mono">apps/server</code>{' '}
            (default port 3000) and reload.
          </div>
        </PageShell>
      );
    }
    throw e;
  }
  // Tolerant reads — waterfall, retention, role, and the agent-cluster strip
  // must never take the session list down.
  const waterfall =
    trace !== undefined && trace !== ''
      ? await apiFetch<TraceWaterfallResponse>(`/api/traces/${encodeURIComponent(trace)}`).catch(
          () => null,
        )
      : null;
  const retention = await apiFetch<TraceRetentionResponse>('/api/traces/retention').catch(
    () => null,
  );
  const me = await apiFetch<MeResponse>('/api/auth/me').catch(() => null);
  const isAdmin = me?.role === 'admin';
  const frontiers = await apiFetch<FrontierListResponse>('/api/frontiers').catch(() => null);
  const agentClusters = (frontiers?.clusters ?? []).filter((c) =>
    c.clusterId.startsWith('agent-'),
  );

  return (
    <PageShell>
      {/* admin strip: clustering trigger + retention */}
      <div className="mb-6 rounded-lg border border-line bg-panel p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-soft">
            <span className="font-medium text-ink">Agent traces.</span> Send spans to{' '}
            <code className="font-mono">POST /v1/traces</code> with your API key. Potion prices
            every span, flags tool-call loops, and clusters redacted sessions into agent
            workloads — each cluster grows its own frontier.
          </div>
          {isAdmin ? <TraceClusterButton /> : null}
        </div>
        {isAdmin && retention !== null ? (
          <div className="mt-3 border-t border-line pt-3">
            <TraceRetentionForm current={retention.traceRetentionDays} />
            <p className="mt-1 text-xs text-faint">
              0 = keep metadata only (prompts and attributes are redacted on purge); N = spans
              older than N days are deleted by the nightly purge.
            </p>
          </div>
        ) : null}
      </div>

      {/* agent clusters discovered from traces */}
      {agentClusters.length > 0 ? (
        <div className="mb-6 rounded-lg border border-line bg-panel p-4">
          <div className="text-sm font-medium text-ink">Agent clusters</div>
          <ul className="mt-2 space-y-1">
            {agentClusters.map((c) => (
              <li key={c.clusterId} className="flex items-center justify-between text-xs">
                <Link
                  href={`/frontiers?cluster=${encodeURIComponent(c.clusterId)}`}
                  className="font-mono text-accent hover:underline"
                >
                  {c.clusterId}
                </Link>
                <span className="text-faint">
                  {c.pointCount} point{c.pointCount === 1 ? '' : 's'} · frontier v{c.version}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* waterfall panel for ?trace= */}
      {trace !== undefined && trace !== '' ? (
        <div className="mb-6 rounded-lg border border-line bg-panel p-4">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium text-ink">
              Trace <span className="font-mono">{trace.slice(0, 16)}</span>
            </div>
            <Link href="/traces" className="text-xs text-faint hover:text-soft">
              close
            </Link>
          </div>
          {waterfall === null ? (
            <p className="mt-2 text-xs text-soft">Trace not found (purged, or never ingested).</p>
          ) : (
            <Waterfall spans={waterfall.spans} totalCostUsd={waterfall.totalCostUsd} />
          )}
        </div>
      ) : null}

      {/* session rollup */}
      {data.sessions.length === 0 ? (
        <div className="rounded-lg border border-line bg-panel p-6 text-sm text-soft">
          No traces yet. Ingest spans with{' '}
          <code className="font-mono">POST /v1/traces</code> and they roll up here by trace id.
        </div>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line bg-panel">
          {data.sessions.map((s) => (
            <SessionRow key={s.traceId} session={s} />
          ))}
        </ul>
      )}
    </PageShell>
  );
}

function SessionRow({ session }: { session: TraceSession }) {
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <Link
            href={`/traces?trace=${encodeURIComponent(session.traceId)}`}
            className="font-mono text-sm text-accent hover:underline"
          >
            {session.traceId.slice(0, 16)}…
          </Link>{' '}
          <span className="text-xs text-faint">{fmtTime(session.startedAt)}</span>
        </div>
        <span className="flex items-center gap-2">
          <span className="text-xs text-soft">
            {session.spanCount} span{session.spanCount === 1 ? '' : 's'} · $
            {session.totalCostUsd.toFixed(4)}
          </span>
          {session.looping ? (
            <span className="inline-block rounded-full border border-warn bg-amber-50 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-warn">
              LOOP
            </span>
          ) : null}
          {session.metadataOnly ? (
            <span className="inline-block rounded-full border border-line bg-paper px-2 py-0.5 text-[10px] font-semibold tracking-wide text-faint">
              METADATA ONLY
            </span>
          ) : null}
        </span>
      </div>
      <div className="mt-1 text-xs text-faint">
        {session.models.length > 0 ? session.models.join(', ') : 'no model attribution'}
        {session.loops.length > 0 ? (
          <span className="ml-2 text-warn">
            loops:{' '}
            {session.loops.map((l) => `${l.signature.split(':')[0]} ×${l.count}`).join(', ')}
          </span>
        ) : null}
      </div>
    </li>
  );
}

/** Per-span cost attribution, in waterfall (ts) order with parent indentation. */
function Waterfall({
  spans,
  totalCostUsd,
}: {
  spans: TraceWaterfallResponse['spans'];
  totalCostUsd: number;
}) {
  const depth = new Map<string, number>();
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  for (const s of spans) {
    let d = 0;
    let p = s.parentId;
    while (p !== null && byId.has(p)) {
      d += 1;
      p = byId.get(p)!.parentId;
    }
    depth.set(s.spanId, d);
  }
  const t0 = spans.length > 0 ? new Date(spans[0]!.ts).getTime() : 0;
  return (
    <div className="mt-3">
      <div className="text-xs text-faint">
        {spans.length} span{spans.length === 1 ? '' : 's'} · total ${totalCostUsd.toFixed(4)}
      </div>
      <ul className="mt-2 space-y-1">
        {spans.map((s) => (
          <li
            key={s.spanId}
            className="flex items-baseline justify-between gap-3 text-xs"
            style={{ paddingLeft: `${(depth.get(s.spanId) ?? 0) * 16}px` }}
          >
            <span className="min-w-0 truncate text-soft">
              <span className="font-mono text-faint">
                +{Math.max(0, new Date(s.ts).getTime() - t0)}ms
              </span>{' '}
              <span className="text-ink">{s.name}</span>
              {s.model !== null ? <span className="text-faint"> · {s.model}</span> : null}
            </span>
            <span className="shrink-0 font-mono text-soft">${s.costUsd.toFixed(6)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toISOString().replace('T', ' ').slice(0, 16);
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-4xl">
      <h1 className="text-2xl font-semibold tracking-tight">Traces</h1>
      <p className="mb-10 mt-2 text-sm leading-relaxed text-soft">
        Agent sessions rolled up from your spans — per-trace and per-span cost, loop signals, and
        the clusters they grow into. Retention is yours to set.
      </p>
      {children}
    </div>
  );
}
