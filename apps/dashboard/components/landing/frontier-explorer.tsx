'use client';

// The interactive frontier — the product, working, on the landing page.
//
// Nine REAL measured points from the multi-step-reasoning frontier (the one
// cluster whose evidence resolves its own quality spread), a policy picker,
// and one contextual slider. Selection runs the real policy semantics over
// the real rows: min_cost takes the cheapest point at or above the floor,
// max_quality the best under the ceiling, latency_bound the best inside the
// p95 budget. Drag the floor past 1.0's error bars and you get the honest
// answer — fallback=1, nothing qualifies — because refusing to invent a
// number is the product's whole personality and the demo should have it too.
//
// Rendering notes. Cost is log-scaled (the range is ~177x). With nine points
// the always-on labels of the four-point era collided and clipped, so labels
// now appear on HOVER and on the selected point only, with placement clamped
// to the canvas; every point carries a native <title> tooltip as well. The
// cheapest row is the masked discovery — its name never enters the DOM.
import { useMemo, useState } from 'react';
import { EXPLORER, type LandingPoint } from '@/lib/evidence';

type PolicyKind = 'min_cost' | 'latency_bound' | 'max_quality';

const POLICIES: { kind: PolicyKind; label: string; blurb: string }[] = [
  { kind: 'min_cost', label: 'min_cost', blurb: 'cheapest at or above a quality floor' },
  { kind: 'max_quality', label: 'max_quality', blurb: 'best quality under a cost ceiling' },
  { kind: 'latency_bound', label: 'latency_bound', blurb: 'best quality inside a p95 budget' },
];

const W = 640;
const H = 330;
const ML = 46;
const MR = 18;
const MT = 30;
const MB = 40;
const COST_MIN = 0.005;
const COST_MAX = 3;
const Q_MIN = 0.35;
const Q_MAX = 1.02;

