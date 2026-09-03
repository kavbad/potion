// The canonical glossary (docs/RESEARCH-WRITING.md E6): terms are defined
// ONCE, here, and articles link them — they never redefine. The held/drift
// rows carry the one-sided law exactly as the code enforces it
// (observatory.ts driftVerdict).
import type { Metadata } from 'next';
import Link from 'next/link';
import { SiteShell } from '@/components/site-header';
import { RESEARCH_TITLE } from '@/lib/research';

export const metadata: Metadata = {
  title: `Glossary · ${RESEARCH_TITLE}`,
  description: 'The canonical definitions behind every Frontier Notes number: measured quality, quality floor, frontier, held, drift, quality premium, frontier tax and the rest.',
  alternates: { canonical: '/research/glossary' },
};

const TERMS: Array<{ term: string; def: string }> = [
  { term: 'Measured quality', def: "A model's average mark on our private exam for one kind of work. Never called intelligence — it is an exam score with a margin of error." },
  { term: 'Required quality (quality floor)', def: 'The minimum measured quality acceptable for a workload. Everything above the floor is a candidate; the cheapest candidate usually wins.' },
  { term: 'Economic frontier', def: 'The set of measured options not dominated on quality and cost at the same time — nothing else is both better and cheaper.' },
  { term: 'Frontier leader', def: 'The economically preferred option for one kind of work given a specific quality requirement.' },
  { term: 'Candidate', def: 'A model or strategy under evaluation for inclusion.' },
  { term: 'Audition', def: 'The exam a newly available model sits for the kinds of work it looks suited to.' },
  { term: 'Canary', def: 'A small weekly sample (four items) run against the stored measurement. It detects collapse, not one-point movement.' },
  {
    term: 'Held',
    def: "A canary verdict: the weekly mean did NOT fall below the stored interval's lower bound. Drift detection is one-sided — a cluster scoring above its stored interval still holds. Held is a floor, not a promise of the old quality.",
  },
  {
    term: 'Drift',
    def: 'A canary verdict: the weekly mean fell below the stored interval. The routed pick does not change on a drift flag — the cluster is re-measured in full, which may reconfirm the same pick. Not every noisy movement is drift.',
  },
  { term: 'Quality premium', def: 'The incremental cost of buying additional measured quality — what the last point of quality costs.' },
  { term: 'Frontier tax', def: 'Excess spend relative to the current measured frontier — what a team pays above the cheapest option that clears its floor.' },
  { term: 'Stale-model tax', def: 'Frontier tax arising from an outdated inference decision that nobody re-measured.' },
  { term: 'Frontier half-life', def: 'The measured persistence of economically optimal inference choices — how long the best answer stays the best answer.' },
  { term: 'Launch hit rate', def: 'The share of newly evaluated releases that meaningfully improve an existing frontier.' },
  { term: 'Overbought inference', def: "Inference capability materially above the workload's actual requirement — quality you pay for and cannot measure in your outcomes." },
];

export default function GlossaryPage() {
  return (
    <SiteShell current="research">
      <main className="mx-auto max-w-3xl px-6 py-14 sm:py-20">
        <header>
          <div className="border-t-2 border-ink" />
          <div className="mt-[3px] border-t border-ink" />
          <nav className="mt-4 flex flex-wrap items-baseline justify-between gap-2 font-mono text-[12px] uppercase tracking-[0.14em] text-faint">
            <Link href="/research" className="text-ink hover:text-accent">{RESEARCH_TITLE}</Link>
            <span>glossary</span>
          </nav>
        </header>

        <h1 className="mt-6 text-[2.1rem] font-semibold leading-[1.08] tracking-[-0.025em] text-ink sm:text-[2.6rem]">Glossary</h1>
        <p className="mt-4 text-[16px] leading-relaxed text-soft">
          Every term used in Frontier Notes is defined once, here. Articles link these definitions; they never redefine them.
        </p>

        <dl className="mt-10 space-y-7">
          {TERMS.map((t) => (
            <div key={t.term} id={t.term.toLowerCase().replaceAll(/[^a-z]+/g, '-')}>
              <dt className="text-[16px] font-semibold text-ink">{t.term}</dt>
              <dd className="mt-1 text-[15px] leading-relaxed text-soft">{t.def}</dd>
            </div>
          ))}
        </dl>

        <p className="mt-12 text-[13px] leading-relaxed text-faint">
          How the numbers themselves are made: <Link href="/research/methodology" className="text-accent underline">methodology</Link>.
        </p>
      </main>
    </SiteShell>
  );
}
