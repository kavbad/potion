// THE LANDING PAGE, v100 — written to be understood by someone who does not
// write code, without becoming a page an engineer would distrust.
//
// The brief was "easier for non-technicals (venture capitalists)", and the
// obvious way to do that is the wrong way: strip the measurements, add
// adjectives. The measurements ARE the reason to believe, and an investor's
// actual question is not "what is a Pareto frontier" — it is "how much money,
// how defensible, why now". So the structure inverts rather than dilutes:
//
//   · every section LEADS with money or moat, in plain words
//   · the evidence stays, demoted to smaller type underneath, where it now
//     reads as proof rather than as the pitch
//   · the interactive artefact is a SAVINGS MODEL a partner can drive, not a
//     frontier chart an engineer can drive (that moved lower, and is framed
//     as "how you know we are not making this up")
//
// The honesty is load-bearing here for a specific reason: a savings model
// that claims a win in every category reads as a pitch deck, and one that
// says "these two we cannot help with" reads as a measurement. The second
// sells better to the audience that has seen a thousand of the first.
//
// House constraints unchanged: warm paper, ONE teal, no gradients, and the
// mark's fill line as the only gesture toward the name — now extended to the
// scroll rail (components/landing/scroll-rail.tsx), which turns reading the
// page into filling the vessel.
//
// TWO STANDING RULES, both operator decisions, both easy to breach by
// accident when editing copy:
//
//   · NOTHING THE CUSTOMER WOULD NOT WANT TO HEAR. The moat argument used to
//     include a switching-costs pillar — true, good for an investor, and read
//     by a customer as a description of the trap they are walking into. The
//     same underlying fact (per-org measurement accrues) is now stated as the
//     benefit it actually is. Never argue lock-in on a page a buyer reads.
//   · NO CORPUS COUNTS. How many workload types, how many strategies, how
//     many graded items, how many models — none of it appears. Those numbers
//     tell a competitor the size of the moat and, read cold, make a serious
//     corpus sound small. The claim is made in METHOD language instead —
//     held-out sets, known answers, confidence intervals, re-measurement on
//     release — which is both more durable and harder to dismiss. Measured
//     RESULTS (a saving, a quality score, a price) are fine; inventory is
//     not.
import React from 'react';
import Link from 'next/link';
import { Mark } from '@/components/mark';
import { TOO_CLOSE_EXAMPLE } from '@/lib/evidence';
import { Reveal } from '@/components/landing/reveal';
import { ScrollRail } from '@/components/landing/scroll-rail';
import { RouteTape } from '@/components/landing/route-tape';
import { RouteConsole } from '@/components/landing/route-console';
import { HeroDrift } from '@/components/landing/hero-drift';
import { EvidenceBand } from '@/components/landing/evidence-band';
import { StatCards } from '@/components/landing/stat-cards';
import { FrontierExplorer } from '@/components/landing/frontier-explorer';
import { CiOverlap } from '@/components/landing/ci-overlap';
import { MixDiagram } from '@/components/landing/mix-diagram';
import { SavingsModel } from '@/components/landing/savings-model';
import { PriceSpread } from '@/components/landing/price-spread';

