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
import { CompilePipeline } from '@/components/landing/compile-pipeline';
import { EvidenceBand } from '@/components/landing/evidence-band';
import { FrontierExplorer } from '@/components/landing/frontier-explorer';
import { ResearchLoop } from '@/components/landing/research-loop';
import { AskAi } from '@/components/landing/ask-ai';

// THE LAB LOOK (operator, 2026-08-22: "design the landing page as if you are
// Dario Amodei … i want to look like this is the frontier"). The page reads
// as a frontier lab's published work, not a product page: warm paper, ink,
// hairlines instead of cards, numbered sections with their label in the
// margin, every artifact a captioned figure, measurements stated with their
// intervals and dates, one restrained accent, no washes, no pills, no glow.
// The CONTENT is v7's, untouched; only its presentation changed.
const PAPER = 'bg-[#f4f2ec]';
const INK_BAND = 'bg-[#1c1a17] text-[#efece4]';

function LabSection({ n, label, id, children, dark = false }: { n: string; label: string; id?: string; children: React.ReactNode; dark?: boolean }) {
  return (
    <section id={id} className={`${dark ? INK_BAND : PAPER} ${dark ? '' : 'border-t border-[#d9d5cb]'}`}>
      <div className="mx-auto grid max-w-6xl gap-8 px-6 py-20 sm:py-28 lg:grid-cols-[10rem_1fr] lg:gap-12">
        <div className={`font-mono text-[12px] uppercase tracking-[0.14em] ${dark ? 'text-[#a8a29e]' : 'text-faint'}`}>
          <div className={dark ? 'text-[#efece4]' : 'text-ink'}>{n}</div>
          <div className="mt-1.5 leading-relaxed">{label}</div>
        </div>
        <div className="min-w-0">{children}</div>
      </div>
    </section>
  );
}

function Figure({ n, caption, children, dark = false }: { n: string; caption: string; children: React.ReactNode; dark?: boolean }) {
  return (
    <figure>
      <div className={`overflow-hidden border ${dark ? 'border-[#3f3b35]' : 'border-[#d9d5cb]'}`}>{children}</div>
      <figcaption className={`mt-3 font-mono text-[12px] leading-relaxed ${dark ? 'text-[#a8a29e]' : 'text-faint'}`}>
        <span className={dark ? 'text-[#efece4]' : 'text-ink'}>Figure {n}.</span> {caption}
      </figcaption>
    </figure>
  );
}

