'use client';

// THE HERO — "One request, two roads." The product's whole argument as a
// picture, in the lab style: ink on paper, one accent, a fixed box, motion
// only in dots and lines.
//
//   Left lane  · a gateway: every request travels the same line to the one
//                model you picked once.
//   Right lane · Potion: the same request passes through the measured field
//                for its kind of work — the real frontier points, a floor —
//                and the route lights the cheapest point that clears it.
//                Sometimes that is the expensive one, on purpose.
//
// Beneath each lane a tally runs: cost per 1,000 requests at this mix of
// work, and the measured quality. Same requests, same quality, one lane
// spending a fraction of the other. Every number is a committed
// measurement (lib/evidence FIELD, lib/economics premiums); the withheld
// model's name never enters the DOM; the left lane is "a gateway", never a
// supplier's name. Reduced-motion users see the final frame.
import { useEffect, useMemo, useState } from 'react';
import { FIELD, ROUTE_DEMO } from '@/lib/evidence';
import { premiumCostFor } from '@/lib/economics';

const INK = '#1c1a17';
const RULE = '#b8b3a6';
const FAINT = '#8a857a';
const ACCENT = '#0f766e';
const PAPER = '#fbfaf7';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

const W = 760;
const H = 300;
const FLOOR = 0.95;
const TICK_MS = 3400;

const WORK: Record<string, string> = {
  classification: 'sorting text',
  'code-gen': 'writing code',
  extraction: 'extracting fields',
  'rag-answer': 'answering from documents',
  'multi-step-reasoning': 'multi-step reasoning',
  creative: 'writing with flair',
};

