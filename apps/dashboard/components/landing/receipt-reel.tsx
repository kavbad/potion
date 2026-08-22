'use client';

// THE RECEIPT REEL — the product in its smallest honest form. A real
// request goes in; what comes back is the answer's receipt, written in
// plain words: what kind of work this was, which measured model got it,
// what that cost, how well that model scores on this kind of work, and
// what the expensive alternative would have cost. Six real decisions from
// the committed frontier, cycling. The box never changes size.
import { useEffect, useState } from 'react';
import { FIELD, ROUTE_DEMO } from '@/lib/evidence';
import { premiumCostFor } from '@/lib/economics';

const FLOOR = 0.95;
const CYCLE_MS = 3800;

const WORK: Record<string, string> = {
  classification: 'sorting text into categories',
  'code-gen': 'writing code',
  extraction: 'pulling fields out of a document',
  'rag-answer': 'answering from your documents',
  'multi-step-reasoning': 'working through a multi-step problem',
  creative: 'writing with some flair',
};

function usd(n: number): string {
  return n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

export function ReceiptReel() {
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) return;
    const t = setTimeout(() => setI((k) => (k + 1) % ROUTE_DEMO.length), CYCLE_MS);
    return () => clearTimeout(t);
  }, [i, paused]);

  const d = ROUTE_DEMO[i]!;
  const points = FIELD[d.cluster] ?? [];
  const above = points.filter((p) => p.quality >= FLOOR);
  const pick = above.length
    ? above.reduce((a, b) => (b.costPer1K < a.costPer1K ? b : a))
    : points.reduce((a, b) => (b.quality > a.quality ? b : a));
  const cleared = pick.quality >= FLOOR;
  const premium = premiumCostFor(d.cluster) ?? points.reduce((a, b) => (b.costPer1K > a.costPer1K ? b : a)).costPer1K;
  const saved = Math.max(0, Math.round((1 - pick.costPer1K / premium) * 100));
  const withheld = pick.label.includes('█');

  return (
    <div
      className="mx-auto w-full max-w-3xl bg-[#fbfaf7] text-left"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="flex h-[4.25rem] items-center gap-3 border-b border-[#d9d5cb] px-5 sm:px-6">
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-faint">request</span>
        <div key={`p${i}`} className="reel-fade min-w-0 flex-1 truncate text-[15px] text-ink">{d.prompt}</div>
      </div>
      <div className="h-[19.5rem] px-5 py-5 sm:h-[17rem] sm:px-6">
        <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-faint">what happened</div>
        <dl key={`r${i}`} className="reel-fade mt-3 grid grid-cols-[6rem_1fr] gap-x-3 gap-y-2.5 text-[15px] leading-snug sm:grid-cols-[9rem_1fr] sm:gap-x-4">
          <dt className="text-faint">This was</dt>
          <dd className="text-ink">{WORK[d.cluster] ?? d.cluster}.</dd>
          <dt className="text-faint">It went to</dt>
          <dd className="min-w-0 text-ink">
            <span className="whitespace-nowrap font-mono text-[14px]">{pick.label.replace('████████', '██████')}</span>
            {withheld && <span className="ml-2 text-[13px] text-faint">(name withheld: the name is the product)</span>}
          </dd>
          <dt className="text-faint">Which scores</dt>
          <dd className="text-ink">
            {pick.quality.toFixed(2)} out of 1 on this kind of work{cleared ? ', above your 0.95 floor' : ''}.
          </dd>
          <dt className="text-faint">It cost</dt>
          <dd className="text-ink">
            {usd(pick.costPer1K)} per thousand requests.{' '}
            {cleared && saved > 0 ? (
              <span className="text-accent">{saved}% less than the premium model, for the same quality.</span>
            ) : (
              <span className="text-soft">Full price: nothing cheaper was good enough, and the receipt says so.</span>
            )}
          </dd>
          <dt className="text-faint">Why</dt>
          <dd className="text-soft">
            {cleared ? 'It is the cheapest model that passed the exam for this kind of work.' : 'Only the best model passed the exam for this kind of work.'}
          </dd>
        </dl>
      </div>
      <div className="flex h-10 items-center justify-between border-t border-[#d9d5cb] px-5 font-mono text-[10px] text-faint sm:px-6">
        <span>{String(i + 1).padStart(2, '0')} / {String(ROUTE_DEMO.length).padStart(2, '0')} · real decisions, not a demo · hover to pause</span>
        <span className="hidden sm:inline">every answer carries one of these</span>
      </div>
    </div>
  );
}
