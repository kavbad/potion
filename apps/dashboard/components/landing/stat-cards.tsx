// THE STAT CARDS — exa's index-stats section, structurally: enormous mono
// figures in thin-bordered white cards on a staggered grid, each number
// carrying one line of plain-language caption underneath.
//
// The discipline that makes this section legal under the standing rules:
// every figure is a measured RESULT (a price ratio, a quality share, a
// saving) — never inventory. No workload counts, no item counts, no model
// counts. Results age well and give nothing away; inventory does neither.
const STATS = [
  {
    figure: '270×',
    caption: 'the price range across five models doing the same measured work — quality within two points in a hundred',
  },
  {
    figure: '99%',
    caption: "of the most expensive model's quality, from the pick our measurements route to, at 1/270th the price",
  },
  {
    figure: '49%',
    caption: 'the measured saving across our reference workload mix, with the quality floor enforced on every request',
  },
] as const;

export function StatCards() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-24">
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {STATS.map((s, i) => (
          <div
            key={s.figure}
            className={`rounded-lg border border-line bg-panel px-8 py-10 ${
              i === 1 ? 'lg:translate-y-8' : i === 2 ? 'lg:translate-y-16' : ''
            }`}
          >
            <div className="font-mono text-6xl font-medium tracking-tight text-ink sm:text-7xl">
              {s.figure}
            </div>
            <p className="mt-5 max-w-xs text-sm leading-relaxed text-soft">{s.caption}</p>
          </div>
        ))}
      </div>
      <div className="mt-24 grid gap-5 lg:grid-cols-[3fr_2fr]">
        <div className="divide-y divide-line rounded-lg border border-line bg-panel px-8">
          <div className="py-8">
            <div className="font-mono text-5xl font-medium tracking-tight text-ink sm:text-6xl">
              $0.0231
            </div>
            <p className="mt-3 text-sm text-soft">per 1,000 requests — the routed pick, name withheld</p>
          </div>
          <div className="py-8">
            <div className="font-mono text-5xl font-medium tracking-tight text-faint sm:text-6xl">
              $6.2568
            </div>
            <p className="mt-3 text-sm text-soft">per 1,000 requests — the model most teams would have picked</p>
          </div>
        </div>
        <div className="flex flex-col justify-end rounded-lg border border-line bg-panel px-8 py-10">
          <div className="font-mono text-xs uppercase tracking-[0.14em] text-faint">
            same suite · scored by execution
          </div>
          <p className="mt-4 text-sm leading-relaxed text-soft">
            Both rows did the same held-out work and were scored the same way — by running what
            they wrote. The gap between them is not quality. It is the cost of choosing without
            measuring.
          </p>
        </div>
      </div>
    </section>
  );
}