function usd(n: number): string {
  return n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

interface Decision {
  cluster: string;
  prompt: string;
  pick: { label: string; quality: number; costPer1K: number; hash8: string };
  premium: number;
  cleared: boolean;
}

function decide(i: number): Decision {
  const d = ROUTE_DEMO[i % ROUTE_DEMO.length]!;
  const points = FIELD[d.cluster] ?? [];
  const above = points.filter((p) => p.quality >= FLOOR);
  const pick = above.length
    ? above.reduce((a, b) => (b.costPer1K < a.costPer1K ? b : a))
    : points.reduce((a, b) => (b.quality > a.quality ? b : a));
  const premium = premiumCostFor(d.cluster) ?? points.reduce((a, b) => (b.costPer1K > a.costPer1K ? b : a)).costPer1K;
  return { cluster: d.cluster, prompt: d.prompt, pick, premium, cleared: pick.quality >= FLOOR };
}

// The right lane's field: the cluster's points on a small log-cost × quality plane.
const FX0 = 470, FX1 = 700, FY0 = 60, FY1 = 200;
function fieldScales(points: { quality: number; costPer1K: number }[]) {
  const cs = points.map((p) => Math.log10(p.costPer1K));
  const minC = Math.min(...cs) - 0.15, maxC = Math.max(...cs) + 0.15;
  const minQ = Math.min(FLOOR, ...points.map((p) => p.quality)) - 0.03, maxQ = 1.015;
  return {
    x: (c: number) => FX0 + ((Math.log10(c) - minC) / (maxC - minC)) * (FX1 - FX0),
    y: (q: number) => FY0 + (1 - (q - minQ) / (maxQ - minQ)) * (FY1 - FY0),
  };
}

export function TwoRoads() {
  const [n, setN] = useState(0);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) return;
    const t = setTimeout(() => setN((k) => k + 1), TICK_MS);
    return () => clearTimeout(t);
  }, [n, paused]);

  const served = useMemo(() => Array.from({ length: Math.min(n + 1, ROUTE_DEMO.length) }, (_, k) => decide(n - k)).reverse(), [n]);
  const cur = served[served.length - 1]!;
  const points = FIELD[cur.cluster] ?? [];
  const { x, y } = fieldScales(points);
  const px = x(cur.pick.costPer1K), py = y(cur.pick.quality);

  // tallies over the requests served so far in this cycle (mean per 1,000)
  const gwCost = served.reduce((s, d) => s + d.premium, 0) / served.length;
  const poCost = served.reduce((s, d) => s + d.pick.costPer1K, 0) / served.length;
  const gwQ = served.reduce((s, d) => s + Math.max(d.pick.quality, ...((FIELD[d.cluster] ?? []).map((p) => p.quality))), 0) / served.length;
  const poQ = served.reduce((s, d) => s + d.pick.quality, 0) / served.length;
  const saved = Math.max(0, Math.floor((1 - poCost / gwCost) * 100));

  return (
    <div className="w-full bg-[#fbfaf7]" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
      <div className="flex h-11 items-center justify-between border-b border-[#d9d5cb] px-4 font-mono text-[11.5px] uppercase tracking-[0.13em] text-faint">
        <span>one request · two roads</span>
        <span className="hidden sm:inline">{String((n % ROUTE_DEMO.length) + 1).padStart(2, '0')} / 06 · real measurements · hover to pause</span>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="block w-full" fontFamily={MONO} aria-label="The same request through a gateway and through Potion" role="img">
        {/* lane titles */}
        <text x="24" y="30" fontSize="10" fill={FAINT} letterSpacing="0.14em">A GATEWAY · ONE MODEL FOR EVERYTHING</text>
        <text x="404" y="30" fontSize="10" fill={FAINT} letterSpacing="0.14em">POTION · THE MEASURED FIELD</text>
        <line x1="380" y1="16" x2="380" y2={H - 16} stroke="#d9d5cb" strokeWidth="1" />

        {/* ---- left lane: the single road ---- */}
        <text x="24" y="126" fontSize="9" fill={FAINT} letterSpacing="0.1em">REQUEST</text>
        <line x1="24" y1="132" x2="252" y2="132" stroke={INK} strokeWidth="1" />
        <circle cx="292" cy="132" r="26" fill="none" stroke={INK} strokeWidth="1" />
        <text x="292" y="129" textAnchor="middle" fontSize="9" fill={INK}>the one</text>
        <text x="292" y="140" textAnchor="middle" fontSize="9" fill={INK}>model</text>
        <text x="292" y="176" textAnchor="middle" fontSize="9" fill={FAINT} letterSpacing="0.08em">EVERY TIME · {usd(cur.premium)} / 1k</text>
        {/* the travelling request */}
        <g key={`g${n}`} className="roads-travel-left">
          <circle cx="24" cy="132" r="4" fill={INK} />
        </g>
        {/* faint trail of the previous requests: all on the same line */}
        {served.slice(0, -1).map((_, k) => (
          <circle key={k} cx={60 + k * 30} cy="132" r="2.5" fill={INK} opacity="0.25" />
        ))}

        {/* ---- right lane: the field ---- */}
        <text x="404" y="126" fontSize="9" fill={FAINT} letterSpacing="0.1em">REQUEST</text>
        <line x1="404" y1="132" x2="452" y2="132" stroke={INK} strokeWidth="1" />
        <text x="404" y="150" fontSize="9" fill={ACCENT}>{WORK[cur.cluster] ?? cur.cluster}</text>
        {/* plane */}
        <line x1={FX0} y1={FY1} x2={FX1} y2={FY1} stroke="#d9d5cb" strokeWidth="1" />
        <line x1={FX0} y1={FY0} x2={FX0} y2={FY1} stroke="#d9d5cb" strokeWidth="1" />
        <text x={FX1} y={FY1 + 12} textAnchor="end" fontSize="8" fill={FAINT} letterSpacing="0.08em">COST →</text>
        <text x={FX0 - 4} y={FY0 + 4} textAnchor="end" fontSize="8" fill={FAINT} letterSpacing="0.08em">Q ↑</text>
        <line x1={FX0} y1={y(FLOOR)} x2={FX1} y2={y(FLOOR)} stroke={ACCENT} strokeWidth="1" strokeDasharray="3 4" />
        <text x={FX1} y={y(FLOOR) - 4} textAnchor="end" fontSize="8" fill={ACCENT}>floor {FLOOR.toFixed(2)}</text>
        {/* the route: entry → floor height → the pick */}
        <path key={`r${n}`} d={`M 452 132 L 458 132 L 458 ${py.toFixed(1)} L ${px.toFixed(1)} ${py.toFixed(1)}`} fill="none" stroke={ACCENT} strokeWidth="1.5" className="roads-route" />
        {points.map((p) => {
          const sel = p.hash8 === cur.pick.hash8;
          const cx = x(p.costPer1K), cy = y(p.quality);
          return sel ? (
            <g key={`${n}-${p.hash8}`}>
              <circle cx={cx} cy={cy} r="7" fill="none" stroke={ACCENT} strokeWidth="1" className="roads-ring" />
              <circle cx={cx} cy={cy} r="3.5" fill={ACCENT} />
            </g>
          ) : p.quality >= FLOOR ? (
            <circle key={`${n}-${p.hash8}`} cx={cx} cy={cy} r="3" fill={INK} />
          ) : (
            <circle key={`${n}-${p.hash8}`} cx={cx} cy={cy} r="3" fill={PAPER} stroke={INK} strokeWidth="1" />
          );
        })}
        <g key={`t${n}`} className="roads-travel-right">
          <circle cx="404" cy="132" r="4" fill={ACCENT} />
        </g>
        {/* the receipt line */}
        <text key={`rc${n}`} x="404" y="228" fontSize="9.5" fill={INK} className="roads-fade">
          → {cur.pick.label.replace('████████████', '██████')} · {usd(cur.pick.costPer1K)} / 1k · scores {cur.pick.quality.toFixed(2)}
        </text>
        <text x="404" y="242" fontSize="8.5" fill={FAINT}>
          {cur.cleared ? `cheapest point above the floor · ${Math.max(0, Math.floor((1 - cur.pick.costPer1K / cur.premium) * 100))}% under the one model` : 'nothing cheaper is good enough: the strong model, on purpose'}
        </text>

        {/* ---- tallies ---- */}
        <line x1="24" y1="258" x2={W - 24} y2="258" stroke={RULE} strokeWidth="1" />
        <text x="24" y="280" fontSize="9" fill={FAINT} letterSpacing="0.1em">COST / 1K</text>
        <text x="96" y="281" fontSize="14" fill={INK}>{usd(gwCost)}</text>
        <text x="196" y="280" fontSize="9" fill={FAINT} letterSpacing="0.1em">QUALITY</text>
        <text x="256" y="281" fontSize="14" fill={INK}>{gwQ.toFixed(2)}</text>
        <text x="404" y="280" fontSize="9" fill={FAINT} letterSpacing="0.1em">COST / 1K</text>
        <text x="476" y="281" fontSize="14" fill={ACCENT}>{usd(poCost)}</text>
        <text x="576" y="280" fontSize="9" fill={FAINT} letterSpacing="0.1em">QUALITY</text>
        <text x="636" y="281" fontSize="14" fill={INK}>{poQ.toFixed(2)}</text>
        <text x={W - 24} y="281" textAnchor="end" fontSize="11" fill={ACCENT}>−{saved}%</text>
      </svg>

      <div className="flex h-9 items-center border-t border-[#d9d5cb] px-4 font-mono text-[11.5px] text-faint">
        <span className="truncate">tallies are means over the requests served so far · same work, same quality bar, two roads</span>
      </div>
    </div>
  );
}
