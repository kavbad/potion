'use client';

// THE MONDAY BRIEF (S4, brief v4): the week, as a letter from the
// measurement engine — first person, receipts one click away, at most one
// ask. Deterministic v1: composed from reads that already exist (usage
// window, changelog, learning, budgets), no writer model, no storage — so
// it is exactly as true as the receipts it summarizes. The emailed edition
// rides the same composition later.
import { useEffect, useState } from 'react';
import Link from 'next/link';

interface DayRow { day: string; costUsd: number; baselineCostUsd?: number }
interface ChangelogEntry { clusterId: string; name: string; kind: string; at: string; narrative: string; toVersion: number }
interface LearningState { incumbents: { models: string[] } | null; samples: Record<string, number> }
interface BudgetState { budget: { monthlyCapUsd: number } | null; mtdUsd: number }

const money = (n: number): string => (n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`);

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function WeeklyBrief() {
  const [kept, setKept] = useState<number | null>(null);
  const [requests, setRequests] = useState(0);
  const [moves, setMoves] = useState<ChangelogEntry[]>([]);
  const [ask, setAsk] = useState<{ text: string; href: string } | null>(null);

  useEffect(() => {
    const j = (u: string) => fetch(u, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const to = new Date();
    const from = new Date(to.getTime() - 6 * 86_400_000);
    const weekAgo = from.getTime();
    void (async () => {
      const [usage, log, learning, budget] = await Promise.all([
        j(`/api/usage?from=${isoDay(from)}&to=${isoDay(to)}&group_by=day`) as Promise<{ rows?: Array<DayRow & { requests: number }> } | null>,
        j('/api/frontier-changelog') as Promise<{ entries?: ChangelogEntry[] } | null>,
        j('/api/learning') as Promise<LearningState | null>,
        j('/api/budgets') as Promise<BudgetState | null>,
      ]);
      const rows = usage?.rows ?? [];
      // No per-day clamp (2026-09-11): a day that cost more than the
      // comparator subtracts, as it should — clamping each day to zero
      // overstated the week. (These rows are the usage_daily rollup, whose
      // costUsd still carries measurement; the serving split lands with the
      // rollup column — see today-pulse for the live month figure.)
      const k = rows.reduce((s, r) => s + ((r.baselineCostUsd ?? 0) - r.costUsd), 0);
      setKept(k);
      setRequests(rows.reduce((s, r) => s + (r.requests ?? 0), 0));
      setMoves((log?.entries ?? []).filter((e) => new Date(e.at).getTime() >= weekAgo).slice(0, 2));
      if (learning?.incumbents && learning.incumbents.models.length === 0) {
        setAsk({ text: 'naming the model you use today — it turns your savings line into a measurement against your own baseline, and unlocks retention verdicts', href: '/settings/controls' });
      } else if (budget?.budget && budget.budget.monthlyCapUsd > 0 && budget.mtdUsd / budget.budget.monthlyCapUsd >= 0.7) {
        setAsk({ text: `a glance at the budget — you are at ${Math.round((budget.mtdUsd / budget.budget.monthlyCapUsd) * 100)}% of the cap`, href: '/settings/controls' });
      }
    })();
  }, []);

  // Day-2-first: no letter until there is a week worth writing about.
  if (kept === null || (requests === 0 && moves.length === 0)) return null;

  return (
    <div className="mt-10 max-w-xl border border-[#c4bfb2] bg-[#fbfaf7] px-7 py-6 shadow-paper">
      <div className="flex items-baseline justify-between border-b border-[#d9d5cb] pb-2.5 font-mono text-[11.5px] uppercase tracking-[0.13em] text-faint">
        <span>The Monday Brief</span>
        <span>the last 7 days</span>
      </div>
      <p className="mt-4 text-[14px] leading-[1.75] text-soft">
        {kept > 0 ? (
          <><span className="font-semibold text-ink">You kept {money(kept)} this week</span> across {requests.toLocaleString()} request{requests === 1 ? '' : 's'}, verified receipt by receipt.</>
        ) : kept < 0 ? (
          <><span className="font-semibold text-warn">This week cost {money(-kept)} more than the comparator</span> across {requests.toLocaleString()} request{requests === 1 ? '' : 's'} — a bar nothing measured can clear, or a max-quality policy, sends work to the priciest point. The receipts say which.</>
        ) : (
          <><span className="font-medium text-ink">I served {requests.toLocaleString()} request{requests === 1 ? '' : 's'} this week.</span> The kept line starts moving once your baseline is named and measured.</>
        )}
        {moves.map((m) => (
          <span key={`${m.clusterId}-${m.toVersion}`}>
            {' '}On {m.name}: {m.narrative}{' '}
            <Link href="/settings/frontier" className="text-accent underline">the log</Link>.
          </span>
        ))}
      </p>
      {ask && (
        <p className="mt-3 text-[14px] leading-[1.75] text-soft">
          One thing would help: <Link href={ask.href} className="text-accent underline">{ask.text}</Link>.
        </p>
      )}
      <p className="mt-4 font-mono text-[12px] text-faint">— your measurement engine · every claim links to its receipts</p>
    </div>
  );
}
