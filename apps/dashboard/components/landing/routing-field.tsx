'use client';

// THE ROUTING FIELD — the hero instrument. A fixed-size plane of measured
// points (quality up, cost across, log scale) for one kind of work at a
// time; the policy floor drawn across it; the request arriving and the
// route drawing itself to the one point the policy picks. The receipt for
// that pick sits alongside in a fixed column. Nothing here ever changes
// size: every region has a fixed height, every text cell a fixed line
// count, so the page beneath it never moves.
//
// Every point is a committed frontier point (lib/evidence FIELD). The
// withheld model's name never enters the DOM. Reduced-motion users get the
// same instrument without the pulse.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { FIELD, ROUTE_DEMO } from '@/lib/evidence';
import { premiumCostFor } from '@/lib/economics';

const W = 640;
const H = 300;
const PAD = { l: 48, r: 26, t: 26, b: 34 };
const FLOOR = 0.95;
const CYCLE_MS = 3400;

function usd(n: number): string {
  return n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

function scales(points: { quality: number; costPer1K: number }[]) {
  const costs = points.map((p) => Math.log10(p.costPer1K));
  const minC = Math.min(...costs) - 0.2;
  const maxC = Math.max(...costs) + 0.35;
  // zoom the quality axis to the cluster, but always keep the floor in view
  const minQ = Math.min(FLOOR, ...points.map((p) => p.quality)) - 0.03;
  const maxQ = 1.012;
  const x = (c: number) => PAD.l + ((Math.log10(c) - minC) / (maxC - minC)) * (W - PAD.l - PAD.r);
  const y = (q: number) => PAD.t + (1 - (q - minQ) / (maxQ - minQ)) * (H - PAD.t - PAD.b);
  const step = maxQ - minQ > 0.3 ? 0.1 : maxQ - minQ > 0.12 ? 0.05 : 0.02;
  const ticks: number[] = [];
  for (let q = Math.ceil(minQ / step) * step; q <= 1.0001; q += step) ticks.push(Math.round(q * 1000) / 1000);
  return { x, y, ticks };
}

export function RoutingField() {
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return;
    const t = setTimeout(() => setI((k) => (k + 1) % ROUTE_DEMO.length), CYCLE_MS);
    return () => clearTimeout(t);
  }, [i, paused]);

  const d = ROUTE_DEMO[i]!;
  const points = FIELD[d.cluster] ?? [];
  const { x, y, ticks } = scales(points);
  // the policy, applied live to the measured points: cheapest at or above
  // the floor; when nothing clears it, the best quality at full price
  const above = points.filter((p) => p.quality >= FLOOR);
  const pick = above.length
    ? above.reduce((a, b) => (b.costPer1K < a.costPer1K ? b : a))
    : points.reduce((a, b) => (b.quality > a.quality ? b : a));
  const cleared = pick.quality >= FLOOR;
  const premium = premiumCostFor(d.cluster);
  const saved = premium && pick.costPer1K < premium * 0.98 ? Math.floor((1 - pick.costPer1K / premium) * 100) : null;
  const why = cleared
    ? `cheapest measured point above the 0.95 floor${saved !== null ? `; ${saved}% under the premium pick` : ''}${pick.label.includes('█') ? '. The name is the product.' : ''}`
    : 'nothing cheaper measures good enough: full price, and the receipt says so';
  const px = x(pick.costPer1K);
  const py = y(pick.quality);
  const entry = { x: PAD.l, y: PAD.t - 6 };
  const route = `M ${entry.x} ${entry.y} L ${entry.x} ${py} L ${px} ${py}`;

  return (
    <div
      className="w-full min-w-0 overflow-hidden rounded-2xl border border-line bg-panel shadow-[0_24px_70px_-18px_rgba(41,37,36,0.22)]"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {/* request row — one line, fixed height */}
      <div className="flex h-14 items-center gap-3 border-b border-line px-5">
        <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-accent" />
        <div key={i} className="field-fade min-w-0 flex-1 truncate text-left font-mono text-[13px] text-ink">{d.prompt}</div>
        <div className="hidden shrink-0 font-mono text-[11.5px] uppercase tracking-[0.13em] text-faint sm:block">
          {String(i + 1).padStart(2, '0')} / {String(ROUTE_DEMO.length).padStart(2, '0')}
        </div>
      </div>

      <div className="grid sm:grid-cols-[1fr_15.5rem]">
        {/* the plane — fixed aspect via viewBox; container height fixed */}
        <div className="relative h-[260px] sm:h-[300px]">
          <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 h-full w-full" preserveAspectRatio="none" aria-hidden>
            {/* grid */}
            {ticks.map((q) => (
              <line key={q} x1={PAD.l} x2={W - PAD.r} y1={y(q)} y2={y(q)} stroke="#e7e5e4" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            ))}
            <line x1={PAD.l} x2={PAD.l} y1={PAD.t} y2={H - PAD.b} stroke="#d6d3d1" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            <line x1={PAD.l} x2={W - PAD.r} y1={H - PAD.b} y2={H - PAD.b} stroke="#d6d3d1" strokeWidth="1" vectorEffect="non-scaling-stroke" />

            {/* policy floor */}
            <line x1={PAD.l} x2={W - PAD.r} y1={y(FLOOR)} y2={y(FLOOR)} stroke="#0f766e" strokeWidth="1" strokeDasharray="4 4" opacity="0.7" vectorEffect="non-scaling-stroke" />

            {/* route: request → floor → pick */}
            <path key={`r${i}`} d={route} fill="none" stroke="#0f766e" strokeWidth="1.5" className="field-route" vectorEffect="non-scaling-stroke" />

            {/* points */}
            {points.map((p) => {
              const isPick = p.hash8 === pick.hash8;
              const below = p.quality < FLOOR;
              return (
                <g key={`${i}-${p.hash8}`} className="field-fade">
                  <circle cx={x(p.costPer1K)} cy={y(p.quality)} r={isPick ? 6 : 4} fill={isPick ? '#0f766e' : below ? '#ffffff' : '#57534e'} stroke={isPick ? '#0f766e' : '#57534e'} strokeWidth={isPick ? 0 : 1.2} vectorEffect="non-scaling-stroke" />
                  {isPick && <circle cx={x(p.costPer1K)} cy={y(p.quality)} r="6" fill="none" stroke="#0f766e" strokeWidth="1.5" className="field-pulse" vectorEffect="non-scaling-stroke" />}
                </g>
              );
            })}
          </svg>

          {/* text overlays in HTML so type never stretches */}
          <div className="pointer-events-none absolute left-3 top-2 font-mono text-[11.5px] uppercase tracking-[0.14em] text-faint">quality ↑</div>
          {ticks.map((q) => (
            <div key={q} className="pointer-events-none absolute left-3 font-mono text-[9px] text-faint" style={{ top: `calc(${(y(q) / H) * 100}% - 6px)` }}>
              {q.toFixed(2)}
            </div>
          ))}
          <div className="pointer-events-none absolute bottom-2 right-4 font-mono text-[11.5px] uppercase tracking-[0.14em] text-faint">cost per 1,000 requests → (log)</div>
          <div className="pointer-events-none absolute right-4 font-mono text-[11.5px] text-accent" style={{ top: `calc(${(y(FLOOR) / H) * 100}% - 14px)` }}>
            floor 0.95
          </div>
          <div
            key={`l${i}`}
            className="field-fade pointer-events-none absolute max-w-[12rem] truncate rounded border border-line bg-panel/95 px-1.5 py-0.5 font-mono text-[12px] text-ink"
            style={{ left: `calc(${(px / W) * 100}% + 9px)`, top: `calc(${(py / H) * 100}% + 6px)` }}
          >
            {pick.label} <span className="text-faint">{pick.quality.toFixed(2)}</span>
          </div>
        </div>

        {/* the receipt — fixed column, fixed rows */}
        <div className="grid h-[188px] grid-rows-[auto_auto_auto_1fr] gap-2.5 border-t border-line px-5 py-4 text-left sm:h-[300px] sm:border-l sm:border-t-0">
          <div className="font-mono text-[11.5px] uppercase tracking-[0.13em] text-faint">receipt</div>
          <div key={`a${i}`} className="field-fade">
            <div className="font-mono text-[11.5px] uppercase tracking-[0.14em] text-faint">kind of work</div>
            <div className="mt-1 inline-block rounded bg-accent-soft px-1.5 py-0.5 font-mono text-[12px] text-accent">{d.cluster}</div>
          </div>
          <div key={`b${i}`} className="field-fade">
            <div className="font-mono text-[11.5px] uppercase tracking-[0.14em] text-faint">routed to · price · quality</div>
            <div className="mt-1 h-5 truncate font-mono text-[12px] text-ink">{pick.label}</div>
            <div className="font-mono text-[12px] text-ink">
              {usd(pick.costPer1K)}/1k · {pick.quality.toFixed(2)}{' '}
              {saved !== null ? <span className="text-accent">−{saved}%</span> : <span className="text-faint">full price</span>}
            </div>
          </div>
          <div key={`c${i}`} className="field-fade min-h-0">
            <div className="font-mono text-[11.5px] uppercase tracking-[0.14em] text-faint">why</div>
            <p className="mt-1 line-clamp-3 font-mono text-[12px] leading-relaxed text-soft">{why}</p>
          </div>
        </div>
      </div>

      <div className="flex h-10 items-center justify-between border-t border-line px-5 font-mono text-[11.5px] text-faint">
        <span className="truncate">{points.length} measured points · real frontier, not a simulation · hover to pause</span>
        <Link href="/login" className="shrink-0 text-accent hover:underline">
          route your own ↗
        </Link>
      </div>
    </div>
  );
}
