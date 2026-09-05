// THE EVIDENCE BAND — the exa.ai lesson applied: one full-bleed DARK section
// that presents the measurements the way a benchmark page would, except every
// bar is ours and every name is a model we measured yesterday. The page was
// all warm-light panels; this is its counter-weight — ink ground, paper type,
// the one teal doing the same job it does everywhere else.
//
// Data: the code-gen-hard-v1 frontier, DERIVED from the committed baseline by
// scripts/gen-landing-evidence.ts (2026-09-04). It used to be transcribed by
// hand, and the transcription was wrong in three ways at once: the date said
// 2026-08-20 when the frontier that produced these rows was created
// 2026-08-21, the ratio was quoted as 270x against a measured 270.9x, and the
// quality share was quoted as 99% against a measured 97.8%. The page now
// computes all three from the rows it draws, so the prose and the bars cannot
// disagree again.
//
// The winner's IDENTITY is deliberately withheld (operator, 2026-08-20):
// the famous expensive names are just the market, but WHICH small model wins
// is the finding customers pay for. The masked string never enters the DOM —
// a CSS blur would leave it copy-pasteable in the page source — and the mask
// is now applied in the generator, at the source, so nothing downstream has
// to remember to do it.
import { CODE_GEN } from '@/lib/evidence.generated';

/** Dearest first: the argument reads top-down from what the market charges
 * to what the measurement actually buys. */
const ROWS = [...CODE_GEN.rows].reverse();

const MAX_COST = CODE_GEN.maxCost;

/** House style spells small numbers in prose ("Five models…"), and a sentence
 * never opens with a numeral. The count is still derived. */
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const spell = (n: number) => WORDS[n] ?? String(n);
const Spelled = ({ n }: { n: number }) => <>{spell(n).replace(/^./, (c) => c.toUpperCase())}</>;

export function EvidenceBand() {
  // exa's benchmark section, structurally: a hard edge-to-edge split — solid
  // ink panel carrying the argument on the left, a white measurement field on
  // the right. No shared container, no rounded box; the seam IS the design.
  return (
    <section id="evidence" className="grid lg:grid-cols-[2fr_3fr]">
      <div className="bg-[#1c1a17] px-6 py-20 text-[#efece4] sm:px-12 lg:py-28">
        <div className="lg:ml-auto lg:max-w-md">
          <div className="font-mono text-[12px] uppercase tracking-[0.14em] text-[#a8a29e]">
            <span className="text-[#efece4]">03</span> · Measured, not claimed
          </div>
          <h2 className="mt-4 text-[2rem] font-medium leading-[1.12] tracking-[-0.02em] sm:text-[2.5rem]">
            The same work.
            <br />
            A {CODE_GEN.ratio}× price range.
          </h2>
          <p className="mt-6 text-sm leading-relaxed text-[#d6d3cb]">
            <Spelled n={ROWS.length} /> models writing code to specification — scored by running their code, not by
            opinion. The quality difference across this table is {CODE_GEN.qualityGapPoints} points in a
            hundred. The price difference is{' '}
            <span className="font-medium text-[#efece4]">{CODE_GEN.ratio}-fold</span>.
          </p>
          <p className="mt-4 text-sm leading-relaxed text-[#d6d3cb]">
            This is why the compiler pays: most kinds of work are served from the bottom row, a few genuinely need
            the top one, and only a measurement can tell them apart.
          </p>
          <p className="mt-6 font-mono text-[12px] leading-relaxed text-[#a8a29e]">
            measured {CODE_GEN.measuredAt} · frontier v{CODE_GEN.version} · retrieval-hostile suite ·
            scored by execution · error bars on the full table in the docs
          </p>
        </div>
      </div>

      <div className="bg-[#f4f2ec] px-6 py-20 sm:px-12 lg:py-28">
        <div className="max-w-2xl space-y-5 lg:mt-6">
          {ROWS.map((r) => {
            const w = Math.max(1.2, (r.costPer1K / MAX_COST) * 100);
            const star = r.masked;
            return (
              <div key={r.label}>
                <div className="flex items-baseline justify-between font-mono text-xs">
                  <span>
                    <span className={star ? 'font-medium text-accent' : 'text-ink'}>
                      {r.label}
                    </span>
                    <span className="ml-2 text-faint">{r.vendor}</span>
                  </span>
                  <span className="text-faint">
                    quality {r.quality.toFixed(3)} · ${r.costPer1K.toFixed(4)}/1k
                  </span>
                </div>
                <div className="mt-1.5 h-5 overflow-hidden rounded-sm bg-[#e4e0d6]">
                  <div
                    className={`h-full rounded-sm ${star ? 'bg-accent' : 'bg-[#b8b3a6]'}`}
                    style={{ width: `${w}%` }}
                  />
                </div>
                {star && (
                  <p className="mt-1.5 font-mono text-[12px] leading-relaxed text-accent">
                    ↑ the compiled pick — {CODE_GEN.qualityRetainedPct}% of the top row&apos;s quality at{' '}
                    {CODE_GEN.ratioWords}. The name? That&apos;s the product.
                  </p>
                )}
              </div>
            );
          })}
          <p className="pt-1 font-mono text-[12px] text-faint">
            <span className="text-ink">Figure 3.</span> The code-gen-hard frontier, measured {CODE_GEN.measuredAt}, {CODE_GEN.items} items scored by execution ({CODE_GEN.gradedCells} graded runs per point). Bars show cost per 1,000 requests · <span className="text-accent">teal</span> = what
            a {CODE_GEN.floor} quality floor actually buys{CODE_GEN.belowFloor > 0 ? ` · ${CODE_GEN.belowFloor} further frontier point${CODE_GEN.belowFloor === 1 ? '' : 's'} measured below that floor and are not drawn` : ''}
          </p>
        </div>
      </div>
    </section>
  );
}
