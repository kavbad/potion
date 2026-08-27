// The problem, in one picture a non-engineer reads in three seconds: the SAME
// task, priced across the models that can do it. Server-rendered SVG, no
// client JS. Bars are real measured points from the extraction frontier —
// where the cheapest option measures 0.960 and the dearest 0.978, for
// roughly 170 times the money.
import { ECONOMICS } from '@/lib/economics';

export function PriceSpread() {
  const cluster = ECONOMICS.find((c) => c.id === 'extraction')!;
  const pts = [...cluster.points].sort((a, b) => a.c - b.c);
  const max = Math.max(...pts.map((p) => p.c));
  const cheapest = pts[0]!;
  const dearest = pts[pts.length - 1]!;
  const factor = (dearest.c / cheapest.c).toFixed(0);

  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-panel shadow-paper">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 font-mono text-[11.5px] uppercase tracking-[0.13em] text-faint">
        <span aria-hidden className="inline-block h-2 w-2 rounded-full bg-accent/70" />
        one task · pulling data out of documents
        <span className="ml-auto normal-case tracking-normal">every bar does the job</span>
      </div>
      <div className="space-y-3.5 px-6 py-6">
        {pts.map((p, i) => {
          const cheapestRow = i === 0;
          const pctW = Math.max(3, (p.c / max) * 100);
          return (
            <div key={i} className="flex items-center gap-3">
              <div className={`w-20 shrink-0 text-right font-mono text-xs ${cheapestRow ? 'font-medium text-accent' : 'text-soft'}`}>
                ${p.c.toFixed(2)}
              </div>
              <div className="relative h-7 flex-1 overflow-hidden rounded-md bg-paper">
                <div
                  className={`h-full rounded-md ${cheapestRow ? 'bg-accent' : 'bg-line'}`}
                  style={{ width: `${pctW}%` }}
                />
                {/* quality, printed at the bar's end — the point is that the
                    numbers barely differ while the bars wildly do */}
                <span
                  className={`absolute top-1/2 -translate-y-1/2 font-mono text-[11.5px] ${
                    cheapestRow ? 'text-white' : 'text-faint'
                  }`}
                  style={
                    cheapestRow
                      ? { right: `calc(${100 - pctW}% + 8px)` }
                      : { left: `calc(${pctW}% + 8px)` }
                  }
                >
                  q {p.q.toFixed(3)}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-4 flex items-end gap-2" aria-hidden>
        <span className="h-px w-14 bg-accent/60" />
        <span className="-ml-px h-[6px] w-px bg-accent/60" />
        <span className="font-mono text-[12px] leading-none text-accent">
          the routed pick — highest bar-for-bar value on the frontier
        </span>
      </div>
      <p className="mt-5 text-sm leading-relaxed text-soft">
        Every bar does the job. The dearest costs{' '}
        <span className="font-medium text-ink">{factor}× more</span> than the cheapest and measures{' '}
        <span className="font-medium text-ink">
          {((dearest.q - cheapest.q) * 100).toFixed(1)} points
        </span>{' '}
        better out of 100. Most companies are on a bar near the bottom of this chart for every
        request they send, because they picked one model and moved on.
      </p>
    </div>
  );
}
