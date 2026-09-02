'use client';

// TODAY'S PULSE (S2, brief v4): the kept counter, the narrated feed, and the
// needs-you list — composed client-side from reads that already exist
// (usage/current, frontier-changelog, learning, budgets). Day-2-first: a
// $0.00 counter with three receipts must be as calm and honest as $18k.
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { priceVsBaseline } from '@/lib/price-words';
import { Stamp } from '@/components/primitives';
import type { UsageCurrentResponse } from '@/lib/types';

interface ChangelogEntry {
  clusterId: string;
  name: string;
  kind: 'held-back' | 'applied';
  fromVersion: number;
  toVersion: number;
  at: string;
  narrative: string;
}

interface LearningState {
  incumbents: { models: string[]; other: string | null } | null;
  samples: Record<string, number>;
  proposals: Array<{ clusterId: string; status: string; suggestedFloor?: number }>;
}

interface BudgetState {
  budget: { monthlyCapUsd: number; hardStop: boolean } | null;
  mtdUsd: number;
}

const POLL_MS = 15_000;

/** Ease the displayed number toward the target so new receipts feel alive
 * without ever lying: the target is always the server's number. */
function useEased(target: number): number {
  const [shown, setShown] = useState(target);
  const raf = useRef<number | null>(null);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return setShown(target);
    const start = shown;
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 900);
      setShown(start + (target - start) * (1 - Math.pow(1 - k, 3)));
      if (k < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => { if (raf.current) cancelAnimationFrame(raf.current); };
  }, [target]); // deliberately not depending on `shown`: each new target eases from the currently displayed value
  return shown;
}

