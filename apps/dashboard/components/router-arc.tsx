'use client';

// THE ROUTER ARC (comprehension pass, 2026-08-27): the one story every user
// must be able to tell back — "it routes from day one on platform evidence;
// it reads my traffic for a week or two; then it becomes mine, and I can
// verify it." Operator directive: the user must understand how the product
// works, period — including users starting from scratch.
//
// Every number here is live (/api/learning): sample counts, open proposals,
// whether an incumbent exists. The stage highlight derives from the data —
// nothing is a marketing timeline; the 1–2 weeks is stated as what it is,
// the typical coverage time.
import { useEffect, useState } from 'react';
import Link from 'next/link';

interface LearningResponse {
  incumbents: { models: string[] } | null;
  samplingConsent: boolean;
  samples: Record<string, number>;
  proposals: Array<{ status?: string }>;
}

export function RouterArc({ hasTraffic }: { hasTraffic: boolean }) {
  const [learning, setLearning] = useState<LearningResponse | null>(null);
  useEffect(() => {
    fetch('/api/learning', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => b && setLearning(b as LearningResponse))
      .catch(() => null);
  }, []);

  const sampleEntries = Object.entries(learning?.samples ?? {}).filter(([, n]) => n > 0);
  const totalSamples = sampleEntries.reduce((s, [, n]) => s + n, 0);
  const openProposals = (learning?.proposals ?? []).filter((p) => p.status === undefined || p.status === 'proposed').length;
  const fromScratch = learning !== null && learning.incumbents === null;
  const consentOff = learning !== null && !learning.samplingConsent;

  // The active stage is derived, never scripted.
  const active = openProposals > 0 ? 2 : hasTraffic || totalSamples > 0 ? 1 : 0;

  const steps: Array<{ title: string; body: React.ReactNode }> = [
    {
      title: 'Day one — your router works immediately',
      body: (
        <>
          v1 is compiled from Potion&rsquo;s own live measurements, under your quality bar. You are
          not waiting on anything: every request routes to the cheapest option measured good enough
          from the first call.
        </>
      ),
    },
    {
      title: 'Weeks 1–2 — Potion reads your traffic',
      body: (
        <>
          {consentOff ? (
            <>
              Workload measurement is <span className="text-ink">off</span> in your settings — the
              router keeps routing on platform evidence, and this step waits until you turn{' '}
              <Link href="/settings/controls" className="text-accent underline">measurement on</Link>.
            </>
          ) : (
            <>
              A small, redacted, capped sample of your requests is measured for one purpose:
              learning what <em>your</em> work actually is and how well each model does on it.
              {totalSamples > 0 ? (
                <>
                  {' '}So far: <span className="text-ink">{totalSamples} sample{totalSamples === 1 ? '' : 's'} across{' '}
                  {sampleEntries.length} kind{sampleEntries.length === 1 ? '' : 's'} of work</span>.
                </>
              ) : (
                <> It starts with your first real traffic.</>
              )}
              {fromScratch ? (
                <>
                  {' '}Starting from scratch, there&rsquo;s no old model to beat yet — your work is
                  measured against a strong default bar instead, so the arc is the same.
                </>
              ) : null}
            </>
          )}
        </>
      ),
    },
    {
      title: 'Then — the router becomes yours',
      body: (
        <>
          When coverage fills for a kind of work, Potion <span className="text-ink">proposes your
          own quality bar for it</span> — you accept or ignore; nothing changes silently. Accepted
          bars recompile the router as a new version with the change written on it.
          {openProposals > 0 ? (
            <>
              {' '}<span className="text-kept">{openProposals} proposal{openProposals === 1 ? '' : 's'} open now</span> —{' '}
              <Link href="/" className="text-accent underline">review on Today</Link>.
            </>
          ) : null}
        </>
      ),
    },
    {
      title: 'Always — verify it',
      body: (
        <>
          Every response carries a receipt: what routed, what it cost, what your alternative would
          have cost. <Link href="/receipts" className="text-accent underline">Receipts</Link> name
          the router version that served each request;{' '}
          <Link href="/usage" className="text-accent underline">Savings</Link> totals what you kept.
        </>
      ),
    },
  ];

  return (
    <section className="border border-[#d9d5cb] bg-[#fbfaf7] px-6 py-5" data-testid="router-arc">
      <div className="font-mono text-[12px] uppercase tracking-[0.13em] text-soft">
        how this works — the first two weeks
      </div>
      <ol className="mt-3 grid gap-3.5">
        {steps.map((s, i) => (
          <li key={s.title} className="flex gap-3.5">
            <span
              className={`mt-px inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border font-mono text-[12px] ${
                i === active ? 'border-accent bg-accent text-white' : i < active ? 'border-accent/50 text-accent' : 'border-[#c4bfb2] text-faint'
              }`}
            >
              {i < active ? '✓' : i + 1}
            </span>
            <span>
              <span className={`block text-[14.5px] font-medium ${i === active ? 'text-ink' : 'text-soft'}`}>{s.title}</span>
              <span className="mt-0.5 block text-[13.5px] leading-relaxed text-soft">{s.body}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
