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
import { Reveal } from '@/components/landing/reveal';
import { ScrollRail } from '@/components/landing/scroll-rail';
import { RouteTape } from '@/components/landing/route-tape';
import { RoutingField } from '@/components/landing/routing-field';
import { EvidenceBand } from '@/components/landing/evidence-band';
import { FrontierExplorer } from '@/components/landing/frontier-explorer';
import { MixDiagram } from '@/components/landing/mix-diagram';

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

export function Landing() {
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

          <ul className="mx-auto mt-9 max-w-md space-y-2 text-left">
            {[
              '49% lower bills. Each request goes to the cheapest model measured good enough.',
              'Your rule: cost, quality, or speed. Picked from the measured Pareto frontier.',
              'Always current. New models measured on release; combinations nobody else has.',
              'One line of code. A receipt with every answer.',
            ].map((li) => (
              <li key={li} className="flex gap-3 text-[14.5px] leading-snug text-soft">
                <span aria-hidden className="mt-[9px] flex shrink-0 items-end self-start">
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
            <RoutingField />
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
      <section id="vs-gateways" className="bg-[#ecfdf5]">
        <div className="mx-auto max-w-6xl px-6 py-24">
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
            <div className="hidden grid-cols-[1fr_1.1fr_1.15fr] gap-px bg-line sm:grid">
              {/* header row — the Potion column is washed and carried by the
                  mark, so the eye picks its side before reading a word */}
              <div className="bg-panel px-5 py-4" />
              <div className="bg-panel px-5 py-4 text-sm font-medium text-soft">A model gateway</div>
              <div className="flex items-center gap-2 bg-accent px-5 py-4 text-sm font-medium text-white">
                <Mark className="h-4 w-4 text-white" />
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
                  <div className="flex items-start gap-2.5 bg-[#ccfbf1] px-5 py-4 text-sm leading-relaxed text-ink">
                    <span aria-hidden className="mt-[9px] flex shrink-0 items-end">
                      <span className="h-px w-3 bg-accent/70" />
                      <span className="h-[5px] w-px bg-accent/70" />
                    </span>
                    {b}
                  </div>
                </React.Fragment>
              ))}
            </div>
            {/* phones: the same six rows, stacked */}
            <div className="divide-y divide-line sm:hidden">
              {[
                ['You get', 'Every model, one API', 'The right model for each request'],
                ['Who chooses', 'You do, once per app', 'The measurements do, per request'],
                ['Based on', 'Leaderboards, habit, vibes', 'Held-out tests of your kind of work'],
                ['Quality', 'Whatever you picked', 'A floor your traffic never falls below'],
                ['After the answer', 'Tokens and a price', 'A receipt: what served it, and why'],
                ['A new model ships', 'You re-evaluate by hand', 'Measured first, adopted only if it earns it'],
              ].map(([k, a, b]) => (
                <div key={k} className="bg-panel px-4 py-4">
                  <div className="font-mono text-[11px] uppercase tracking-wide text-faint">{k}</div>
                  <div className="mt-2 text-sm leading-snug text-soft">
                    <span className="text-faint">gateway · </span>
                    {a}
                  </div>
                  <div className="mt-1.5 flex items-start gap-2 text-sm leading-snug text-ink">
                    <Mark className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
                    {b}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <p className="mt-6 max-w-2xl text-sm leading-relaxed text-soft">
            Access stopped being scarce the day gateways shipped. Judgment — measured per kind of
            work, stated with its error bars, enforced as a floor — is the scarce layer. That layer
            is Potion, and it works the same over any gateway or provider underneath.
          </p>
        </Reveal>
        </div>
      </section>

      {/* ---------------- the evidence band (exa lesson: one dark, named-bars section) ---------------- */}
      <EvidenceBand />

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
      <section className="bg-[#f0fdfa]">
        <div className="mx-auto grid max-w-6xl items-center gap-14 px-6 py-24 lg:grid-cols-2">
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
              There is nothing for you to assemble. You set the same rule you would set anyway —
              stay above this quality, stay under this cost — and if a combination is the best way
              to honour it, that is what serves your request. The receipt names whatever answered.
            </p>
            <p className="mt-6 border-l-[3px] border-accent pl-5 text-base font-medium leading-relaxed text-accent">
              There are far more useful combinations than there are models, and almost none of them
              have been measured by anyone. That is the dimension this company is named for.
            </p>
          </Reveal>
          <Reveal delayMs={120}>
            <MixDiagram />
          </Reveal>
        </div>
      </section>

      {/* ---------------- proof: the map ---------------- */}
      <section className="border-y border-line bg-panel">
        <div className="mx-auto max-w-6xl px-6 py-24">
          <Reveal>
            <Eyebrow>How you know we are not making this up</Eyebrow>
            <h2 className="mt-4 max-w-2xl text-4xl font-semibold leading-[1.08] tracking-tight sm:text-[2.75rem] text-ink">
              The actual map. Drive it yourself.
            </h2>
            <p className="mt-6 max-w-2xl text-base leading-relaxed text-soft">
              Measured options for one kind of work, error bars included. Pick a rule, drag the
              slider, and you are running the same selection the router runs in production —
              including its refusal to answer when nothing measured qualifies.
            </p>
          </Reveal>
          <Reveal delayMs={120} className="mt-10">
            <FrontierExplorer />
          </Reveal>
        </div>
      </section>

      {/* ---------------- business model ---------------- */}
      {/* exa's enterprise-security composition: a full-bleed dark band, the
          headline top-left, and the concrete promises as outlined tiles. */}
      <section className="bg-[linear-gradient(160deg,#042f2e_0%,#0f3d3a_55%,#134e4a_100%)] text-[#f0fdfa]">
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
                  className="rounded-lg border border-white/15 bg-white/[0.04] px-6 py-6 transition-colors hover:border-[#2dd4bf]/70 hover:bg-white/[0.07]"
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
      <section className="bg-[linear-gradient(135deg,#0f766e_0%,#14b8a6_60%,#2dd4bf_100%)] text-white">
        <div className="mx-auto max-w-6xl px-6 py-28 text-center">
          <Reveal>
            <div className="flex items-center justify-center gap-6" aria-hidden>
              <span className="flex items-end">
                <span className="h-px w-24 bg-white/50" />
                <span className="h-2 w-px bg-white/50" />
              </span>
              <Mark className="h-9 w-9 text-white" />
              <span className="flex items-end" style={{ transform: 'scaleX(-1)' }}>
                <span className="h-px w-24 bg-white/50" />
                <span className="h-2 w-px bg-white/50" />
              </span>
            </div>
            <h2 className="mx-auto mt-6 max-w-xl text-4xl font-semibold leading-[1.08] tracking-tight text-white sm:text-[2.75rem]">
              Change one line. Keep the receipts.
            </h2>
            <p className="mx-auto mt-5 max-w-lg text-base leading-relaxed text-white/85">
              Point a client at Potion and watch the routing decisions arrive with the answers.
            </p>
            <div className="mt-9 flex flex-wrap items-center justify-center gap-4">
              <Link
                href="/login"
                className="rounded-md bg-white px-5 py-2.5 text-sm font-medium text-accent hover:bg-[#f0fdfa] active:translate-y-px active:scale-[0.99]"
              >
                Get an API key
              </Link>
              <Link
                href="/docs"
                className="rounded-md px-4 py-2.5 text-sm font-medium text-white ring-1 ring-white/50 transition-colors hover:bg-white/10"
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