export function TodayPulse() {
  const [current, setCurrent] = useState<UsageCurrentResponse | null>(null);
  const [log, setLog] = useState<ChangelogEntry[] | null>(null);
  const [learning, setLearning] = useState<LearningState | null>(null);
  const [budget, setBudget] = useState<BudgetState | null>(null);
  const [feedOpen, setFeedOpen] = useState(false);
  const [router, setRouter] = useState<{ name: string; version: number; mintedAt: string; document: { changes: string[] } } | null>(null);
  const [labRecent, setLabRecent] = useState<Array<{ runId: string; harnessName: string; state: string; at: string; judgeOverall: number | null }> | null>(null);

  useEffect(() => {
    const j = (u: string) => fetch(u, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const loadFast = () => void j('/api/usage/current').then((b) => b && setCurrent(b as UsageCurrentResponse));
    loadFast();
    void j('/api/frontier-changelog').then((b) => b && setLog(((b as { entries?: ChangelogEntry[] }).entries ?? [])));
    void j('/api/learning').then((b) => b && setLearning(b as LearningState));
    void j('/api/budgets').then((b) => b && setBudget(b as BudgetState));
    void j('/api/router').then((b) => b && setRouter(b as { name: string; version: number; mintedAt: string; document: { changes: string[] } }));
    void j('/api/lab/recent').then((b) => b && setLabRecent(((b as { runs?: Array<{ runId: string; harnessName: string; state: string; at: string; judgeOverall: number | null }> }).runs ?? [])));
    const t = setInterval(loadFast, POLL_MS);
    const onFocus = () => loadFast();
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(t); window.removeEventListener('focus', onFocus); };
  }, []);

  const kept = current ? Math.max(0, (current.mtd.baselineCostUsd ?? 0) - current.mtd.costUsd) : 0;
  const shown = useEased(kept);
  const spentWithout = current ? (current.mtd.baselineCostUsd ?? 0) : 0;
  const actualSpend = current?.mtd.costUsd ?? 0;
  // Day-2 honesty: cents-rounding tiny sums turns "kept $0.0186 of $0.0189"
  // into "kept $0.02 of $0.02" — a 98% claim rounded into a 100% one.
  const money = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`);
  // 2026-09-01 (caption-vs-provenance, found on the operator's screen at
  // the ≥$1 tier: "kept $1.32 of $1.32"): the SAME hazard survives above a
  // dollar — kept $1.3158 and baseline $1.3162 both round to $1.32, a
  // 99.7% measurement rendered as an impossible 100%. The honest rounding
  // direction is fixed: KEPT always floors (never overstated), the
  // baseline always ceils, and the actual spend is SHOWN — three numbers
  // that add up beat two that collide.
  const moneyFloor = (n: number) => { const f = n >= 1 ? 100 : 10_000; return `$${(Math.floor(n * f) / f).toFixed(n >= 1 ? 2 : 4)}`; };
  const moneyCeil = (n: number) => { const f = n >= 1 ? 100 : 10_000; return `$${(Math.ceil(n * f) / f).toFixed(n >= 1 ? 2 : 4)}`; };
  const hasTraffic = (current?.mtd.requests ?? 0) > 0;
  const hasBaseline = spentWithout > 0;

  // ---- needs-you, composed; each ask carries its time cost ----
  const needs: Array<{ text: string; href: string; time: string }> = [];
  if (learning && learning.incumbents && learning.incumbents.models.length === 0) {
    needs.push({
      text: 'Name what you use today — it turns your savings line from an estimate against the premium pick into a measurement against your own model.',
      href: '/settings/controls',
      time: '2 min',
    });
  }
  if (budget?.budget && budget.budget.monthlyCapUsd > 0 && budget.mtdUsd / budget.budget.monthlyCapUsd >= 0.7) {
    needs.push({
      text: `Budget at ${Math.round((budget.mtdUsd / budget.budget.monthlyCapUsd) * 100)}% of $${budget.budget.monthlyCapUsd.toFixed(0)}.`,
      href: '/settings/controls',
      time: '1 min',
    });
  }

  // ---- the feed (redesign 2026-08-27: operator "two things max, and I
  // don't get the value"). Three rules now govern it:
  //   1. HUMAN SENTENCES, never engine narrative — a re-measure is COUNTED
  //      ("3 options proved in, 7 beaten out"), not recited per strategy;
  //   2. every line answers "what does this mean for MY router";
  //   3. two lines show; the rest live behind one quiet toggle.
  const routerFresh =
    router !== null && router.version > 1 &&
    Date.now() - new Date(router.mintedAt).getTime() < 14 * 86_400_000
      ? router
      : null;
  const sampling = learning
    ? Object.entries(learning.samples).filter(([, n]) => n > 0).sort(([, a], [, b]) => b - a).slice(0, 2)
    : [];

  interface FeedItem { key: string; when: string; head: string; rest: React.ReactNode; href: string; link: string }
  const feedItems: FeedItem[] = [];
  // X3 UX: worker deliverables land in the SAME feed as router news — the
  // product's two halves finally meet on one surface.
  for (const r of (labRecent ?? []).filter((x) => x.state === 'completed').slice(0, 2)) {
    feedItems.push({
      key: `lab-${r.runId}`,
      when: new Date(r.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      head: `${r.harnessName} filed its check`,
      rest: <>{r.judgeOverall !== null ? <>{' — '}scored {r.judgeOverall}/10 against your bar (advisory)</> : <>{' — '}receipts on every step</>}</>,
      href: `/lab/run/${r.runId}`, link: 'read it →',
    });
  }
  if (routerFresh !== null) {
    feedItems.push({
      key: 'router',
      when: new Date(routerFresh.mintedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      head: `Your router moved to v${routerFresh.version}`,
      rest: <>{' — '}{routerFresh.document.changes[0] ?? ''}{routerFresh.document.changes.length > 1 ? ` · +${routerFresh.document.changes.length - 1} more` : ''}</>,
      href: '/', link: `v${routerFresh.version} →`,
    });
  }
  for (const m of (log ?? []).slice(0, 6)) {
    // Count the engine narrative instead of reciting it: N proved in, M out.
    const added = (m.narrative.match(/is new on the frontier/g) ?? []).length;
    const dropped = (m.narrative.match(/fell off the frontier/g) ?? []).length;
    const summary =
      added > 0 || dropped > 0
        ? [
            added > 0 ? `${added} option${added === 1 ? '' : 's'} proved in` : null,
            dropped > 0 ? `${dropped} beaten out` : null,
          ].filter(Boolean).join(', ')
        : (m.narrative.split('. ')[0] ?? '').slice(0, 90);
    feedItems.push({
      key: `${m.clusterId}-${m.toVersion}`,
      when: new Date(m.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      head: `${m.name} re-measured`,
      rest: <>{' — '}{summary}.{m.kind === 'held-back' ? <> Your pin is holding v{m.fromVersion}.</> : <> Your router re-checks its pick against this automatically.</>}</>,
      href: '/settings/frontier', link: `v${m.toVersion} →`,
    });
  }
  for (const [cid, n] of sampling) {
    feedItems.push({
      key: `sampling-${cid}`,
      when: 'this week',
      head: `Measuring your ${cid}`,
      rest: <>{' — '}{n} sample{n === 1 ? '' : 's'} toward your own quality bar for this work.</>,
      href: '/settings/controls', link: 'details →',
    });
  }

  return (
    <div>
      <div className="font-mono text-[12px] uppercase tracking-[0.14em] text-faint">
        {/* pinned to UTC/en-US: the MTD numbers below run on the UTC calendar
            month (usage.ts monthStart), so this label must name THAT month —
            and a viewer-dependent render here breaks hydration (React #418:
            SSR runs in the prod container's UTC/en-US ICU, the browser in the
            viewer's locale, and the month NAME differs on every load for a
            non-English browser, not just at month boundaries) */}
        {new Date().toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' })} · live
      </div>
      {/* 2026-09-01 (operator, twice: "i still dont think thats right"):
          dollars "kept" of money never committed is the wrong hero no
          matter how it rounds. The house formula (price-words, endorsed on
          the landing page) leads with the RATIO and NAMES the comparator:
          "1/270th the price of the best scorer". The pulse now speaks the
          same sentence: ratio hero, named comparator, real spend shown,
          receipts claim carried. */}
      <div className="mt-2 font-sans text-[2.6rem] font-semibold leading-none tracking-[-0.03em] text-kept tabular-nums sm:text-[3.4rem]">
        {hasBaseline && actualSpend > 0 ? priceVsBaseline(actualSpend, spentWithout) : moneyFloor(shown)}
      </div>
      <p className="mt-2 text-[14px] leading-relaxed text-soft">
        {hasBaseline && actualSpend > 0 ? (
          <>the price of the best scorer on your own requests this month — you spent <span className="text-ink">{money(actualSpend)}</span> where it would have billed <span className="text-ink">{moneyCeil(spentWithout)}</span>, verified receipt by receipt</>
        ) : hasBaseline ? (
          <>measured against the best scorer on your own requests — <span className="text-ink">{moneyCeil(spentWithout)}</span> of counterfactual, nothing spent yet</>
        ) : hasTraffic ? (
          <>kept so far — your savings become a measurement against <em>your</em> model once you name it in <Link href="/settings/controls" className="text-accent underline">Controls</Link></>
        ) : (
          <>kept so far. Send traffic to your endpoint and this number starts moving.</>
        )}
      </p>

      {feedItems.length > 0 && (
        <div className="mt-7">
          <div className="flex items-baseline justify-between border-b border-[#c4bfb2] pb-2 font-mono text-[11.5px] uppercase tracking-[0.14em] text-faint">
            <span>Lately</span>
            <span>your router recompiles from these — every line links to evidence</span>
          </div>
          {feedItems.slice(0, feedOpen ? feedItems.length : 2).map((f) => (
            <div key={f.key} className="grid grid-cols-[86px_1fr_auto] items-baseline gap-3 border-b border-dashed border-[#d9d5cb] py-2.5 text-[13.5px] text-soft">
              <span className="font-mono text-[12px] text-faint">{f.when}</span>
              <span><span className="font-medium text-ink">{f.head}</span>{f.rest}</span>
              <Link href={f.href} className="font-mono text-[12px] text-accent">{f.link}</Link>
            </div>
          ))}
          {feedItems.length > 2 && (
            <button
              type="button"
              onClick={() => setFeedOpen((o) => !o)}
              className="mt-2 font-mono text-[12px] text-faint hover:text-accent"
              data-testid="feed-toggle"
            >
              {feedOpen ? 'show less ↑' : `show ${feedItems.length - 2} more ↓`}
            </button>
          )}
        </div>
      )}

      <div className="mt-7">
        <div className="flex items-baseline justify-between border-b border-[#c4bfb2] pb-2 font-mono text-[11.5px] uppercase tracking-[0.14em] text-faint">
          <span>Needs you</span>
          <span>{needs.length === 0 ? '' : `${needs.length} item${needs.length === 1 ? '' : 's'}`}</span>
        </div>
        {needs.length === 0 ? (
          <p className="py-2.5 text-[13.5px] text-faint">Nothing. The asks, when there are any, arrive here and nowhere else.</p>
        ) : (
          needs.map((n) => (
            <div key={n.href + n.time} className="grid grid-cols-[86px_1fr_auto] items-baseline gap-3 border-b border-dashed border-[#d9d5cb] py-2.5 text-[13.5px] text-soft">
              <span><Stamp kind="attention">{n.time}</Stamp></span>
              <span>{n.text}</span>
              <Link href={n.href} className="font-mono text-[12px] text-accent">fix →</Link>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
