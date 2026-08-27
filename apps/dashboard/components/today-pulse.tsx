'use client';

// TODAY'S PULSE (S2, brief v4): the kept counter, the narrated feed, and the
// needs-you list — composed client-side from reads that already exist
// (usage/current, frontier-changelog, learning, budgets). Day-2-first: a
// $0.00 counter with three receipts must be as calm and honest as $18k.
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
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

  useEffect(() => {
    const j = (u: string) => fetch(u, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const loadFast = () => void j('/api/usage/current').then((b) => b && setCurrent(b as UsageCurrentResponse));
    loadFast();
    void j('/api/frontier-changelog').then((b) => b && setLog(((b as { entries?: ChangelogEntry[] }).entries ?? [])));
    void j('/api/learning').then((b) => b && setLearning(b as LearningState));
    void j('/api/budgets').then((b) => b && setBudget(b as BudgetState));
    const t = setInterval(loadFast, POLL_MS);
    const onFocus = () => loadFast();
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(t); window.removeEventListener('focus', onFocus); };
  }, []);

  const kept = current ? Math.max(0, (current.mtd.baselineCostUsd ?? 0) - current.mtd.costUsd) : 0;
  const shown = useEased(kept);
  const spentWithout = current ? (current.mtd.baselineCostUsd ?? 0) : 0;
  // Day-2 honesty: cents-rounding tiny sums turns "kept $0.0186 of $0.0189"
  // into "kept $0.02 of $0.02" — a 98% claim rounded into a 100% one.
  const money = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`);
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

  // ---- the narrated feed: frontier movements + the learning week ----
  const moves = (log ?? []).slice(0, 3);
  const sampling = learning
    ? Object.entries(learning.samples).filter(([, n]) => n > 0).sort(([, a], [, b]) => b - a).slice(0, 2)
    : [];

  return (
    <div>
      <div className="font-mono text-[12px] uppercase tracking-[0.14em] text-faint">
        {new Date().toLocaleDateString(undefined, { month: 'long' })} · live
      </div>
      <div className="mt-2 font-sans text-[2.6rem] font-semibold leading-none tracking-[-0.03em] text-kept tabular-nums sm:text-[3.4rem]">
        {money(shown)}
      </div>
      <p className="mt-2 text-[14px] leading-relaxed text-soft">
        {hasBaseline ? (
          <>kept this month, of <span className="text-ink">{money(spentWithout)}</span> you would have spent — verified receipt by receipt</>
        ) : hasTraffic ? (
          <>kept so far — your savings become a measurement against <em>your</em> model once you name it in <Link href="/settings/controls" className="text-accent underline">Controls</Link></>
        ) : (
          <>kept so far. Send traffic to your endpoint and this number starts moving.</>
        )}
      </p>

      {(moves.length > 0 || sampling.length > 0) && (
        <div className="mt-7">
          <div className="flex items-baseline justify-between border-b border-[#c4bfb2] pb-2 font-mono text-[11.5px] uppercase tracking-[0.14em] text-faint">
            <span>Lately, narrated</span>
            <span>every line links to its evidence</span>
          </div>
          {moves.map((m) => (
            <div key={`${m.clusterId}-${m.toVersion}`} className="grid grid-cols-[86px_1fr_auto] items-baseline gap-3 border-b border-dashed border-[#d9d5cb] py-2.5 text-[13.5px] text-soft">
              <span className="font-mono text-[12px] text-faint">{new Date(m.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
              <span>
                <span className="font-medium text-ink">{m.name}</span>{' '}
                {m.kind === 'held-back' ? <>— a newer frontier exists; your pin is holding v{m.fromVersion}. </> : null}
                {m.narrative}
              </span>
              <Link href="/settings/frontier" className="font-mono text-[12px] text-accent">v{m.toVersion} →</Link>
            </div>
          ))}
          {sampling.map(([cid, n]) => (
            <div key={cid} className="grid grid-cols-[86px_1fr_auto] items-baseline gap-3 border-b border-dashed border-[#d9d5cb] py-2.5 text-[13.5px] text-soft">
              <span className="font-mono text-[12px] text-faint">this week</span>
              <span><span className="font-medium text-ink">Measuring your {cid}</span> — {n} sample{n === 1 ? '' : 's'} so far; your personal bar proposal arrives as coverage fills.</span>
              <Link href="/settings/controls" className="font-mono text-[12px] text-accent">details →</Link>
            </div>
          ))}
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