function Rule() {
  return (
    <div className="flex items-center" aria-hidden>
      <div className="h-px flex-1 bg-line" />
      <div className="h-2.5 w-px bg-line" />
      <div className="h-px w-10 bg-line" />
    </div>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  // Every section opens with the same fingerprint: the mark's graduation
  // tick, drawn small under the eyebrow. The one gesture, systematised —
  // a reader who notices it once starts finding it everywhere (the mark,
  // the hero underline, the scroll rail, the section rules, these).
  return (
    <div>
      <div className="font-mono text-xs uppercase tracking-[0.18em] text-faint">{children}</div>
      <div className="mt-2.5 flex items-end" aria-hidden>
        <span className="h-px w-7 bg-accent/60" />
        <span className="h-[7px] w-px bg-accent/60" />
      </div>
    </div>
  );
}

/**
 * Technical detail, demoted but not apologetic.
 *
 * The first version was a thin left rule and grey text, which read as an
 * afterthought someone forgot to delete rather than as the proof it is. A
 * tinted panel with a mono label says "this is a different register, on
 * purpose" — the non-technical reader skips it cleanly, and the engineer
 * finds it without hunting.
 */
function ForEngineers({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-6 rounded-lg bg-paper px-4 py-3.5">
      <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
        for engineers
      </div>
      <div className="text-xs leading-relaxed text-soft">{children}</div>
    </div>
  );
}

/**
 * A claim card anchored by a figure.
 *
 * Three columns of body text have no hierarchy — the eye has nowhere to land
 * and every card looks equally important, which means none of them are. A
 * large figure at the top gives each card a handle, sets a rhythm across the
 * row, and reuses the page's existing vocabulary (the evidence strip's mono
 * numerals). `mt-auto` pins the technical note to the bottom so the notes
 * align across cards even when the prose above them runs to different
 * lengths — the specific thing that made the old row look broken.
 */
function ClaimCard({
  figure,
  figureLabel,
  heading,
  children,
  note,
}: {
  figure: string;
  figureLabel: string;
  heading: string;
  children: React.ReactNode;
  note: string;
}) {
  return (
    <div className="group relative flex h-full flex-col bg-panel px-8 py-9 transition-colors hover:bg-accent-soft/15">
      <span
        aria-hidden
        className="absolute right-6 top-7 font-mono text-sm text-faint/0 transition-colors group-hover:text-accent"
      >
        ↗
      </span>
      <div className="flex h-14 w-14 items-center justify-center rounded-full border border-accent/40 bg-accent-soft/20 font-mono text-2xl font-medium leading-none text-accent transition-colors group-hover:bg-accent-soft/50">
        {figure}
      </div>
      <div className="mt-3 text-xs uppercase tracking-wide text-faint">{figureLabel}</div>
      <h3 className="mt-6 text-base font-medium text-ink">{heading}</h3>
      <p className="mt-2.5 text-sm leading-relaxed text-soft">{children}</p>
      <div className="mt-auto pt-6">
        <div className="border-t border-line pt-3 font-mono text-[11px] leading-relaxed text-faint">
          {note}
        </div>
      </div>
    </div>
  );
}

export function Landing() {
  const { strong, cheap } = TOO_CLOSE_EXAMPLE;
  const cheaperPct = Math.round((1 - cheap.costPer1K / strong.costPer1K) * 100);
  const fasterX = (strong.p95Ms / cheap.p95Ms).toFixed(1);

  return (
    <div>
      <ScrollRail />
      {/* ---------------- hero ---------------- */}
      {/* v7, and the first actual RE-composition. Six versions kept one
          layout — headline left, artefact box right — and swapped the box.
          The box always competed with the words. This one has no box: a
          centred editorial stage at display scale for the words (unchanged,
          operator-endorsed), and the routing evidence as a full-bleed
          instrument tape forming the section's bottom edge — an EDGE, not a
          box. Scale carries the confidence; the tape carries the proof. */}
      <section className="relative flex min-h-[calc(100vh-73px)] flex-col">
        <HeroDrift />
        <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col items-center justify-center px-6 py-16 text-center">
          <div className="font-mono text-xs uppercase tracking-[0.18em] text-faint">
            Measured model routing
          </div>
          <h1 className="mt-8 text-[3.4rem] font-semibold leading-[1.02] tracking-[-0.035em] text-ink sm:text-[4.5rem] lg:text-[5.5rem]">
            Cut your AI bill{' '}
            <span className="relative inline-block">
              in half.
              {/* the graduation mark, at headline scale: beneath the words,
                  never through them (a strike reads as negation) */}
              <span aria-hidden className="absolute bottom-[-0.06em] left-[-0.02em] right-[0.06em] flex items-end">
                <span className="h-[3px] flex-1 bg-accent/80" />
                <span className="h-[0.28em] w-[3px] bg-accent/80" />
              </span>
            </span>
          </h1>
          <p className="mt-6 text-[1.55rem] font-medium leading-snug tracking-[-0.01em] text-soft sm:text-[1.9rem]">
            The right model(s) for every request.
          </p>

          <div className="mt-8">
            <Link
              href="/login"
              className="rounded-md bg-accent px-6 py-3 text-sm font-medium text-white hover:opacity-90 active:translate-y-px active:scale-[0.99]"
            >
              Get an API key
            </Link>
          </div>

          <ul className="mx-auto mt-9 max-w-xl space-y-2.5 text-left">
            {[
              'AI bills fall 49% when Potion routes each request to the cheapest model measured good enough.',
              'Cost, quality, or speed: you set the rule, Potion picks from the measured Pareto frontier.',
              'Your routing stays current automatically: new models are measured on release, and our research finds model combinations nobody else has.',
              'One line of code. Every answer carries a receipt: what ran, and why.',
            ].map((li) => (
              <li key={li} className="flex gap-3 text-[15px] leading-relaxed text-soft">
                <span aria-hidden className="mt-[11px] flex shrink-0 items-end self-start">
                  <span className="h-px w-3.5 bg-accent/70" />
                  <span className="h-[5px] w-px bg-accent/70" />
                </span>
                <span>{li}</span>
              </li>
            ))}
          </ul>

          {/* exa's first page, whole: the product runs in the hero. Real
              measured routes streaming into the table, receipt alongside. */}
          <div className="mt-12 w-full max-w-4xl text-left">
            <RouteConsole />
          </div>
        </div>

        {/* the instrument hum: five real routes, streaming */}
        <RouteTape />
      </section>

      {/* ---------------- the obvious question ---------------- */}
      {/* Every technical buyer asks this within a minute, so the page asks it
          first. Two constraints shaped the copy: (1) Potion BUYS through
          OpenRouter — the section draws a layer boundary, it does not punch a
          supplier. (2) Stay factual about what gateways do:
          they solve access (every model, one API, provider failover) — the
          supplier relationship stays off the page (operator call, 2026-08-20).
          The differentiation is JUDGMENT — per-request selection backed by
          held-out measurement, a quality floor, and a receipt — and the table
          only claims that. */}
      <section id="vs-gateways" className="mx-auto max-w-6xl px-6 py-24">
        <Reveal>
          <Eyebrow>The obvious question</Eyebrow>
          <h2 className="mt-4 max-w-2xl text-4xl font-semibold leading-[1.08] tracking-tight sm:text-[2.75rem] text-ink">
            Isn&apos;t this what OpenRouter does?
          </h2>
          <p className="mt-6 max-w-2xl text-base leading-relaxed text-soft">
            No. A gateway answers{' '}
            <span className="font-medium text-ink">how do I call any model?</span> Potion answers{' '}
            <span className="font-medium text-ink">which model does this request deserve?</span>{' '}
            Those are different layers, and the second one is where the money is.
          </p>
        </Reveal>

        <Reveal delayMs={120} className="mt-12">
          <div className="overflow-hidden rounded-2xl border border-line shadow-paper">
            <div className="grid grid-cols-[1fr_1.1fr_1.15fr] gap-px bg-line max-sm:grid-cols-[0.8fr_1fr_1fr]">
              {/* header row — the Potion column is washed and carried by the
                  mark, so the eye picks its side before reading a word */}
              <div className="bg-panel px-5 py-4" />
              <div className="bg-panel px-5 py-4 text-sm font-medium text-soft">A model gateway</div>
              <div className="flex items-center gap-2 bg-[#f2f9f7] px-5 py-4 text-sm font-medium text-accent">
                <Mark className="h-4 w-4" />
                Potion
              </div>
              {[
                ['You get', 'Every model, one API', 'The right model for each request'],
                ['Who chooses', 'You do, once per app', 'The measurements do, per request'],
                ['Based on', 'Leaderboards, habit, vibes', 'Held-out tests of your kind of work'],
                ['Quality', 'Whatever you picked', 'A floor your traffic never falls below'],
                ['After the answer', 'Tokens and a price', 'A receipt: what served it, and why'],
                ['A new model ships', 'You re-evaluate by hand', 'Measured first, adopted only if it earns it'],
              ].map(([k, a, b]) => (
                <React.Fragment key={k}>
                  <div className="flex items-center bg-panel px-5 py-4 font-mono text-[11px] uppercase tracking-wide text-faint">
                    {k}
                  </div>
                  <div className="bg-panel px-5 py-4 text-sm leading-relaxed text-soft">{a}</div>
                  <div className="flex items-start gap-2.5 bg-[#f2f9f7] px-5 py-4 text-sm leading-relaxed text-ink">
                    <span aria-hidden className="mt-[9px] flex shrink-0 items-end">
                      <span className="h-px w-3 bg-accent/70" />
                      <span className="h-[5px] w-px bg-accent/70" />
                    </span>
                    {b}
                  </div>
                </React.Fragment>
              ))}
            </div>
          </div>
          <p className="mt-6 max-w-2xl text-sm leading-relaxed text-faint">
            Access stopped being scarce the day gateways shipped. Judgment — measured per kind of
            work, stated with its error bars, enforced as a floor — is the scarce layer. That layer
            is Potion, and it works the same over any gateway or provider underneath.
          </p>
        </Reveal>
      </section>

      {/* ---------------- method strip ---------------- */}
      {/* This was four big counts — workload types, strategies, graded
          answers, models. Inventory numbers date badly, hand a competitor the
          size of the job, and read cold they make a serious corpus sound
          small. Method survives all three problems: it is what a sceptic
          actually wants to know, and it stays true as the corpus grows. */}
      <section className="border-y border-line bg-panel">
        <div className="mx-auto grid max-w-6xl grid-cols-2 gap-px bg-line px-6 sm:grid-cols-4">
          {[
            {
              n: '01',
              h: 'Held-out sets',
              p: 'Graded on items the models never see in advance.',
              glyph: (
                <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" aria-hidden>
                  {[5, 12, 19].map((y) =>
                    [5, 12, 19].map((x) => (
                      <circle key={`${x}${y}`} cx={x} cy={y} r="1.4" fill="currentColor" opacity={x === 19 && y === 5 ? 0 : 0.55} />
                    )),
                  )}
                  <circle cx="19" cy="5" r="3.2" stroke="currentColor" strokeWidth="1.2" />
                </svg>
              ),
            },
            {
              n: '02',
              h: 'Known answers',
              p: 'Scored against a reference, or by running the code.',
              glyph: (
                <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" aria-hidden>
                  <path d="M5 13l4.5 4.5L19 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ),
            },
            {
              n: '03',
              h: 'Stated uncertainty',
              p: 'Every score carries the interval its evidence supports.',
              glyph: (
                <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" aria-hidden>
                  <path d="M12 4v16M8 4h8M8 20h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                  <circle cx="12" cy="12" r="2.4" fill="currentColor" />
                </svg>
              ),
            },
            {
              n: '04',
              h: 'Re-measured on release',
              p: 'A new model is tested before it is ever routed to.',
              glyph: (
                <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" aria-hidden>
                  <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  <path d="M19.8 3.6v3.6h-3.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ),
            },
          ].map((m) => (
            <div key={m.h} className="group relative bg-paper px-7 py-9 transition-colors hover:bg-accent-soft/20">
              <span className="absolute right-6 top-8 font-mono text-[11px] text-faint/70">{m.n}</span>
              <div className="text-accent">{m.glyph}</div>
              <div className="mt-4 text-sm font-medium text-ink">{m.h}</div>
              <div className="mt-1.5 text-xs leading-relaxed text-faint">{m.p}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ---------------- the evidence band (exa lesson: one dark, named-bars section) ---------------- */}
      <EvidenceBand />

      {/* ---------------- the numbers, at exa scale ---------------- */}
      <StatCards />


      {/* ---------------- the problem, in money ---------------- */}
      <section className="mx-auto max-w-6xl px-6 py-24">
        <div className="grid items-start gap-14 lg:grid-cols-2">
          <Reveal>
            <Eyebrow>The problem</Eyebrow>
            <h2 className="mt-4 text-4xl font-semibold leading-[1.08] tracking-tight sm:text-[2.75rem] text-ink">
              The same job can cost 170 times as much, for no benefit.
            </h2>
            <p className="mt-6 text-base leading-relaxed text-soft">
              There are hundreds of AI models. They differ enormously in price and only sometimes in
              quality — and which one is best changes every few weeks as new ones ship.
            </p>
            <p className="mt-4 text-base leading-relaxed text-soft">
              Almost nobody re-checks. A team picks a model once, wires it in, and keeps paying that
              price on every request forever — including the thousands of easy ones a model costing
              a fraction as much would answer just as well.
            </p>
            <ForEngineers>
              The chart is the measured extraction frontier: quality is a graded score over 74
              held-out items, cost is USD per 1,000 requests at each strategy&apos;s measured token
              profile.
            </ForEngineers>
          </Reveal>
          <Reveal delayMs={120}>
            <PriceSpread />
          </Reveal>
        </div>
      </section>

      {/* ---------------- the savings model: the VC artefact ---------------- */}
      <section className="border-y border-line bg-panel">
        <div className="mx-auto max-w-6xl px-6 py-24">
          <Reveal>
            <Eyebrow>What it is worth</Eyebrow>
            <h2 className="mt-4 max-w-3xl text-4xl font-semibold leading-[1.08] tracking-tight sm:text-[2.75rem] text-ink">
              Set how good the answers have to be. See what routing saves.
            </h2>
            <p className="mt-6 max-w-2xl text-base leading-relaxed text-soft">
              This is not a marketing calculator. It runs Potion&apos;s real selection rule over
              Potion&apos;s real measurements, live, as you drag. Raise the quality bar and watch
              categories drop out — including the ones we would refuse to take money for.
            </p>
          </Reveal>
          <Reveal delayMs={120} className="mt-10">
            <SavingsModel />
          </Reveal>
        </div>
      </section>

      {/* ---------------- the moat ---------------- */}
      <section className="mx-auto max-w-6xl px-6 py-24">
        <Reveal>
          <Eyebrow>Why this is hard to copy</Eyebrow>
          <h2 className="mt-4 max-w-3xl text-4xl font-semibold leading-[1.08] tracking-tight sm:text-[2.75rem] text-ink">
            Anyone can call a cheaper model. Knowing when that is safe is the asset.
          </h2>
          <p className="mt-6 max-w-2xl text-base leading-relaxed text-soft">
            The router is a week of engineering. The evidence it routes on is not — and it is the
            half that compounds.
          </p>
        </Reveal>
        <div className="mt-12 grid items-stretch gap-px overflow-hidden rounded-2xl border border-line bg-line md:grid-cols-3">
          {[
            {
              figure: '∫',
              figureLabel: 'the corpus accumulates',
              h: 'The measurements compound',
              p: 'Every model, on every kind of work, graded against known answers — and re-graded when a new one ships. That corpus is the product, and it is worth more every week than it was the week before.',
              note: 'Content-addressed: re-measuring an unchanged pair costs nothing, so the corpus only ever pays for what is genuinely new.',
            },
            {
              figure: 'σ',
              figureLabel: 'uncertainty is carried, not dropped',
              h: 'Benchmarks are the wrong instrument',
              p: 'Public leaderboards rank models on average, across work you do not do. Potion measures each model on each kind of job, and keeps the error bars — the only comparison that can tell you what to send where.',
              note: 'A separate quality/cost/latency frontier per kind of work. Selection is always per-workload, never global.',
            },
            {
              figure: '↗',
              figureLabel: 'it improves in place',
              h: 'It gets better the longer you run it',
              p: 'You start on measurements of your kind of work. As your own traffic accumulates, the routing retunes to it specifically — so the saving grows without you changing a line or paying more attention.',
              note: 'Shared measurements serve from day one; measurements of your own traffic take over as they accrue.',
            },
          ].map((c, i) => (
            <Reveal key={c.h} delayMs={i * 110} className="h-full">
              <ClaimCard
                figure={c.figure}
                figureLabel={c.figureLabel}
                heading={c.h}
                note={c.note}
              >
                {c.p}
              </ClaimCard>
            </Reveal>
          ))}
        </div>
      </section>

      <div className="mx-auto max-w-6xl px-6">
        <Rule />
      </div>

      {/* ---------------- how it works, plainly ---------------- */}
      <section className="mx-auto max-w-6xl px-6 py-24">
        <Reveal>
          <Eyebrow>How it works</Eyebrow>
          <h2 className="mt-4 max-w-2xl text-4xl font-semibold leading-[1.08] tracking-tight sm:text-[2.75rem] text-ink">
            Read the request. Pick the cheapest model good enough. Show your working.
          </h2>
        </Reveal>
        <div className="relative mt-12 isolate space-y-px overflow-hidden rounded-2xl border border-line bg-line">
          {/* the rail: one hairline through all three steps, each number a
              station on it — the same graduated-line language as everything
              else on the page */}
          <div aria-hidden className="absolute bottom-10 left-[3.35rem] top-10 z-10 w-px bg-line max-sm:hidden" />
          {[
            {
              n: '01',
              h: 'It reads what you are asking for',
              p: 'Before anything is chosen, the request is sorted into a kind of work — writing code, summarising, pulling data out of a document, and so on. Each kind has its own answer about which model is best.',
              code: 'cluster = code-gen',
            },
            {
              n: '02',
              h: 'You set the rule, it picks the model',
              p: 'You say what matters: never go below this quality, or never spend above this much, or never take longer than this. Potion holds a measured map of every option — single models and combinations of them — and picks the best one that obeys your rule.',
              code: 'policy = min_cost · qualityFloor 0.80',
            },
            {
              n: '03',
              h: 'Every answer comes with a receipt',
              p: 'The response carries what it chose, why, and which measurements it relied on. If Potion had nothing measured for your request, the receipt says that too rather than quietly guessing.',
              code: 'x-frontier-trace: cluster=code-gen;strategy=6efe8a56;frontier=v2;policy=min_cost;fallback=0',
            },
          ].map((s, i) => (
            <Reveal key={s.n} delayMs={i * 110}>
              <div className="bg-panel px-8 py-10">
                <div className="flex flex-col gap-7 sm:flex-row sm:items-start">
                  {/* The step number was 14px and floating a long way from its
                      own heading, so it read as a bullet rather than as
                      structure. At display size it anchors the row and gives
                      the stack a rhythm the eye can follow down. */}
                  <div className="relative z-20 sm:w-16 sm:shrink-0">
                    <div className="flex h-11 w-11 items-center justify-center rounded-full border border-line bg-panel font-mono text-sm font-medium text-accent">
                      {s.n}
                    </div>
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="text-lg font-medium tracking-tight text-ink">{s.h}</h3>
                    <p className="mt-2.5 max-w-2xl text-sm leading-relaxed text-soft">{s.p}</p>
                    <div className="mt-5 overflow-x-auto">
                      {/* Step 3's artefact is a real trace, so it gets the same
                          dark treatment traces have everywhere else on the
                          page rather than looking like a different thing. */}
                      <code
                        className={`inline-block whitespace-pre rounded px-3 py-2 font-mono text-xs ${
                          s.code.startsWith('x-frontier-trace')
                            ? 'bg-[#292524] text-[#e7e2da]'
                            : 'bg-paper text-soft'
                        }`}
                      >
                        {s.code}
                      </code>
                    </div>
                  </div>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ---------------- mixtures ---------------- */}
      {/* MIXING IS INTERNAL, and this section must never read like a feature
          to configure. PolicySchema takes an outcome bound and nothing else —
          there is no way for a caller to name a strategy, by design (the
          customer states the outcome, Potion chooses the means, the trace
          reports what it chose). The commercial story is stronger for it:
          not "you can build cascades", which is work handed to the customer,
          but "combinations you would never have found serve your traffic
          under the rule you already set".

          Deliberately NOT the focal point — it sits after the mechanism is
          understood and before the proof, and it is one screen. But it must
          be present: mixing models is the idea the product is named for, and
          a page that never mentions it describes a smaller company than this
          one. The closing line is the only place the page looks past what is
          already measured, which is why it is phrased as an admission (almost
          none of it has been measured) rather than a promise. */}
      <section className="mx-auto max-w-6xl px-6 py-24">
        <div className="grid items-center gap-14 lg:grid-cols-2">
          <Reveal>
            <Eyebrow>Sometimes the answer is not one model</Eyebrow>
            <h2 className="mt-4 text-4xl font-semibold leading-[1.08] tracking-tight sm:text-[2.75rem] text-ink">
              A mixture can beat anything you could have picked.
            </h2>
            <p className="mt-6 text-base leading-relaxed text-soft">
              A cheap model answers and reports how sure it is. Only when that confidence falls
              below a measured threshold does the request go on to a stronger one. Most traffic
              never reaches the expensive model at all — so the combination can land at the top of
              the measured quality range while costing a fraction of sending everything to the
              strong model.
            </p>
            <p className="mt-4 text-base leading-relaxed text-soft">
              Potion measures those combinations exactly the way it measures single models: the
              same held-out items, the same known answers, the same error bars. A mixture earns a
              place on the map or it does not appear on it.
            </p>
            <p className="mt-4 text-base leading-relaxed text-soft">
              There is nothing for you to assemble. You set the same rule you would set anyway —
              stay above this quality, stay under this cost — and if a combination is the best way
              to honour it, that is what serves your request. The receipt names whatever answered.
            </p>
            <p className="mt-6 border-l-2 border-accent/30 pl-5 text-base leading-relaxed text-ink">
              There are far more useful combinations than there are models, and almost none of them
              have been measured by anyone. That is the dimension this company is named for.
            </p>
            <ForEngineers>
              Cascade, ensemble, draft-verify, best-of-n and staged-upgrade composites are all
              first-class strategies with their own executors, generated against the model registry
              and promoted only on a paired bootstrap over held-out items — the same gate a single
              model faces.
            </ForEngineers>
          </Reveal>
          <Reveal delayMs={120}>
            <MixDiagram />
          </Reveal>
        </div>
      </section>

      {/* ---------------- proof ---------------- */}
      <section className="border-y border-line bg-panel">
        <div className="mx-auto max-w-6xl px-6 py-24">
          <Reveal>
            <Eyebrow>How you know we are not making this up</Eyebrow>
            <h2 className="mt-4 max-w-2xl text-4xl font-semibold leading-[1.08] tracking-tight sm:text-[2.75rem] text-ink">
              It tells you when it cannot tell.
            </h2>
            <p className="mt-6 max-w-2xl text-base leading-relaxed text-soft">
              Every quality score Potion reports comes with a margin of error, the way a poll does.
              When two models are close enough that the measurement cannot separate them, Potion
              says they are tied instead of inventing a winner — and then picks the cheaper one.
            </p>
          </Reveal>

          <Reveal delayMs={120} className="mt-10">
            <div className="overflow-hidden rounded-2xl border border-line bg-paper shadow-paper">
              <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.16em] text-faint">
                <span aria-hidden className="inline-block h-2 w-2 rounded-full bg-accent/70" />
                two real points · error bars overlapping · reported as a tie
              </div>
              <div className="px-6 py-6">
                <CiOverlap />
              </div>
            </div>
            <div className="mt-6 max-w-2xl rounded-lg border border-accent/25 bg-accent-soft/40 px-5 py-4">
              <p className="text-sm leading-relaxed text-ink">
                <span className="font-medium">Too close to call.</span> Those two bars overlap
                almost completely, so the quality difference is not real evidence — while the
                cheaper one costs{' '}
                <span className="font-medium">{cheaperPct}% less</span> and answers{' '}
                <span className="font-medium">{fasterX}× faster</span>. A leaderboard would rank
                them and let you overpay for the gap.
              </p>
            </div>
            <ForEngineers>
              Two real points on the {TOO_CLOSE_EXAMPLE.cluster} frontier: {strong.label} at{' '}
              {strong.quality.toFixed(3)} ±{strong.ci.toFixed(3)} against {cheap.label} at{' '}
              {cheap.quality.toFixed(3)} ±{cheap.ci.toFixed(3)}. The rule underneath is that no
              dial is exposed without a measurement beneath it — an unmeasured model stays
              reachable and is never auto-selected.
            </ForEngineers>
          </Reveal>

          <Reveal delayMs={160} className="mt-16">
            <h3 className="text-base font-medium text-ink">
              The actual map, if you want to drive it yourself
            </h3>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-soft">
              Measured options for one kind of work, spanning a hundredfold price range. Pick a
              rule, drag the slider, and you are running the same selection the router runs in
              production — including its refusal to answer when nothing measured qualifies.
            </p>
          </Reveal>
          <Reveal delayMs={200} className="mt-8">
            <FrontierExplorer />
          </Reveal>
        </div>
      </section>

      {/* ---------------- business model ---------------- */}
      {/* exa's enterprise-security composition: a full-bleed dark band, the
          headline top-left, and the concrete promises as outlined tiles. */}
      <section className="bg-[#292524] text-[#faf9f6]">
        <div className="mx-auto max-w-6xl px-6 py-28">
          <Reveal>
            <div className="font-mono text-xs uppercase tracking-[0.18em] text-[#a8a29e]">
              The business
            </div>
            <h2 className="mt-4 max-w-2xl text-4xl font-semibold leading-[1.08] tracking-tight sm:text-[2.75rem]">
              We get paid out of what we save you.
            </h2>
            <p className="mt-6 max-w-2xl text-base leading-relaxed text-[#d6d3d1]">
              Usage-based today. The direction of travel is to charge against measured savings — the
              only pricing that stays honest when the whole point of the product is spending less,
              and the only one that makes the bill fall when we do our job badly.
            </p>
            <p className="mt-4 max-w-2xl text-base leading-relaxed text-[#d6d3d1]">
              Customers bring no accounts and no keys. Potion buys from every provider at once,
              which is also what lets it reach the whole market rather than the one account a
              customer happened to open.
            </p>
          </Reveal>
          <Reveal delayMs={120} className="mt-14">
            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#a8a29e]">
              what a customer gets on day one
            </div>
            <div className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {[
                {
                  h: 'One line of code',
                  p: 'Point your client at Potion. Nothing else about your app changes.',
                  glyph: <path d="M9 7l-5 5 5 5M15 7l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />,
                },
                {
                  h: 'Routing on every measured kind of work',
                  p: 'Each request goes where the evidence says it should, not where habit does.',
                  glyph: <path d="M4 12h7m0 0l-3-3m3 3l-3 3M11 12h9M14 6l6 6-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />,
                },
                {
                  h: 'A quality floor',
                  p: 'A line their traffic is never allowed to fall below, enforced per request.',
                  glyph: <><path d="M4 17h16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /><path d="M7 13l3-5 3 3 4-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" /></>,
                },
                {
                  h: 'A receipt on every answer',
                  p: 'What was chosen, why, and which measurements it relied on.',
                  glyph: <><rect x="6" y="4" width="12" height="16" rx="1.5" stroke="currentColor" strokeWidth="1.5" fill="none" /><path d="M9 9h6M9 12.5h6M9 16h3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></>,
                },
                {
                  h: 'A spending cap',
                  p: 'The request is refused before the money is spent, never after.',
                  glyph: <><circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.5" fill="none" /><path d="M12 8v4l2.5 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" /></>,
                },
                {
                  h: 'A bill that argues for itself',
                  p: 'Spend is attributable to decisions you can audit, line by line.',
                  glyph: <><path d="M5 19V9m4.5 10V5M14 19v-7m4.5 7V8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></>,
                },
              ].map((t) => (
                <div
                  key={t.h}
                  className="rounded-lg border border-[#44403c] px-6 py-6 transition-colors hover:border-[#2dd4bf]/50"
                >
                  <svg viewBox="0 0 24 24" className="h-8 w-8 text-[#2dd4bf]" aria-hidden>
                    {t.glyph}
                  </svg>
                  <div className="mt-4 text-sm font-medium text-[#faf9f6]">{t.h}</div>
                  <p className="mt-1.5 text-xs leading-relaxed text-[#a8a29e]">{t.p}</p>
                </div>
              ))}
            </div>
          </Reveal>
        </div>
      </section>

      {/* ---------------- close ---------------- */}
      <section className="border-t border-line bg-panel">
        <div className="mx-auto max-w-6xl px-6 py-24 text-center">
          <Reveal>
            <div className="flex items-center justify-center gap-6" aria-hidden>
              <span className="flex items-end">
                <span className="h-px w-24 bg-line" />
                <span className="h-2 w-px bg-line" />
              </span>
              <Mark className="h-9 w-9 text-accent" />
              <span className="flex items-end" style={{ transform: 'scaleX(-1)' }}>
                <span className="h-px w-24 bg-line" />
                <span className="h-2 w-px bg-line" />
              </span>
            </div>
            <h2 className="mx-auto mt-6 max-w-xl text-4xl font-semibold leading-[1.08] tracking-tight sm:text-[2.75rem] text-ink">
              Change one line. Keep the receipts.
            </h2>
            <p className="mx-auto mt-5 max-w-lg text-base leading-relaxed text-soft">
              Point a client at Potion and watch the routing decisions arrive with the answers.
            </p>
            <div className="mt-9 flex flex-wrap items-center justify-center gap-4">
              <Link
                href="/login"
                className="rounded-md bg-ink px-5 py-2.5 text-sm font-medium text-white hover:opacity-85 active:translate-y-px active:scale-[0.99]"
              >
                Get an API key
              </Link>
              <Link
                href="/docs"
                className="rounded-md bg-paper px-4 py-2.5 text-sm font-medium text-soft ring-1 ring-line transition-colors hover:bg-line/40 hover:text-ink"
              >
                Read the docs →
              </Link>
            </div>
          </Reveal>
        </div>
      </section>
    </div>
  );
}
