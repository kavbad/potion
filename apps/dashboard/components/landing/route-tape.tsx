// THE TAPE — the routing evidence as a full-bleed instrument feed.
//
// Six hero iterations put the routing information in a box beside the
// headline, and every box — card, flask, board, line, receipt — competed
// with the words next to it. The tape stops competing: it is an EDGE, not a
// box. A single hairline-bounded strip runs the full width of the viewport
// beneath the hero, streaming the five real routing decisions the way a
// laboratory chart recorder streams readings. The headline gets the whole
// stage; the evidence becomes the instrument hum underneath it.
//
// Server component, zero hydration: the motion is one CSS animation
// (globals.css .tape-track), content duplicated once so the loop's seam is
// invisible. Same data discipline as ever — every segment is a real
// committed frontier row, and the one segment in warn colour is the genuine
// up-route, priced at full because nothing cheaper measures good enough.
import { ROUTE_DEMO } from '@/lib/evidence';
import { cheapestCostFor, premiumCostFor } from '@/lib/economics';

function usd(n: number): string {
  return n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

function Segment({ d }: { d: (typeof ROUTE_DEMO)[number] }) {
  const premium = premiumCostFor(d.cluster);
  const cheapest = cheapestCostFor(d.cluster);
  const up =
    premium !== null && cheapest !== null && d.costPer1K >= premium * 0.98 && premium > cheapest * 3;
  const saved = premium !== null && !up ? Math.round((1 - d.costPer1K / premium) * 100) : null;
  return (
    <span className="flex shrink-0 items-baseline gap-3 px-8 font-mono text-xs">
      {/* the graduation tick — the page's one recurring gesture */}
      <span aria-hidden className="relative top-[1px] inline-flex items-center self-center">
        <span className="h-px w-5 bg-line" />
        <span className="h-2 w-px bg-line" />
      </span>
      <span className="max-w-[16rem] truncate text-faint">“{d.prompt}”</span>
      <span className="text-faint">→</span>
      <span className="text-soft">{d.cluster}</span>
      <span className="font-medium text-ink">{d.label}</span>
      <span className="text-soft">{usd(d.costPer1K)}/1k</span>
      <span className="text-faint">q {d.quality.toFixed(2)}</span>
      {up ? (
        <span className="text-warn">full price — nothing cheaper measures good enough</span>
      ) : saved !== null && saved > 0 ? (
        <span className="text-accent">−{saved}% vs premium</span>
      ) : null}
    </span>
  );
}

export function RouteTape() {
  const run = (
    <>
      {ROUTE_DEMO.map((d, i) => (
        <Segment key={i} d={d} />
      ))}
    </>
  );
  return (
    <div className="tape overflow-hidden border-y border-line bg-panel/60 py-3" aria-hidden>
      <div className="tape-track">
        {run}
        {run}
      </div>
    </div>
  );
}
