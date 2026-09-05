'use client';

// THE COMPILER HOME (signed-in redesign, 2026-08-27). One protagonist: the
// compiler. Opening Potion reads, in order — what your plan is, what it
// saved, what needs you, what changed, how to steer it, how it decides,
// and every version it has been. Nothing here appears twice elsewhere;
// every element states money, needs a decision, invites play, or shows
// evidence. The old Today/Router split is gone.
//
// NAMING (2026-09-04): the product is a COMPILER; the artifact it emits is
// your PLAN. The `router*` symbols and /api/router path below are storage and
// wire spellings, deliberately left alone — see docs/NAMING.md.
//
// Taste rules (operator brief, 2026-08-27): typography carries the header —
// no boxes above the fold; ONE hero number; the composition is a single
// thin stacked bar, never a tile row; proposals act in place; narration
// reads like a person; exactly three things animate (the number, the
// composition bar drawing in once, a proposal settling) and
// prefers-reduced-motion kills all of them. "Maintained" is never claimed
// where it cannot be verified — the rule itself is shown instead.
import { Fragment, useEffect, useMemo, useState } from 'react';
import { priceVsBaseline } from '@/lib/price-words';
import Link from 'next/link';
import type { Policy } from '@potion/core';
import type { ConnectionResponse, RoutingActivityResponse } from '@/lib/types';
import { TodayPulse } from '@/components/today-pulse';
import { BarProposal } from '@/components/bar-proposal';
import { ChallengerProposal } from '@/components/challenger-proposal';
import { DiscoveredWorkloads } from '@/components/discovered-workloads';
import { OutcomesNudge } from '@/components/outcomes-nudge';
import { LoopStatus } from '@/components/loop-status';
import { WeeklyBrief } from '@/components/weekly-brief';
import { RouterPriorities } from '@/components/router-priorities';
import { RouterArc } from '@/components/router-arc';
import { AgentInstructions } from '@/components/agent-instructions';
import { ServingKeys } from '@/components/serving-keys';
import { ReceiptCard } from '@/components/primitives';
import { CopyBlock } from '@/components/copy-block';
import { FIRST_RECEIPT_KEY } from '@/components/first-run';
import type { Receipt } from '@/components/try-request';

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
  /** G1 Outcome API: the customer's own application's verdicts on this
   * assignment's answers — ground truth, its own instrument. Absent when
   * the window holds nothing. */
  outcomes?: {
    instrument: 'customer-outcomes';
    windowDays: number;
    requests: number;
    success: { n: number; rate: number; ci: [number, number] } | null;
    score: { n: number; mean: number; ci: [number, number] } | null;
    human: { accepted: number; edited: number; rejected: number; regenerated: number } | null;
    otherStrategyRequests: number;
  };
  /** Shadow evidence measured on THIS org's traffic (serve-judge instrument
   * — its own scale, never the suite-measured quality column). Absent when
   * the window holds nothing. */
  shadow?: {
    instrument: 'serve-judge';
    windowDays: number;
    servingObserved: { n: number; quality: number; qualityCi: [number, number] } | null;
    servingMeasuredCostPer1K: number | null;
    challengers: Array<{
      strategyHash: string;
      model: string;
      n: number;
      quality: number;
      qualityCi: [number, number];
      samples: number;
      costPer1K: number;
      latencyP95: number;
      qualifies: boolean;
      reason: string;
    }>;
  };
}

interface RouterResponse {
  name: string;
  version: number;
  routerHash: string;
  mintedAt: string;
  document: {
    policy: { description: string; config?: Policy } | null;
    assignments: Assignment[];
    changes: string[];
    interpreted?: { summary: string; mix: Array<{ clusterId: string; share: number }> };
    expected?: { quality: number; costPer1K: number; baselineCostPer1K: number; baselineQuality?: number; savingsPct: number } | null;
  };
  history: Array<{ version: number; createdAt: string; changes: string[] }>;
}

const HAIR = 'border-[#d9d5cb]';

/** Deterministic ink tint per workload for the composition bar — hue from
 * the cluster id, muted to sit on paper (identity, not decoration). */
