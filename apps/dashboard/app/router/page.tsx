// /router — R1 (Router direction, 2026-08-27): the org's router as a MINTED
// ARTIFACT. The fundamental object of the dashboard: named, versioned,
// inspectable, evidenced. Assembled server-side by the SAME functions the
// serve path runs, so this page cannot disagree with production.
//
// The asymmetry is stated on the page and enforced by its shape: there is
// no hand-assignment control anywhere — you change what you WANT (floors,
// ceilings, bans in Controls) and Potion recompiles.
import Link from 'next/link';
import { ApiUnreachable } from '@/lib/api';
import { fetchOrRecover } from '@/lib/recover';
import { RouterArc } from '@/components/router-arc';

export const dynamic = 'force-dynamic';

interface Assignment {
  clusterId: string;
  frontierVersion: number;
  provenance: 'live' | 'mock' | 'blocked';
  strategy: { type: string; label: string };
  quality: number | null;
  costPer1K: number | null;
  latencyP95: number | null;
  evidenceN: number | null;
  alternatives: number;
  fallback: string | null;
}

interface RouterResponse {
  name: string;
  version: number;
  routerHash: string;
  mintedAt: string;
  document: {
    policy: { description: string } | null;
    assignments: Assignment[];
    changes: string[];
  };
  history: Array<{ version: number; createdAt: string; changes: string[] }>;
}

const CARD = 'border border-[#d9d5cb] bg-[#fbfaf7]';
const money = (v: number | null) => (v === null ? '—' : `$${v.toFixed(4)}`);