function x(cost: number): number {
  const t = (Math.log10(cost) - Math.log10(COST_MIN)) / (Math.log10(COST_MAX) - Math.log10(COST_MIN));
  return ML + t * (W - ML - MR);
}
function y(q: number): number {
  return MT + (1 - (q - Q_MIN) / (Q_MAX - Q_MIN)) * (H - MT - MB);
}
function usd(n: number): string {
  return n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

function select(kind: PolicyKind, v: number): LandingPoint | null {
  const pts = EXPLORER.points;
  if (kind === 'min_cost') {
    const ok = pts.filter((p) => p.quality >= v);
    return ok.length ? ok.reduce((a, b) => (a.costPer1K <= b.costPer1K ? a : b)) : null;
  }
  if (kind === 'max_quality') {
    const ok = pts.filter((p) => p.costPer1K <= v);
    return ok.length ? ok.reduce((a, b) => (a.quality >= b.quality ? a : b)) : null;
  }
  const ok = pts.filter((p) => p.p95Ms <= v);
  if (!ok.length) return null;
  return ok.reduce((a, b) =>
    b.quality > a.quality || (b.quality === a.quality && b.costPer1K < a.costPer1K) ? b : a,
  );
}


const INK = '#1c1a17';
const FAINT = '#8a857a';
const ACCENT = '#0f766e';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

export function FrontierExplorer() {
  const [kind, setKind] = useState<PolicyKind>('min_cost');
  const [floor, setFloor] = useState(0.6);
  const [ceilT, setCeilT] = useState(0.45); // 0..1 log-mapped ceiling
  const [p95, setP95] = useState(4000);
  const [hover, setHover] = useState<string | null>(null);

  const ceiling = useMemo(
    () => Math.pow(10, Math.log10(COST_MIN) + ceilT * (Math.log10(COST_MAX) - Math.log10(COST_MIN))),
    [ceilT],
  );
  const value = kind === 'min_cost' ? floor : kind === 'max_quality' ? ceiling : p95;
  const chosen = select(kind, value);

  const trace = chosen
    ? `cluster=${EXPLORER.cluster};strategy=${chosen.hash8};frontier=v${EXPLORER.frontierVersion};policy=${kind};fallback=0;provenance=live`
    : `cluster=${EXPLORER.cluster};strategy=default;frontier=v${EXPLORER.frontierVersion};policy=${kind};fallback=1;provenance=live`;

  // 2D-pareto subset for the step edge — DERIVED from the data, never named.
  const staircase: LandingPoint[] = [];
  for (const p of [...EXPLORER.points].sort((a, b) => a.costPer1K - b.costPer1K)) {
    if (staircase.length === 0 || p.quality > staircase[staircase.length - 1]!.quality) staircase.push(p);
  }
  const onEdge = new Set(staircase.map((p) => p.label));
  let steps = '';
  staircase.forEach((p, i) => {
    const px = x(p.costPer1K).toFixed(1);
    const py = y(p.quality).toFixed(1);
    steps += i === 0 ? `M ${px} ${py}` : ` H ${px} V ${py}`;
  });

  const qTicks = [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
  const cMajor = [0.01, 0.1, 1];
  const cMinor = [0.005, 0.02, 0.03, 0.05, 0.2, 0.3, 0.5, 2, 3];
  const labelled = hover ? EXPLORER.points.find((p) => p.label === hover) ?? chosen : chosen;

  // Callout: a short leader to a label set clear of the data, clamped to the plot.
  const callout = (() => {
    if (!labelled) return null;
    const px = x(labelled.costPer1K);
    const py = y(labelled.quality);
    const right = px < W - MR - 170;
    const lx = right ? px + 22 : px - 22;
    const ly = py < MT + 34 ? py + 26 : py - 18;
    return { px, py, lx, ly, anchor: right ? ('start' as const) : ('end' as const) };
  })();

  const qualifies = (p: LandingPoint) =>
    kind === 'min_cost' ? p.quality >= floor : kind === 'max_quality' ? p.costPer1K <= ceiling : p.p95Ms <= p95;

  return (
    <div className="bg-[#fbfaf7] font-mono">
      {/* title row */}
      <div className="flex items-center justify-between border-b border-[#d9d5cb] px-4 py-2.5 text-[11.5px] uppercase tracking-[0.13em] text-faint">
        <span>{EXPLORER.cluster} · v{EXPLORER.frontierVersion} · n = {EXPLORER.items} per point</span>
        <span className="hidden sm:inline">{POLICIES.find((p) => p.kind === kind)!.blurb}</span>
      </div>

      {/* controls: a segmented rule, not buttons; a hairline slider with a square thumb */}
      <div className="grid gap-x-8 gap-y-3 border-b border-[#d9d5cb] px-4 py-3 text-[12px] sm:grid-cols-[auto_1fr] sm:items-center">
        <div className="flex divide-x divide-[#d9d5cb] border border-[#d9d5cb]">
          {POLICIES.map((p) => (
            <button
              key={p.kind}
              onClick={() => setKind(p.kind)}
              className={`px-3 py-1.5 transition-colors ${kind === p.kind ? 'bg-ink text-[#f4f2ec]' : 'text-soft hover:text-ink'}`}
            >
              {p.kind}
            </button>
          ))}
        </div>
        <label className="flex w-full items-center gap-4">
          <span className="w-36 shrink-0 text-faint">
            {kind === 'min_cost' && <>floor <span className="text-ink">{floor.toFixed(2)}</span></>}
            {kind === 'max_quality' && <>ceiling <span className="text-ink">{usd(ceiling)}</span></>}
            {kind === 'latency_bound' && <>p95 ≤ <span className="text-ink">{p95.toLocaleString('en-US')} ms</span></>}
          </span>
          {kind === 'min_cost' && (
            <input type="range" min={0.4} max={1} step={0.01} value={floor} onChange={(e) => setFloor(Number(e.target.value))} className="lab-range flex-1" />
          )}
          {kind === 'max_quality' && (
            <input type="range" min={0} max={1} step={0.01} value={ceilT} onChange={(e) => setCeilT(Number(e.target.value))} className="lab-range flex-1" />
          )}
          {kind === 'latency_bound' && (
            <input type="range" min={1000} max={15000} step={250} value={p95} onChange={(e) => setP95(Number(e.target.value))} className="lab-range flex-1" />
          )}
        </label>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" fontFamily={MONO}
        aria-label="Measured quality against cost for the multi-step-reasoning frontier">
        {/* grid + axes */}
        {qTicks.map((q) => (
          <g key={q}>
            <line x1={ML} x2={W - MR} y1={y(q)} y2={y(q)} stroke="#ebe8e0" strokeWidth="1" />
            <line x1={ML - 4} x2={ML} y1={y(q)} y2={y(q)} stroke={INK} strokeWidth="1" />
            <text x={ML - 8} y={y(q) + 3} textAnchor="end" fontSize="9.5" fill={FAINT}>{q.toFixed(1)}</text>
          </g>
        ))}
        {cMinor.map((c) => (
          <line key={c} x1={x(c)} x2={x(c)} y1={H - MB} y2={H - MB + 3} stroke={INK} strokeWidth="1" />
        ))}
        {cMajor.map((c) => (
          <g key={c}>
            <line x1={x(c)} x2={x(c)} y1={H - MB} y2={H - MB + 5} stroke={INK} strokeWidth="1" />
            <text x={x(c)} y={H - MB + 16} textAnchor="middle" fontSize="9.5" fill={FAINT}>{`$${c}`}</text>
          </g>
        ))}
        <line x1={ML} x2={ML} y1={MT} y2={H - MB} stroke={INK} strokeWidth="1" />
        <line x1={ML} x2={W - MR} y1={H - MB} y2={H - MB} stroke={INK} strokeWidth="1" />
        <text x={W - MR} y={H - 6} textAnchor="end" fontSize="9.5" fill={FAINT} letterSpacing="0.08em">COST PER 1,000 REQUESTS · LOG</text>
        <text x={11} y={MT} textAnchor="end" fontSize="9.5" fill={FAINT} letterSpacing="0.08em" transform={`rotate(-90 11 ${MT})`}>MEASURED QUALITY</text>

        {/* the frontier's step edge */}
        <path d={steps} fill="none" stroke={INK} strokeWidth="1" opacity="0.45" />

        {/* the constraint: the slider IS this line */}
        {kind === 'min_cost' && (
          <g>
            <line x1={ML} x2={W - MR} y1={y(floor)} y2={y(floor)} stroke={ACCENT} strokeWidth="1" strokeDasharray="3 4" />
            <text x={W - MR - 4} y={y(floor) - 5} textAnchor="end" fontSize="9.5" fill={ACCENT}>floor {floor.toFixed(2)}</text>
          </g>
        )}
        {kind === 'max_quality' && (
          <g>
            <line x1={x(ceiling)} x2={x(ceiling)} y1={MT} y2={H - MB} stroke={ACCENT} strokeWidth="1" strokeDasharray="3 4" />
            <text x={x(ceiling) + 6} y={MT + 10} textAnchor="start" fontSize="9.5" fill={ACCENT}>ceiling {usd(ceiling)}</text>
          </g>
        )}

        {/* intervals, then points: frontier members filled, dominated hollow; selected in the accent */}
        {EXPLORER.points.map((p) => {
          const sel = chosen?.label === p.label;
          const ok = qualifies(p);
          const px = x(p.costPer1K);
          const py = y(p.quality);
          return (
            <g key={p.label} opacity={ok ? 1 : 0.35} style={{ transition: 'opacity 200ms' }}
              onMouseEnter={() => setHover(p.label)} onMouseLeave={() => setHover(null)}>
              <title>{`${p.label} — q ${p.quality.toFixed(2)} ±${p.ci.toFixed(2)} · ${usd(p.costPer1K)}/1k · p95 ${p.p95Ms.toLocaleString('en-US')} ms`}</title>
              <line x1={px} x2={px} y1={y(Math.min(Q_MAX, p.quality + p.ci))} y2={y(Math.max(Q_MIN, p.quality - p.ci))}
                stroke={sel ? ACCENT : INK} strokeWidth="1" opacity={sel ? 0.9 : 0.45} />
              <line x1={px - 3} x2={px + 3} y1={y(Math.min(Q_MAX, p.quality + p.ci))} y2={y(Math.min(Q_MAX, p.quality + p.ci))} stroke={sel ? ACCENT : INK} strokeWidth="1" opacity={sel ? 0.9 : 0.45} />
              <line x1={px - 3} x2={px + 3} y1={y(Math.max(Q_MIN, p.quality - p.ci))} y2={y(Math.max(Q_MIN, p.quality - p.ci))} stroke={sel ? ACCENT : INK} strokeWidth="1" opacity={sel ? 0.9 : 0.45} />
              {sel ? (
                <>
                  <circle cx={px} cy={py} r="7" fill="none" stroke={ACCENT} strokeWidth="1" />
                  <circle cx={px} cy={py} r="3.5" fill={ACCENT} />
                </>
              ) : onEdge.has(p.label) ? (
                <circle cx={px} cy={py} r="3.5" fill={INK} />
              ) : (
                <circle cx={px} cy={py} r="3.5" fill="#fbfaf7" stroke={INK} strokeWidth="1" />
              )}
              <circle cx={px} cy={py} r="14" fill="transparent" />
            </g>
          );
        })}

        {/* one callout, by leader, clear of the data */}
        {callout && labelled && (
          <g pointerEvents="none">
            <line x1={callout.px + (callout.anchor === 'start' ? 6 : -6)} y1={callout.py + (callout.ly > callout.py ? 6 : -6)}
              x2={callout.lx - (callout.anchor === 'start' ? 4 : -4)} y2={callout.ly - 3} stroke={INK} strokeWidth="0.75" />
            <text x={callout.lx} y={callout.ly} textAnchor={callout.anchor} fontSize="10.5" fill={INK}
              stroke="#fbfaf7" strokeWidth="4" style={{ paintOrder: 'stroke' }}>
              {labelled.label}
            </text>
            <text x={callout.lx} y={callout.ly + 12} textAnchor={callout.anchor} fontSize="9" fill={FAINT}
              stroke="#fbfaf7" strokeWidth="4" style={{ paintOrder: 'stroke' }}>
              {labelled.quality.toFixed(2)} ± {labelled.ci.toFixed(2)} · {usd(labelled.costPer1K)}/1k · p95 {labelled.p95Ms.toLocaleString('en-US')} ms
            </text>
          </g>
        )}

        {/* legend: lower right, clear of the data */}
        <g fontSize="9" fill={FAINT}>
          <circle cx={W - MR - 246} cy={H - MB - 14} r="3" fill={INK} />
          <text x={W - MR - 238} y={H - MB - 11}>on the frontier</text>
          <circle cx={W - MR - 146} cy={H - MB - 14} r="3" fill="#fbfaf7" stroke={INK} strokeWidth="1" />
          <text x={W - MR - 138} y={H - MB - 11}>dominated</text>
          <line x1={W - MR - 74} x2={W - MR - 74} y1={H - MB - 19} y2={H - MB - 9} stroke={INK} strokeWidth="1" opacity="0.6" />
          <line x1={W - MR - 77} x2={W - MR - 71} y1={H - MB - 19} y2={H - MB - 19} stroke={INK} strokeWidth="1" opacity="0.6" />
          <line x1={W - MR - 77} x2={W - MR - 71} y1={H - MB - 9} y2={H - MB - 9} stroke={INK} strokeWidth="1" opacity="0.6" />
          <text x={W - MR - 66} y={H - MB - 11}>95% interval</text>
        </g>
      </svg>

      {/* readout: a typeset row, then the trace as a hairline box */}
      <div className="border-t border-[#d9d5cb] px-4 py-3 text-[12px]">
        {chosen ? (
          <div className="grid gap-x-6 gap-y-1 sm:grid-cols-[auto_auto_auto_auto]">
            <span><span className="text-faint">selected </span><span className="text-ink">{chosen.label}</span></span>
            <span><span className="text-faint">quality </span><span className="text-ink">{chosen.quality.toFixed(2)}</span><span className="text-faint"> ± {chosen.ci.toFixed(2)}</span></span>
            <span><span className="text-faint">cost </span><span className="text-ink">{usd(chosen.costPer1K)}</span><span className="text-faint"> / 1k</span></span>
            <span><span className="text-faint">p95 </span><span className="text-ink">{chosen.p95Ms.toLocaleString('en-US')} ms</span></span>
          </div>
        ) : (
          <div><span className="text-ink">Nothing measured qualifies.</span> <span className="text-soft">Potion refuses to invent a number; the request rides the default strategy and the trace says so.</span></div>
        )}
        <div className="mt-2.5 overflow-x-auto border border-[#d9d5cb] px-3 py-1.5 text-[12px] text-soft">
          <span className="text-faint">x-frontier-trace:</span> {trace}
        </div>
        <p className="mt-2.5 font-sans text-[12px] leading-relaxed text-faint">
          Real measured points, quoted from the committed frontier; hover any point for its name and
          numbers. The cheapest row costs under a cent per 1k and measures 0.50, a coin flip, which
          is why the compiler will not send reasoning work there: cheap only wins where the measurement
          clears your floor. Try <span className="font-mono">latency_bound</span> at 2,500 ms; the answer changes.
        </p>
      </div>
    </div>
  );
}