export function Landing() {
  return (
    <div>
      {/* ---------------- hero ---------------- */}
      {/* v7, and the first actual RE-composition. Six versions kept one
          layout — headline left, artefact box right — and swapped the box.
          The box always competed with the words. This one has no box: a
          centred editorial stage at display scale for the words (unchanged,
          operator-endorsed), and the evidence as an instrument beneath them.
          Scale carries the confidence; the instrument carries the proof. */}
      <section className="relative flex min-h-[calc(100vh-73px)] flex-col bg-[#f4f2ec]">
        <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col items-center justify-center px-6 py-16 text-center">
          {/* The eyebrow can no longer be the tagline — the tagline is the
              headline now — so it carries the one differentiator the whole
              page then spends six sections proving. */}
          <div className="font-mono text-xs uppercase tracking-[0.14em] text-faint">
            Measured, not predicted
          </div>
          {/* THE ONE-LINER IS THE HEADLINE (operator, 2026-09-05).
              "Your inference is unique. Your compiler should be too." was
              built for a market of ROUTERS: it differentiated ours from
              theirs. There are no other compilers, so the comparison has
              nothing to stand against and the sentence stops meaning
              anything. The category name does that work instead, and the
              second line TEACHES the category by contrast — routers choose
              from a fixed menu, a compiler builds the plan — before it sells.
              Note the direction of the economics clause (operator, 2026-09-05:
              "cheapest one good enough" made it "sound like crap"): the
              quality bar is the CONSTRAINT the customer owns and price is what
              falls out of it. Say it the other way round and the same true
              sentence reads as a compromise we made on their behalf.

              The scale returns to the rung the operator endorsed before
              6fce198 ("Hero: re-fit the scale to the longer line") stepped it
              down to fit two sentences. Four words fit; the rung comes back.
              The mark stays under the last word, as the original design had
              it.

              ONE LINE, ALWAYS (operator, 2026-09-05). A wrapped category name
              reads as two half-thoughts, so the size is fluid rather than
              stepped: clamp() ties it to the viewport and `whitespace-nowrap`
              forbids the break outright, which means the headline shrinks to
              stay whole instead of breaking to stay big. The 4.5rem ceiling
              is the largest that still fits inside the hero column at desktop. */}
          <h1 className="mt-8 whitespace-nowrap text-[clamp(1.5rem,6.1vw,4.5rem)] font-medium leading-[1.02] tracking-[-0.035em] text-ink">
            The Compiler for{' '}
            <span className="relative inline-block">
              Inference
              {/* the graduation mark, at headline scale: beneath the words,
                  never through them (a strike reads as negation) */}
              <span aria-hidden className="absolute bottom-[-0.06em] left-[-0.02em] right-[0.06em] flex items-end">
                <span className="h-[3px] flex-1 bg-accent/80" />
                <span className="h-[0.28em] w-[3px] bg-accent/80" />
              </span>
            </span>
          </h1>
          {/* TWO LINES, NOT THREE (operator, 2026-09-05). Measured on the live
              page: the line wants 1017px per line and the max-w-5xl column
              gave it 976 — 41px short, so it spilled four words onto a third
              line. The column widened to 6xl and the type steps 28px → 26px,
              which holds two lines down to ~1030px viewports.

              The type also steps down on phones: the headline can only be
              24px at 375px if it stays on ONE line, so a 1.45rem second line
              of this length outweighs it by mass and the hierarchy inverts. */}
          <p className="mx-auto mt-5 max-w-[62rem] text-[1.08rem] font-normal leading-snug tracking-[-0.01em] text-soft sm:text-[1.45rem] lg:text-[1.625rem]">
            Routers pick from a menu. A compiler builds the plan: every model measured on your
            work, every request compiled to the lowest price your quality bar allows.
          </p>

          <div className="mt-9">
            <Link
              href="/login"
              className="bg-ink px-7 py-3.5 text-[15px] font-medium text-[#f4f2ec] hover:opacity-90 active:translate-y-px"
            >
              Compile your inference
            </Link>
          </div>

          {/* NO SUPPORTING LIST. Two versions of one lived here — four
              stacked bullets, then a horizontal row of three — and both were
              the same mistake: a fourth block of text under a headline that
              claims a category, saying things every API landing page says
              ("one line of code"). Assertion where the page's whole argument
              is measurement.

              It is not needed. The instrument directly below is the proof, and
              it is running: the compiler taking one real request, weighing the
              shapes it can emit, applying your rule to the measured field, and
              printing what it saved. A hero that shows the product does not
              also need to list it. What the bullets said is made where it
              belongs —
              the bill in the line above, the rule in §05, new models in §04.

              Four blocks: eyebrow, headline, line, action. Then the machine. */}

          {/* exa's first page, whole: the product RUNS in the hero. Not a
              screenshot of the compiler — the compiler, on committed
              measurements, deciding in front of you. */}
          <div className="mt-16 w-full max-w-5xl text-left">
            <Figure n="1" caption="One real request through the compiler: every measured point for its kind of work, drawn with its 95% interval and sized by its p95 latency. Your rule becomes a shape on that field — a quality floor, a cost ceiling, or a latency budget — everything that cannot satisfy it drops out, and the plan is whatever survives and wins. Every point, price and latency is a committed measurement.">
              <CompilePipeline />
            </Figure>
          </div>
        </div>

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
      <LabSection n="01" label="The obvious question" id="vs-gateways">
        <Reveal>
          <h2 className="mt-4 max-w-2xl text-[2rem] font-medium leading-[1.12] tracking-[-0.02em] text-ink sm:text-[2.5rem]">
            Isn&apos;t this what OpenRouter does?
          </h2>
          <p className="mt-6 max-w-2xl text-base leading-relaxed text-soft">
            Less than it used to be — gateways now ship auto-routers, and that is exactly the
            point. Prediction is becoming free. A router picks a road; a compiler designs the
            route.{' '}
            <span className="font-medium text-ink">Others predict which model should work.</span>{' '}
            <span className="font-medium text-ink">
              Potion measures what actually clears your bar
            </span>{' '}
            — and signs the receipt.
          </p>
        </Reveal>

        <Reveal delayMs={120} className="mt-12">
          <Figure n="2" caption="What a gateway answers, and what Potion answers. The gateway column is factual about what gateways do well; the difference is judgment on every request, backed by held-out measurement.">
            <div className="hidden grid-cols-[1fr_1.1fr_1.15fr] gap-px bg-[#d9d5cb] sm:grid">
              {/* header row — the Potion column is washed and carried by the
                  mark, so the eye picks its side before reading a word */}
              <div className="bg-panel px-5 py-4" />
              <div className="bg-panel px-5 py-4 text-sm font-medium text-soft">A model gateway</div>
              <div className="flex items-center gap-2 bg-ink px-5 py-4 text-sm font-medium text-[#f4f2ec]">
                <Mark className="h-4 w-4 text-[#f4f2ec]" />
                Potion
              </div>
              {[
                ['You get', 'Every model, one API', 'The measured pick for each kind of work'],
                ['Who chooses', 'You, or a predictive auto-router', 'Held-out measurement, under your stated bar'],
                ['Based on', 'Leaderboards and predictions', 'Held-out tests of your kind of work'],
                ['Quality', 'Whatever the prediction picked', 'Only points measured above your floor are served'],
                ['After the answer', 'Tokens and a price', 'A receipt: what served it, and why'],
                ['A new model ships', 'You re-evaluate by hand', 'Measured first, adopted only if it earns it'],
              ].map(([k, a, b]) => (
                <React.Fragment key={k}>
                  <div className="flex items-center bg-panel px-5 py-4 font-mono text-[12px] uppercase tracking-wide text-faint">
                    {k}
                  </div>
                  <div className="bg-panel px-5 py-4 text-sm leading-relaxed text-soft">{a}</div>
                  <div className="flex items-start gap-2.5 bg-[#ece9df] px-5 py-4 text-sm leading-relaxed text-ink">
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
            <div className="divide-y divide-[#d9d5cb] sm:hidden">
              {[
                ['You get', 'Every model, one API', 'The measured pick for each kind of work'],
                ['Who chooses', 'You, or a predictive auto-router', 'Held-out measurement, under your stated bar'],
                ['Based on', 'Leaderboards and predictions', 'Held-out tests of your kind of work'],
                ['Quality', 'Whatever the prediction picked', 'Only points measured above your floor are served'],
                ['After the answer', 'Tokens and a price', 'A receipt: what served it, and why'],
                ['A new model ships', 'You re-evaluate by hand', 'Measured first, adopted only if it earns it'],
              ].map(([k, a, b]) => (
                <div key={k} className="bg-panel px-4 py-4">
                  <div className="font-mono text-[12px] uppercase tracking-wide text-faint">{k}</div>
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
          </Figure>
          <p className="mt-6 max-w-2xl text-sm leading-relaxed text-soft">
            Access stopped being scarce the day gateways shipped. Judgment did not. That is the
            layer Potion sells — measured per kind of work, enforced as a floor — and it works the
            same over any gateway or provider underneath.
          </p>
        </Reveal>
      </LabSection>

      {/* ---------------- 02 · the artifact (R2 coherence pass) ----------------
          The hero promises "your compiler"; this is the first place the page
          SHOWS what it emits. The specimen is schematic — real workload names,
          masked strategies (the evidence-band convention), illustrative
          numbers — and the caption says so; real ones are compiled per org and
          read on the Compiler page (the signed-in home; /router and /compiler
          both redirect there — see docs/NAMING.md for what kept its old
          spelling and why).
          The asymmetry is stated here because it IS the product boundary:
          you never hand-assign; you change what you want and Potion
          recompiles. */}
      <LabSection n="02" label="What you get">
        <div className="grid items-start gap-12 lg:grid-cols-2">
          <div>
            <h2 className="text-[1.7rem] font-medium leading-[1.15] tracking-[-0.02em] text-ink">
              An execution plan with your name on it.
            </h2>
            <p className="mt-4 text-[15px] leading-relaxed text-soft">
              Potion compiles it from three things: your traffic&rsquo;s actual kinds of
              work, your quality bar, and the measured frontiers. It ships as a model id —{' '}
              <code className="font-mono text-[13px] text-ink">potion/your-org</code> — and as a
              document you can read: every kind of work, how it is executed, the measured quality
              and price behind the choice.
            </p>
            <p className="mt-3 text-[15px] leading-relaxed text-soft">
              <span className="font-medium text-ink">
                The compiler emits the simplest plan that clears your bar.
              </span>{' '}
              Today that is usually one model per kind of work: we measured the clever shapes —
              referee juries, run-and-test, escalate-when-unsure — on the same requests, and every
              one of them lost. The gain is across requests, not inside one. When that changes,
              the plan changes and you do not.
            </p>
            <p className="mt-3 text-[15px] leading-relaxed text-soft">
              It is versioned. When a new model ships or a measurement moves, Potion recompiles,
              mints the next version, and writes what changed on it — and every receipt names the
              version that served it. Roll it back, audit it, set boundaries on it.
            </p>
            <p className="mt-3 text-[15px] leading-relaxed text-soft">
              <span className="font-medium text-ink">You never hand-assign a model.</span> You
              change what you want — the floor, the ceiling, a ban — and Potion recompiles. The
              intelligence stays on our side of the API.
            </p>
          </div>
          <figure className="border border-[#d9d5cb] bg-[#fbfaf7]">
            <div className="flex items-baseline justify-between border-b border-[#d9d5cb] px-5 py-3">
              <span className="font-mono text-[13px] text-ink">potion/your-org</span>
              <span className="font-mono text-[12px] uppercase tracking-[0.1em] text-accent">v4</span>
            </div>
            <div className="px-5 py-4">
              <table className="w-full text-left font-mono text-[12px]">
                <thead className="text-[11px] uppercase tracking-[0.1em] text-faint">
                  <tr><th className="pb-2 font-normal">kind of work</th><th className="pb-2 font-normal">compiles to</th><th className="pb-2 text-right font-normal">quality</th><th className="pb-2 text-right font-normal">$/1K</th></tr>
                </thead>
                <tbody className="text-soft">
                  <tr className="border-t border-dashed border-[#d9d5cb]"><td className="py-1.5">extraction</td><td><span className="inline-flex items-baseline gap-1"><span aria-label="name withheld" title="name withheld" className="inline-block h-[9px] w-14 self-center bg-ink/60" />·small</span></td><td className="text-right tabular-nums">0.977</td><td className="text-right tabular-nums">$0.05</td></tr>
                  <tr className="border-t border-dashed border-[#d9d5cb]"><td className="py-1.5">code-gen</td><td><span className="inline-flex items-baseline gap-1"><span aria-label="name withheld" title="name withheld" className="inline-block h-[9px] w-14 self-center bg-ink/60" />·mid</span></td><td className="text-right tabular-nums">0.917</td><td className="text-right tabular-nums">$0.55</td></tr>
                  <tr className="border-t border-dashed border-[#d9d5cb]"><td className="py-1.5">summarization</td><td><span className="inline-flex items-baseline gap-1"><span aria-label="name withheld" title="name withheld" className="inline-block h-[9px] w-14 self-center bg-ink/60" />·small</span></td><td className="text-right tabular-nums">0.850</td><td className="text-right tabular-nums">$0.01</td></tr>
                  <tr className="border-t border-dashed border-[#d9d5cb]"><td className="py-1.5">rag-answer</td><td><span className="inline-flex items-baseline gap-1"><span aria-label="name withheld" title="name withheld" className="inline-block h-[9px] w-14 self-center bg-ink/60" />·mid</span></td><td className="text-right tabular-nums">0.941</td><td className="text-right tabular-nums">$0.12</td></tr>
                </tbody>
              </table>
              <p className="mt-3 border-t border-[#d9d5cb] pt-3 font-mono text-[12px] leading-relaxed text-soft">
                v3 → v4 · a new model cleared the bar on extraction —{' '}
                <span className="text-kept">estimated at your mix: saves another 11%</span>
              </p>
            </div>
            <figcaption className="border-t border-[#d9d5cb] px-5 py-2.5 font-mono text-[11.5px] leading-relaxed text-faint">
              the artifact, schematically — strategies masked, numbers illustrative. Real ones are
              compiled per organization, from live measurements, on your Compiler page.
            </figcaption>
          </figure>
        </div>
      </LabSection>

      {/* ---------------- the evidence band (exa lesson: one dark, named-bars section) ---------------- */}
      <EvidenceBand />

      {/* ---------------- mixtures ---------------- */}
      {/* MIXING IS INTERNAL, and this section must never read like a feature
          to configure. PolicySchema takes an outcome bound and nothing else —
          there is no way for a caller to name a strategy, by design (the
          customer states the outcome, Potion chooses the means, the trace
          reports what it chose). The commercial story is stronger for it:
          not "you can build cascades", which is work handed to the customer,
          but "clever ideas are measured before a dollar of yours touches
          them — including the ones that lost" (the 2026-08-25 mixing
          verdict, published at /research/the-mixing-verdict, is the beat).

          Deliberately NOT the focal point — it sits after the mechanism is
          understood and before the proof, and it is one screen. But it must
          be present: mixing models is the idea the product is named for, and
          a page that never mentions it describes a smaller company than this
          one. The closing line is the only place the page looks past what is
          already measured, which is why it is phrased as an admission (almost
          none of it has been measured) rather than a promise. */}
      <LabSection n="04" label="The research engine">
        <div className="grid items-start gap-12 lg:grid-cols-2">
          <Reveal>
            <h2 className="mt-4 text-[2rem] font-medium leading-[1.12] tracking-[-0.02em] text-ink sm:text-[2.5rem]">
              The frontier is measured weekly, by a machine. Negatives included.
            </h2>
            <p className="mt-6 text-base leading-relaxed text-soft">
              Every model the compiler is allowed to emit must first earn its place through
              measurement — the same private exams, per kind of work, with confidence intervals
              and dates on every point. New models are auditioned the week they ship. Only what
              dominates on quality, cost and speed at once is published to the frontiers your
              plans are compiled from.
            </p>
            <p className="mt-4 text-base leading-relaxed text-soft">
              The engine also tests the clever ideas, so you never pay for one that does not
              work. It spent two weeks trying to beat the single-model plan with multi-model
              combinations — pre-registered, budget-capped — and every attempt lost to the best
              single model. We published all five losses. If the model market ever changes shape
              so a combination pays, the same machinery will find it, measure it, and only then
              serve it.
            </p>
            <p className="mt-6 border-l-[3px] border-accent pl-5 text-base font-medium leading-relaxed text-accent">
              Why this is hard to copy: the measured corpus, the live receipts, and the replay
              engine live in one place, and the corpus compounds every week — including the
              negatives. A compiler that only reports wins is indistinguishable from one that
              does not measure.
            </p>
          </Reveal>
          <Reveal delayMs={120}>
            <Figure n="4" caption="The weekly loop, with no one in it: measure the models that could earn a place; replay candidates against stored results at no cost; audition new models the week they ship; publish what dominates — and publish what lost; serve live traffic with receipts, which feed the next measurement.">
              <ResearchLoop />
            </Figure>
          </Reveal>
        </div>
      </LabSection>

      {/* ---------------- proof: the map ---------------- */}
      <LabSection n="05" label="How you know we are not making this up">
        <div>
          <Reveal>
            <h2 className="mt-4 max-w-2xl text-[2rem] font-medium leading-[1.12] tracking-[-0.02em] text-ink sm:text-[2.5rem]">
              The actual map. Drive it yourself.
            </h2>
            <p className="mt-6 max-w-2xl text-base leading-relaxed text-soft">
              Measured options for one kind of work, error bars included. Pick a rule, drag the
              slider, and you are running the same selection the compiler makes in production —
              including its refusal to answer when nothing measured qualifies.
            </p>
          </Reveal>
          <Reveal delayMs={120} className="mt-10">
            <Figure n="5" caption="The multi-step-reasoning frontier, version 3: nine measured options, 50 items each, 95% intervals drawn. The selection you run here is the selection the compiler makes in production, including its refusal when nothing qualifies.">
              <FrontierExplorer />
            </Figure>
          </Reveal>
        </div>
      </LabSection>

      {/* ---------------- business model ---------------- */}
      {/* exa's enterprise-security composition: a full-bleed dark band, the
          headline top-left, and the concrete promises as outlined tiles. */}
      <LabSection n="06" label="The engineering" dark>
        <div>
          <Reveal>
            <h2 className="mt-4 max-w-2xl text-[2rem] font-medium leading-[1.12] tracking-[-0.02em] sm:text-[2.5rem]">
              Built to refuse before it is built to answer.
            </h2>
            <p className="mt-6 max-w-2xl text-base leading-relaxed text-[#d6d3cb]">
              A compiler that spends your money has to be trustworthy before it is clever. So the
              serving path is written to fail closed: the server will not start if a frontier
              names a model it cannot serve; a frontier cannot be republished if it regresses; a
              request is refused before a budget is crossed, not after; and nothing is ever
              served from a number that was not measured.
            </p>
            <p className="mt-4 max-w-2xl text-base leading-relaxed text-[#d6d3cb]">
              Priced so we only win when you do: model costs pass through at cost, and Potion
              earns a share of the savings your own receipts verify. If it saves you nothing, it
              earns nothing above cost. No minimum. You bring no provider accounts and no keys —
              Potion buys from every provider at once, which is what lets it compile from the
              whole market rather than the one account you happened to open.
            </p>
          </Reveal>
          <Reveal delayMs={120} className="mt-14">
            <div className="font-mono text-[11.5px] uppercase tracking-[0.13em] text-[#a8a29e]">
              what is true of every request, today
            </div>
            <div className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {[
                {
                  h: 'A receipt on every answer',
                  p: 'Kind of work, strategy, policy, provenance: what answered and why, on the response itself.',
                  glyph: <><rect x="6" y="4" width="12" height="16" rx="1.5" stroke="currentColor" strokeWidth="1.5" fill="none" /><path d="M9 9h6M9 12.5h6M9 16h3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></>,
                },
                {
                  h: 'Fails closed',
                  p: 'Boot refuses a frontier that names an unservable model. A regression cannot be published. No measurement, no plan.',
                  glyph: <><path d="M4 17h16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /><path d="M7 13l3-5 3 3 4-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" /></>,
                },
                {
                  h: 'Budgets that stop the request',
                  p: 'A hard cap is enforced before the money is spent, within seconds of being crossed, never after.',
                  glyph: <><circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.5" fill="none" /><path d="M12 8v4l2.5 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" /></>,
                },
                {
                  h: 'Intervals and dates on every point',
                  p: 'Each frontier point carries its sample size, its 95% interval, and the day it was measured.',
                  glyph: <><path d="M5 19V9m4.5 10V5M14 19v-7m4.5 7V8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></>,
                },
                {
                  h: 'Re-checked every week',
                  p: 'Every pick the compiler emits is re-measured on fresh tasks; a model that drifts is caught before it costs you.',
                  glyph: <path d="M4 12h7m0 0l-3-3m3 3l-3 3M11 12h9M14 6l6 6-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />,
                },
                {
                  h: 'One line, the whole protocol',
                  p: 'OpenAI chat completions, including streaming and tool calls. Point your client at Potion; keep everything else.',
                  glyph: <path d="M9 7l-5 5 5 5M15 7l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />,
                },
              ].map((t) => (
                <div
                  key={t.h}
                  className="border border-[#3f3b35] px-6 py-6 transition-colors hover:border-[#efece4]/60"
                >
                  <svg viewBox="0 0 24 24" className="h-7 w-7 text-[#99f6e4]" aria-hidden>
                    {t.glyph}
                  </svg>
                  <div className="mt-4 text-sm font-medium text-[#efece4]">{t.h}</div>
                  <p className="mt-1.5 text-xs leading-relaxed text-[#a8a29e]">{t.p}</p>
                </div>
              ))}
            </div>
          </Reveal>
        </div>
      </LabSection>

      {/* ---------------- second opinion ---------------- */}
      {/* Placed HERE deliberately: after the proof and the engineering, one
          breath before the ask. A visitor who has read this far has been
          told the numbers are measured; the last move before "get a key" is
          to hand them somebody else to check with. Earlier on the page it
          would read as deflection — send someone away before they know what
          they are checking and they simply leave. */}
      <AskAi />

      {/* ---------------- close ---------------- */}
      <section className="bg-[#f4f2ec] border-t border-[#d9d5cb]">
        <div className="mx-auto max-w-6xl px-6 py-28 text-center">
          <Reveal>
            <div className="flex items-center justify-center gap-6" aria-hidden>
              <span className="flex items-end">
                <span className="h-px w-24 bg-[#d9d5cb]" />
                <span className="h-2 w-px bg-[#d9d5cb]" />
              </span>
              <Mark className="h-9 w-9 text-accent" />
              <span className="flex items-end" style={{ transform: 'scaleX(-1)' }}>
                <span className="h-px w-24 bg-[#d9d5cb]" />
                <span className="h-2 w-px bg-[#d9d5cb]" />
              </span>
            </div>
            <h2 className="mx-auto mt-6 max-w-xl text-[2rem] font-medium leading-[1.12] tracking-[-0.02em] text-ink sm:text-[2.5rem]">
              Change one line. Keep the receipts.
            </h2>
            <p className="mx-auto mt-5 max-w-lg text-base leading-relaxed text-soft">
              Point a client at Potion and watch every decision arrive with the answer.
            </p>
            <div className="mt-9 flex flex-wrap items-center justify-center gap-4">
              <Link
                href="/login"
                className="bg-ink px-6 py-3 text-sm font-medium text-[#f4f2ec] hover:opacity-90 active:translate-y-px"
              >
                Get an API key
              </Link>
              <Link
                href="/docs"
                className="px-4 py-3 text-sm font-medium text-ink underline decoration-[#d9d5cb] underline-offset-4 hover:decoration-ink"
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