function tintOf(clusterId: string): string {
  let h = 0;
  for (const c of clusterId) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 28% 46%)`;
}

/** The composition: ONE thin stacked bar + a legend that doubles as the
 * assignment summary. Shares come from real traffic when it exists, else
 * the described mix. */
function Composition({
  assignments,
  mix,
  byCluster,
  total,
}: {
  assignments: Assignment[];
  mix: Array<{ clusterId: string; share: number }> | null;
  byCluster: Record<string, number> | null;
  total: number;
}) {
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return setDrawn(true);
    const t = setTimeout(() => setDrawn(true), 60);
    return () => clearTimeout(t);
  }, []);

  const shares: Array<{ clusterId: string; share: number; from: 'traffic' | 'described' }> = useMemo(() => {
    if (byCluster && total > 0) {
      return Object.entries(byCluster)
        .map(([clusterId, n]) => ({ clusterId, share: n / total, from: 'traffic' as const }))
        .sort((a, b) => b.share - a.share);
    }
    if (mix && mix.length > 0) return mix.map((m) => ({ ...m, from: 'described' as const }));
    return [];
  }, [byCluster, mix, total]);

  if (shares.length === 0) return null;
  const from = shares[0]!.from;

  return (
    <div className="mt-7" data-testid="composition">
      <div className={`flex items-baseline justify-between border-b ${HAIR} pb-2 font-mono text-[12px] uppercase tracking-[0.14em] text-faint`}>
        <span className="text-soft">Composition</span>
        <span>{from === 'traffic' ? 'from your recent traffic' : 'at your described mix — traffic corrects this'}</span>
      </div>
      <div className="mt-4 flex h-[6px] w-full overflow-hidden bg-[#e9e6dd]">
        {shares.map((s) => (
          <div
            key={s.clusterId}
            className="h-full transition-[width] duration-700 ease-out motion-reduce:transition-none"
            style={{ width: drawn ? `${s.share * 100}%` : '0%', background: tintOf(s.clusterId) }}
          />
        ))}
      </div>
      <div className="mt-3 grid gap-1.5">
        {shares.slice(0, 6).map((s) => {
          const a = assignments.find((x) => x.clusterId === s.clusterId);
          return (
            <div key={s.clusterId} className="flex items-baseline gap-3 font-mono text-[12.5px]">
              <span aria-hidden className="inline-block h-[8px] w-[8px] shrink-0 self-center" style={{ background: tintOf(s.clusterId) }} />
              <span className="w-12 shrink-0 text-right tabular-nums text-ink">{Math.round(s.share * 100)}%</span>
              <span className="text-soft">{s.clusterId}</span>
              {a ? (
                <span className="min-w-0 truncate text-faint">
                  → {a.strategy.label}
                  {a.quality !== null ? ` · q ${a.quality.toFixed(2)}` : ''}
                  {a.provenance !== 'live' ? ` · ${a.provenance}` : ''}
                </span>
              ) : (
                <span className="text-faint">→ not yet measured</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The assignments detail — a precision instrument, tucked below the fold. */
function AssignmentsTable({ assignments }: { assignments: Assignment[] }) {
  if (assignments.length === 0) return null;
  return (
    <div className="mt-10" id="assignments">
      <div className={`flex items-baseline justify-between border-b ${HAIR} pb-2 font-mono text-[12px] uppercase tracking-[0.14em] text-faint`}>
        <span className="text-soft">How it decides</span>
        <span>the serve path reads the same functions that built this table</span>
      </div>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-left font-mono text-[12.5px]">
          <thead className="text-[11.5px] uppercase tracking-[0.12em] text-faint">
            <tr className={`border-b ${HAIR}`}>
              <th className="py-2.5 pr-4 font-normal">kind of work</th>
              <th className="py-2.5 pr-4 font-normal">routes to</th>
              <th className="py-2.5 pr-4 text-right font-normal">quality</th>
              <th className="py-2.5 pr-4 text-right font-normal">$ / 1K</th>
              <th className="py-2.5 pr-4 text-right font-normal">p95</th>
              <th className="py-2.5 text-right font-normal">evidence</th>
            </tr>
          </thead>
          <tbody>
            {assignments.map((a) => (
              <Fragment key={a.clusterId}>
                <tr className="border-b border-dashed border-[#e9e6dd] last:border-0">
                  <td className="py-2 pr-4 text-ink">{a.clusterId}</td>
                  <td className="py-2 pr-4 text-ink">
                    {a.strategy.label}
                    {a.fallback !== null ? <span className="ml-2 text-[11px] uppercase text-warn">fallback</span> : null}
                    {a.provenance !== 'live' ? <span className="ml-2 text-[11px] uppercase text-warn">{a.provenance}</span> : null}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">{a.quality?.toFixed(3) ?? '—'}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{a.costPer1K !== null ? `$${a.costPer1K.toFixed(4)}` : '—'}</td>
                  <td className="py-2 pr-4 text-right tabular-nums text-soft">{a.latencyP95 !== null ? `${Math.round(a.latencyP95)}ms` : '—'}</td>
                  <td className="py-2 text-right">
                    <Link href={`/frontiers?cluster=${encodeURIComponent(a.clusterId)}`} className="text-accent hover:underline">
                      {a.evidenceN !== null ? `n=${a.evidenceN} · ` : ''}v{a.frontierVersion} →
                    </Link>
                  </td>
                </tr>
                {a.outcomes ? (
                  <tr className="border-b border-dashed border-[#e9e6dd] last:border-0">
                    <td colSpan={6} className="py-1.5 pl-4 text-[12px] text-faint">
                      <span className="uppercase tracking-[0.1em]">your app&apos;s verdicts · {a.outcomes.windowDays}d</span>
                      <span className="ml-3 text-soft">{a.outcomes.requests} request{a.outcomes.requests === 1 ? '' : 's'}</span>
                      {a.outcomes.success !== null ? (
                        <span className="ml-3 text-soft">
                          success {(a.outcomes.success.rate * 100).toFixed(1)}% [{(a.outcomes.success.ci[0] * 100).toFixed(0)}–{(a.outcomes.success.ci[1] * 100).toFixed(0)}] · n={a.outcomes.success.n}
                        </span>
                      ) : null}
                      {a.outcomes.score !== null ? (
                        <span className="ml-3 text-soft">
                          score {a.outcomes.score.mean.toFixed(3)} [{a.outcomes.score.ci[0].toFixed(3)}–{a.outcomes.score.ci[1].toFixed(3)}] · n={a.outcomes.score.n}
                        </span>
                      ) : null}
                      {a.outcomes.human !== null ? (
                        <span className="ml-3">
                          {a.outcomes.human.accepted} accepted · {a.outcomes.human.edited} edited · {a.outcomes.human.rejected} rejected · {a.outcomes.human.regenerated} regenerated
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ) : null}
                {a.shadow && (a.shadow.challengers.length > 0 || a.shadow.servingObserved !== null) ? (
                  <tr className="border-b border-dashed border-[#e9e6dd] last:border-0">
                    <td colSpan={6} className="py-1.5 pl-4 text-[12px] text-faint">
                      <span className="uppercase tracking-[0.1em]">on your traffic · {a.shadow.windowDays}d · serve judge</span>
                      {a.shadow.servingObserved !== null ? (
                        <span className="ml-3 text-soft">
                          serving scored {a.shadow.servingObserved.quality.toFixed(3)} [{a.shadow.servingObserved.qualityCi[0].toFixed(3)}–{a.shadow.servingObserved.qualityCi[1].toFixed(3)}] · n={a.shadow.servingObserved.n}
                        </span>
                      ) : null}
                      {a.shadow.challengers.map((c) => (
                        <span key={c.strategyHash} className={`ml-3 ${c.qualifies ? 'text-accent' : ''}`}>
                          {c.model} {c.n > 0 ? `${c.quality.toFixed(3)} [${c.qualityCi[0].toFixed(3)}–${c.qualityCi[1].toFixed(3)}]` : 'unscored'} · ${c.costPer1K.toFixed(4)}/1K · {c.qualifies ? 'qualifies' : c.reason}
                        </span>
                      ))}
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 font-mono text-[12px] text-faint">
        you never hand-assign — change what you want above and Potion recompiles
      </p>
    </div>
  );
}

/** Versions: a quiet rule-line timeline — latest expanded, history one line each.
 * The viewer-local dates below are hydration-safe ONLY because `router` arrives
 * by client fetch (null during SSR, so this never renders on the server). If an
 * `initialRouter` SSR prop is ever added, these need the fe49252 treatment
 * (mounted-gate or a pinned format) or the home page throws React #418. */
function Versions({ history }: { history: RouterResponse['history'] }) {
  if (history.length === 0) return null;
  const [head, ...rest] = history;
  return (
    <div className="mt-10" id="versions">
      <div className={`border-b ${HAIR} pb-2 font-mono text-[12px] uppercase tracking-[0.14em] text-soft`}>Versions</div>
      <div className={`mt-3 border-l ${HAIR} pl-5`}>
        <div className="relative">
          <span aria-hidden className="absolute -left-[23px] top-[7px] h-[7px] w-[7px] bg-accent" />
          <div className="font-mono text-[12px] text-faint">
            v{head!.version} · {new Date(head!.createdAt).toLocaleDateString()} · current
          </div>
          <ul className="mt-1 grid gap-0.5 text-[13.5px] leading-relaxed text-soft">
            {head!.changes.map((c, i) => <li key={i}>{c}</li>)}
          </ul>
        </div>
        {rest.slice(0, 8).map((v) => (
          <div key={v.version} className="relative mt-3">
            <span aria-hidden className="absolute -left-[22px] top-[8px] h-[5px] w-[5px] bg-[#c4bfb2]" />
            <p className="font-mono text-[12px] leading-relaxed text-faint">
              v{v.version} · {new Date(v.createdAt).toLocaleDateString()} ·{' '}
              <span className="text-soft">{v.changes[0] ?? '—'}</span>
              {v.changes.length > 1 ? ` · +${v.changes.length - 1} more` : ''}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function RouterHome({
  conn,
  initialActivity = null,
}: {
  conn: ConnectionResponse;
  initialActivity?: RoutingActivityResponse | null;
}) {
  const [activity, setActivity] = useState<RoutingActivityResponse | null>(initialActivity);
  const [router, setRouter] = useState<RouterResponse | null>(null);
  const [role, setRole] = useState<'admin' | 'member' | 'viewer'>('viewer');
  const [trial, setTrial] = useState<Receipt | null>(null);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(FIRST_RECEIPT_KEY);
      if (raw) setTrial((t) => t ?? (JSON.parse(raw) as Receipt));
    } catch { /* private mode */ }
  }, []);

  useEffect(() => {
    const j = (u: string) => fetch(u, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    void j('/api/router').then((b) => b && setRouter(b as RouterResponse));
    void j('/api/auth/me').then((b) => { const r = (b as { role?: string } | null)?.role; if (r === 'admin' || r === 'member' || r === 'viewer') setRole(r); });
    if (initialActivity === null) {
      void j('/api/routing-activity?limit=100').then((b) => b && setActivity(b as RoutingActivityResponse));
    }
  }, [initialActivity]);

  const routing = (activity?.summary?.withRoutingDecision ?? 0) > 0 || trial !== null;
  const doc = router?.document ?? null;

  // "N improvements this month": versions minted this calendar month beyond
  // the one you started it on — an honest count of movement, linked to it.
  const improvements = useMemo(() => {
    if (!router) return 0;
    const now = new Date();
    return router.history.filter((v) => {
      const d = new Date(v.createdAt);
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && v.version > 1;
    }).length;
  }, [router]);

  return (
    <div className="max-w-4xl">
      {/* ================= the protagonist — typography only ================= */}
      <header>
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h1 className="font-mono text-[1.9rem] font-semibold tracking-[-0.02em] text-ink sm:text-[2.2rem]">
            {router?.name ?? conn.router?.name ?? 'your plan'}
          </h1>
          {router && (
            <span className="border border-accent px-2 py-0.5 font-mono text-[11.5px] uppercase tracking-[0.08em] text-accent">
              v{router.version}{routing ? '' : ' · provisional'}
            </span>
          )}
          {improvements > 0 && (
            <a href="#versions" className="font-mono text-[12px] text-kept hover:underline">
              {improvements} improvement{improvements === 1 ? '' : 's'} this month →
            </a>
          )}
        </div>
        <p className="mt-2 font-mono text-[12.5px] leading-relaxed text-faint">
          {doc?.policy ? <span className="text-soft">{doc.policy.description}</span> : 'no rule bound yet'}
          {doc?.interpreted ? <> · built for: {doc.interpreted.summary}</> : null}
        </p>
      </header>

      {routing ? (
        <>
          {/* ============ the number + the narration (existing physics) ============ */}
          <div className="mt-9"><TodayPulse /></div>

          {/* ============ needs you — acts in place, then leaves ============ */}
          <BarProposal />
          <ChallengerProposal />

          {/* ============ composition: one thin bar ============ */}
          {doc && (
            <Composition
              assignments={doc.assignments}
              mix={doc.interpreted?.mix ?? null}
              byCluster={activity?.summary?.byCluster ?? null}
              total={Object.values(activity?.summary?.byCluster ?? {}).reduce((a, b) => a + b, 0)}
            />
          )}

          <WeeklyBrief />

          {/* ============ steer it ============ */}
          {doc && (
            <div className="mt-10">
              <RouterPriorities
                currentPolicy={doc.policy?.config ?? null}
                currentAssignments={doc.assignments}
                currentExpected={doc.expected ?? null}
                role={role}
              />
            </div>
          )}

          {doc && <AssignmentsTable assignments={doc.assignments} />}
          <LoopStatus
            hasOutcomes={doc === null ? null : doc.assignments.some((a) => a.outcomes != null)}
            hasShadow={doc === null ? null : doc.assignments.some((a) => a.shadow != null)}
          />
          <OutcomesNudge
            routedRequests={activity?.summary?.routed ?? 0}
            assignments={doc?.assignments ?? null}
          />
          <DiscoveredWorkloads />
          {router && <Versions history={router.history} />}

          {/* ============ the quiet contract line ============ */}
          <p className={`mt-12 border-t ${HAIR} pt-4 font-mono text-[12px] leading-relaxed text-faint`}>
            {activity && activity.summary.withRoutingDecision > 0 && (
              <>
                {activity.summary.routed} of {activity.summary.withRoutingDecision} recent requests routed on a measured frontier ·{' '}
                <Link href="/receipts" className="text-accent hover:underline">receipts →</Link>
                {' · '}
              </>
            )}
            {conn.baseUrl}/v1 · {conn.servingKeys.filter((k) => !k.revokedAt).length} key{conn.servingKeys.filter((k) => !k.revokedAt).length === 1 ? '' : 's'}{' '}
            (<Link href="/settings/keys" className="text-accent hover:underline">manage</Link>)
            {' · '}<Link href="/settings/controls" className="text-accent hover:underline">controls</Link>
          </p>
        </>
      ) : (
        <>
          {/* ============ pre-traffic: ready for its first request ============ */}
          <p className="mt-6 max-w-2xl text-[15px] leading-relaxed text-soft">
            Your plan is compiled and waiting for its first request. Point your client at it —
            everything below is the whole integration.
          </p>

          {doc?.expected && (
            <p className="mt-3 font-mono text-[13px] text-soft">
              expected at your described mix:{' '}
              <span className="text-ink">{(doc.expected.quality * 100).toFixed(1)}% quality</span> ·{' '}
              <span className="text-ink">${doc.expected.costPer1K.toFixed(2)}/1K requests</span> ·{' '}
              <span className="font-semibold text-kept">{priceVsBaseline(doc.expected.costPer1K, doc.expected.baselineCostPer1K)} vs the best scorer everywhere</span>
            </p>
          )}

          <div className="mt-8"><RouterArc hasTraffic={false} /></div>

          {trial && <div className="mt-8"><ReceiptCard r={trial} subtitle="your first request" /></div>}

          <section className={`mt-10 border-t ${HAIR} pt-8`}>
            <h2 className="text-[1.2rem] font-medium tracking-[-0.01em] text-ink">Your key</h2>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-soft">
              Shown once; Potion keeps only a hash. Issue another any time in Settings.
            </p>
            <div className="mt-4"><ServingKeys initial={conn.servingKeys} /></div>
          </section>

          <section className={`mt-10 border-t ${HAIR} pt-8`}>
            <h2 className="text-[1.2rem] font-medium tracking-[-0.01em] text-ink">Change one line</h2>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-soft">
              Potion speaks the OpenAI chat protocol — requests, streaming, and tool calls stay as
              they are. Or hand the instructions to your coding agent.
            </p>
            <div className="mt-4 space-y-4">
              <AgentInstructions baseUrl={conn.baseUrl} routerModel={conn.router?.name} />
              <CopyBlock label="Base URL" text={`${conn.baseUrl}/v1`} />
              {conn.snippets && <CopyBlock label="Node.js (openai SDK)" text={conn.snippets.openaiNode} />}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
