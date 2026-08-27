'use client';

// THE RECEIPT — the hero artefact that was hiding in the copy all along.
//
// The headline says "cut your AI bill"; the qualifier says every answer
// "comes back with a receipt". So the artefact is the bill itself: a
// routing receipt that PRINTS — five real requests appear line by line the
// way thermal paper feeds, each with the model that served it and the real
// measured price, then the dashed rule, then the comparison: what the
// premium option would have charged for the same five, what routing charged,
// and the difference. The site's warm-paper aesthetic becomes literal
// receipt paper, and the metaphor closes: the page about cutting a bill
// hands you the bill, cut.
//
// Same data discipline as everything here: requests are authored; every
// price, model and quality is a real committed frontier row
// (lib/evidence.ts), and the premium comparison is derived per workload from
// lib/economics.ts. The totals are computed from the lines above them — a
// reader can check the receipt the way they would check a real one. The
// fourth line prints at FULL price on purpose: that is the up-route, and a
// receipt that only ever discounts would be an ad, not a measurement.
//
// Reduced motion: the receipt renders fully printed, no loop.
import { useEffect, useRef, useState } from 'react';
import { ROUTE_DEMO } from '@/lib/evidence';
import { cheapestCostFor, premiumCostFor } from '@/lib/economics';

const STEP_MS = 1050;
const HOLD_MS = 5200;
const N = ROUTE_DEMO.length;
// print phases: 1..N items, N+1 premium line, N+2 routed line, N+3 total
const LAST = N + 3;

function usd(n: number): string {
  return `$${n.toFixed(4)}`;
}

/** Bottom perforation: a row of teeth, generated once. */
const TEETH = (() => {
  const pts = ['0% 0%', '100% 0%'];
  for (let i = 0; i <= 25; i++) {
    const x = 100 - i * 4;
    pts.push(`${x}% calc(100% - ${i % 2 === 0 ? 7 : 0}px)`);
  }
  return `polygon(${pts.join(', ')})`;
})();

export function Receipt() {
  const [phase, setPhase] = useState(LAST);
  const hover = useRef(false);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let at = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = (): void => {
      if (hover.current && at >= LAST) {
        timer = setTimeout(tick, HOLD_MS);
        return;
      }
      at = at >= LAST ? 0 : at + 1;
      setPhase(at);
      timer = setTimeout(tick, at >= LAST ? HOLD_MS : at === 0 ? 500 : STEP_MS);
    };
    setPhase(0);
    timer = setTimeout(tick, 600);
    return () => clearTimeout(timer);
  }, []);

  const premiumTotal = ROUTE_DEMO.reduce((s, d) => s + (premiumCostFor(d.cluster) ?? d.costPer1K), 0);
  const routedTotal = ROUTE_DEMO.reduce((s, d) => s + d.costPer1K, 0);
  const savedPct = Math.round((1 - routedTotal / premiumTotal) * 100);

  const row = (visible: boolean): string =>
    `transition-all duration-500 ${visible ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0'}`;

  return (
    <figure className="m-0 lg:max-w-[26.5rem]">
      <div
        className="bg-panel px-7 pb-9 pt-6 lift shadow-paper"
        style={{ clipPath: TEETH }}
        onMouseEnter={() => (hover.current = true)}
        onMouseLeave={() => (hover.current = false)}
        role="img"
        aria-label={`A routing receipt: five real requests, premium option ${usd(premiumTotal)}, routed ${usd(routedTotal)} — ${savedPct} percent less`}
      >
        {/* masthead */}
        <div className="text-center font-mono text-[12px] uppercase tracking-[0.22em] text-ink">
          Potion
        </div>
        <div className="mt-1 text-center font-mono text-[11.5px] uppercase tracking-[0.14em] text-faint">
          routing receipt · per 1k requests
        </div>
        <div className="mt-4 border-t border-dashed border-line" />

        {/* line items */}
        <div className="mt-4 space-y-3">
          {ROUTE_DEMO.map((d, idx) => {
            const premium = premiumCostFor(d.cluster);
            const cheapest = cheapestCostFor(d.cluster);
            // The warn line is reserved for the GENUINE up-route: routing paid
            // the premium AND the premium costs materially more than the cheap
            // end of the cluster. rag-answer also serves its premium point —
            // but there the premium is within 10% of the cheapest option, so
            // "full price" would be technically true and completely
            // misleading. One warn beat per loop, where it means something.
            const up =
              premium !== null &&
              cheapest !== null &&
              d.costPer1K >= premium * 0.98 &&
              premium > cheapest * 3;
            return (
              <div key={idx} className={row(phase >= idx + 1)}>
                <div className="truncate text-xs leading-snug text-soft">{d.prompt}</div>
                <div className="mt-0.5 flex items-baseline gap-2 font-mono text-[12px]">
                  <span className="text-faint">{d.cluster}</span>
                  <span className="text-ink">· {d.label}</span>
                  <span className="min-w-4 flex-1 border-b border-dotted border-line" />
                  <span className={up ? 'text-warn' : 'text-ink'}>{usd(d.costPer1K)}</span>
                </div>
                {up && (
                  <div className={`text-right font-mono text-[11.5px] text-warn ${row(phase >= idx + 1)}`}>
                    full price — nothing cheaper measures good enough
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-4 border-t border-dashed border-line" />

        {/* totals — computed from the lines above, checkable like a real bill */}
        <div className="mt-3 space-y-1.5 font-mono text-[12px]">
          <div className={`flex items-baseline gap-2 ${row(phase >= N + 1)}`}>
            <span className="text-faint">premium model on all five</span>
            <span className="min-w-4 flex-1 border-b border-dotted border-line" />
            <span className="text-faint line-through decoration-warn/60">{usd(premiumTotal)}</span>
          </div>
          <div className={`flex items-baseline gap-2 ${row(phase >= N + 2)}`}>
            <span className="text-ink">routed by potion</span>
            <span className="min-w-4 flex-1 border-b border-dotted border-line" />
            <span className="text-ink">{usd(routedTotal)}</span>
          </div>
          <div className={`flex items-baseline gap-2 pt-1 text-[13px] font-medium ${row(phase >= LAST)}`}>
            <span className="text-accent">you keep</span>
            <span className="min-w-4 flex-1 border-b border-dotted border-accent/40" />
            <span className="text-accent">{savedPct}%</span>
          </div>
        </div>

        <div className={`mt-4 text-center font-mono text-[11.5px] uppercase tracking-[0.14em] text-faint ${row(phase >= LAST)}`}>
          every answer ships this receipt
        </div>
      </div>
      <figcaption className="mt-3 text-xs leading-relaxed text-faint">
        Five real requests, real measured prices — including the one routed to the dearest model
        because the measurements demanded it. Your traffic mix decides your number.
      </figcaption>
    </figure>
  );
}