export default async function RouterPage() {
  let data: RouterResponse | null = null;
  let unreachable = false;
  let hasTraffic = false;
  try {
    data = await fetchOrRecover<RouterResponse>('/api/router');
    const activity = await fetchOrRecover<{ summary: { withRoutingDecision: number } }>('/api/routing-activity?limit=1');
    hasTraffic = activity.summary.withRoutingDecision > 0;
  } catch (e) {
    if (e instanceof ApiUnreachable) unreachable = true;
    else if (data === null) throw e;
  }

  return (
    <main className="mx-auto max-w-5xl">
      <div className="font-mono text-[12px] uppercase tracking-[0.14em] text-faint">
        your router · compiled from evidence
      </div>
      {unreachable || data === null ? (
        <p className={`mt-8 ${CARD} px-5 py-4 text-sm text-soft`}>
          The Potion API is not reachable — start <code className="font-mono">apps/server</code> and reload.
        </p>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <h1 className="font-mono text-[2rem] font-semibold tracking-[-0.02em] text-ink">{data.name}</h1>
            <span className="border border-accent px-2 py-0.5 font-mono text-[12px] uppercase tracking-[0.08em] text-accent">
              v{data.version}
            </span>
            <span className="font-mono text-[12px] text-faint">
              {data.routerHash} · minted {new Date(data.mintedAt).toLocaleDateString()}
            </span>
          </div>
          <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-soft">
            Your inference is unique. Your router should be too. Potion builds around your actual
            workload, quality bar, and economics — and recompiles it every time the evidence moves.
          </p>

          {/* ---- the rule it compiles under ---- */}
          <section className={`mt-8 ${CARD} px-6 py-4`}>
            <div className="font-mono text-[12px] uppercase tracking-[0.13em] text-faint">your rule</div>
            {data.document.policy ? (
              <p className="mt-1.5 text-[15px] text-ink">
                {data.document.policy.description}{' '}
                <Link href="/settings/controls" className="text-[13px] text-accent underline">change</Link>
              </p>
            ) : (
              <p className="mt-1.5 text-[14px] text-soft">
                No rule bound yet — <Link href="/settings/controls" className="text-accent underline">set your quality bar</Link>{' '}
                and Potion compiles your first router from it.
              </p>
            )}
          </section>

          {/* ---- the arc: how this becomes YOURS (comprehension pass) ---- */}
          <div className="mt-8">
            <RouterArc hasTraffic={hasTraffic} />
          </div>

          {/* ---- the assignments: where each kind of work routes, and why ---- */}
          <section className="mt-8">
            <div className="flex items-baseline justify-between border-b border-line pb-2 font-mono text-[12px] uppercase tracking-[0.14em] text-faint">
              <span className="text-soft">Assignments</span>
              <span>the serve path reads the same functions that built this table</span>
            </div>
            {data.document.assignments.length === 0 ? (
              <p className="py-6 font-mono text-[12px] text-faint">
                nothing routed yet — assignments appear as kinds of work gain measured frontiers
              </p>
            ) : (
              <div className={`mt-4 overflow-x-auto ${CARD}`}>
                <table className="w-full text-left font-mono text-[12.5px]">
                  <thead className="text-[11.5px] uppercase tracking-[0.12em] text-faint">
                    <tr className="border-b border-line">
                      <th className="px-4 py-2.5 font-normal">kind of work</th>
                      <th className="px-4 py-2.5 font-normal">routes to</th>
                      <th className="px-4 py-2.5 text-right font-normal">measured quality</th>
                      <th className="px-4 py-2.5 text-right font-normal">$ / 1K requests</th>
                      <th className="px-4 py-2.5 text-right font-normal">p95</th>
                      <th className="px-4 py-2.5 text-right font-normal">evidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.document.assignments.map((a) => (
                      <tr key={a.clusterId} className="border-b border-line/60 last:border-0">
                        <td className="px-4 py-2 text-ink">{a.clusterId}</td>
                        <td className="px-4 py-2 text-ink">
                          {a.strategy.label}
                          {a.fallback !== null ? <span className="ml-2 text-[11px] uppercase text-warn">fallback: {a.fallback}</span> : null}
                          {a.provenance !== 'live' ? <span className="ml-2 text-[11px] uppercase text-warn">{a.provenance}</span> : null}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-ink">{a.quality?.toFixed(3) ?? '—'}</td>
                        <td className="px-4 py-2 text-right tabular-nums text-ink">{money(a.costPer1K)}</td>
                        <td className="px-4 py-2 text-right tabular-nums text-soft">{a.latencyP95 !== null ? `${Math.round(a.latencyP95)} ms` : '—'}</td>
                        <td className="px-4 py-2 text-right">
                          <Link href={`/frontiers?cluster=${encodeURIComponent(a.clusterId)}`} className="text-accent underline">
                            {a.evidenceN !== null ? `n=${a.evidenceN} · ` : ''}frontier v{a.frontierVersion} · {a.alternatives} measured →
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-3 font-mono text-[12px] leading-relaxed text-faint">
              you never hand-assign a slice — change what you want (floors, ceilings, bans) in{' '}
              <Link href="/settings/controls" className="text-accent underline">Controls</Link> and Potion recompiles ·
              every number links to the measurement behind it
            </p>
          </section>

          {/* ---- what changed in this version ---- */}
          <section className={`mt-8 ${CARD} border-accent/40 px-6 py-4`}>
            <div className="font-mono text-[12px] uppercase tracking-[0.13em] text-accent">
              v{data.version} · what changed
            </div>
            <ul className="mt-2 grid gap-1 text-[13.5px] leading-relaxed text-ink">
              {data.document.changes.map((c, i) => <li key={i}>· {c}</li>)}
            </ul>
          </section>

          {/* ---- use it: the router's name is the model id ---- */}
          <section className={`mt-8 ${CARD} px-6 py-4`}>
            <div className="font-mono text-[12px] uppercase tracking-[0.13em] text-faint">use it</div>
            <pre className="mt-2 overflow-x-auto border border-[#d9d5cb] bg-white px-4 py-3 font-mono text-[12.5px] leading-relaxed text-ink">
{`model: '${data.name}'  // your router, by name — same routing as 'potion-auto'`}
            </pre>
          </section>

          {/* ---- version history ---- */}
          <section className="mt-8">
            <div className="border-b border-line pb-2 font-mono text-[12px] uppercase tracking-[0.14em] text-soft">
              Version history
            </div>
            <ol className="mt-3 grid gap-2.5">
              {data.history.map((v) => (
                <li key={v.version} className="flex gap-4">
                  <span className="w-20 shrink-0 font-mono text-[12px] tabular-nums text-faint">
                    v{v.version} · {new Date(v.createdAt).toLocaleDateString()}
                  </span>
                  <span className="min-w-0 text-[13px] leading-relaxed text-soft">
                    {v.changes.length > 0 ? v.changes.join(' · ') : '—'}
                  </span>
                </li>
              ))}
            </ol>
          </section>

          <p className="mt-12 font-mono text-[12px] leading-relaxed text-faint">
            a router version is a content hash over your rule, the measured frontiers, and the
            assignments they produce — it changes when the routing changes, never when a latency
            sample wiggles
          </p>
        </>
      )}
    </main>
  );
}
