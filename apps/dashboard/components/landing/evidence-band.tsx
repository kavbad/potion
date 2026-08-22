// THE EVIDENCE BAND — the exa.ai lesson applied: one full-bleed DARK section
// that presents the measurements the way a benchmark page would, except every
// bar is ours and every name is a model we measured yesterday. The page was
// all warm-light panels; this is its counter-weight — ink ground, paper type,
// the one teal doing the same job it does everywhere else.
//
// Data: the code-gen-hard-v1 frontier, measured 2026-08-20 (.tranche/legs/
// code-gen.json, frontier v4, 30 retrieval-hostile items scored by EXECUTING
// the code — no judge). Hardcoded with provenance because the landing page
// tracks committed evidence, not live state; re-quote when the baseline
// republishes.
// The winner's IDENTITY is deliberately withheld (operator, 2026-08-20):
// the famous expensive names are just the market, but WHICH small model wins
// is the finding customers pay for. The masked string never enters the DOM —
// a CSS blur would leave it copy-pasteable in the page source.
const ROWS = [
  { model: 'or-grok-4.6', vendor: 'xAI', q: 1.0, cost: 6.2568, masked: false },
  { model: 'or-gemini-flash', vendor: 'Google', q: 0.9961, cost: 0.5506, masked: false },
  { model: 'or-gpt-mini', vendor: 'OpenAI', q: 0.99, cost: 0.2509, masked: false },
  { model: 'or-deepseek', vendor: 'DeepSeek', q: 0.98, cost: 0.1904, masked: false },
  { model: 'or-████████████', vendor: 'name withheld', q: 0.9785, cost: 0.0231, masked: true },
] as const;

const MAX_COST = 6.2568;

export function EvidenceBand() {
  // exa's benchmark section, structurally: a hard edge-to-edge split — solid
  // ink panel carrying the argument on the left, a white measurement field on
  // the right. No shared container, no rounded box; the seam IS the design.
  return (
    <section id="evidence" className="grid border-y border-line lg:grid-cols-[2fr_3fr]">
      <div className="bg-[linear-gradient(160deg,#042f2e_0%,#0f766e_100%)] px-6 py-20 text-white sm:px-12 lg:py-28">
        <div className="lg:ml-auto lg:max-w-md">
          <div className="font-mono text-xs uppercase tracking-[0.18em] text-[#99f6e4]">
            Measured, not claimed
          </div>
          <h2 className="mt-4 text-4xl font-semibold leading-[1.08] tracking-tight sm:text-[2.75rem]">
            The same work.
            <br />
            A 270× price range.
          </h2>
          <p className="mt-6 text-sm leading-relaxed text-white/85">
            Five models writing code to specification — scored by running their code, not by
            opinion. The quality difference across this table is two points in a hundred. The price
            difference is <span className="font-medium text-[#99f6e4]">two hundred and seventy fold</span>.
          </p>
          <p className="mt-4 text-sm leading-relaxed text-white/85">
            This is why routing pays: most requests deserve the bottom row, a few genuinely need
            the top one, and only a measurement can tell them apart.
          </p>
          <p className="mt-6 font-mono text-[11px] leading-relaxed text-[#99f6e4]/80">
            measured 2026-08-20 · retrieval-hostile suite · scored by execution · error bars on the
            full table in the docs
          </p>
        </div>
      </div>

      <div className="bg-paper px-6 py-20 sm:px-12 lg:py-28">
        <div className="max-w-2xl space-y-5 lg:mt-6">
          {ROWS.map((r) => {
            const w = Math.max(1.2, (r.cost / MAX_COST) * 100);
            const star = r.masked;
            return (
              <div key={r.model}>
                <div className="flex items-baseline justify-between font-mono text-xs">
                  <span>
                    <span className={star ? 'font-medium text-accent' : 'text-ink'}>
                      {r.model}
                    </span>
                    <span className="ml-2 text-faint">{r.vendor}</span>
                  </span>
                  <span className="text-faint">
                    quality {r.q.toFixed(3)} · ${r.cost.toFixed(4)}/1k
                  </span>
                </div>
                <div className="mt-1.5 h-5 overflow-hidden rounded-sm bg-line/60">
                  <div
                    className={`h-full rounded-sm ${star ? 'bg-[linear-gradient(90deg,#0f766e,#2dd4bf)]' : 'bg-[#99f6e4]'}`}
                    style={{ width: `${w}%` }}
                  />
                </div>
                {star && (
                  <p className="mt-1.5 font-mono text-[11px] leading-relaxed text-accent">
                    ↑ the routed pick — 99% of the top row&apos;s quality at 1/270th the price.
                    The name? That&apos;s the product.
                  </p>
                )}
              </div>
            );
          })}
          <p className="pt-1 font-mono text-[11px] text-faint">
            bars show cost per 1,000 requests · <span className="text-accent">teal</span> = what
            a 0.95 quality floor actually buys
          </p>
        </div>
      </div>
    </section>
  );
}
