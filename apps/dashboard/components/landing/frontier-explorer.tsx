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
const MT = 22;
const MB = 40;
const COST_MIN = 0.005;
const COST_MAX = 3;
const Q_MIN = 0.35;
const Q_MAX = 1.0;

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

/** Label placement, computed from position and clamped to the canvas —
 * hand-placed offset tables strand on every republish (one crashed, one
 * collided) and are gone for good. */
/** Dot fill by measured quality: grey at the bottom of the range, teal at the top —
 * the eye reads "better" before it reads the axis. */
function qualityTint(q: number): string {
  const t = Math.max(0, Math.min(1, (q - 0.5) / 0.5));
  const mix = (a: number, b: number) => Math.round(a + (b - a) * t);
  return `rgb(${mix(214, 45)}, ${mix(211, 212)}, ${mix(209, 191)})`;
}

function labelPlacement(px: number, py: number): { dx: number; dy: number; anchor: 'start' | 'end' } {
  const anchor = px > W - MR - 150 ? 'end' : 'start';
  const dx = anchor === 'start' ? 10 : -10;
  const dy = py < MT + 26 ? 22 : -11;
  return { dx, dy, anchor };
}

export function FrontierExplorer() {
  const [kind, setKind] = useState<PolicyKind>('min_cost');
  const [floor, setFloor] = useState(0.6);
  const [ceilT, setCeilT] = useState(0.45); // 0..1 log-mapped ceiling
  const [p95, setP95] = useState(4000);

  const ceiling = useMemo(
    () => Math.pow(10, Math.log10(COST_MIN) + ceilT * (Math.log10(COST_MAX) - Math.log10(COST_MIN))),
    [ceilT],
  );
  const value = kind === 'min_cost' ? floor : kind === 'max_quality' ? ceiling : p95;
  const chosen = select(kind, value);

  const trace = chosen
    ? `cluster=${EXPLORER.cluster};strategy=${chosen.hash8};frontier=v${EXPLORER.frontierVersion};policy=${kind};fallback=0;provenance=live`
    : `cluster=${EXPLORER.cluster};strategy=default;frontier=v${EXPLORER.frontierVersion};policy=${kind};fallback=1;provenance=live`;

  // 2D-pareto subset for the guide line — DERIVED from the data rather than
  // named, so a republished frontier can never strand a stale label here
  // (that exact crash shipped once: three hardcoded v2 labels outlived v2).
  const staircase: (typeof EXPLORER.points)[number][] = [];
  for (const p of [...EXPLORER.points].sort((a, b) => a.costPer1K - b.costPer1K)) {
    if (staircase.length === 0 || p.quality > staircase[staircase.length - 1]!.quality) {
      staircase.push(p);
    }
  }
  let steps = '';
  staircase.forEach((p, i) => {
    const px = x(p.costPer1K).toFixed(1);
    const py = y(p.quality).toFixed(1);
    steps += i === 0 ? `M ${px} ${py}` : ` H ${px} V ${py}`;
  });

  const qTicks = [0.4, 0.6, 0.8, 1.0];
  const cTicks = [0.01, 0.1, 1];

  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-panel shadow-paper">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.16em] text-faint">
        <span aria-hidden className="inline-block h-2 w-2 rounded-full bg-accent/70" />
        the measured map · one kind of work · selection runs as you drag
      </div>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3">
        {POLICIES.map((p) => (
          <button
            key={p.kind}
            onClick={() => setKind(p.kind)}
            className={`rounded-md px-3 py-1.5 font-mono text-xs transition-colors ${
              kind === p.kind ? 'bg-accent text-white' : 'bg-paper text-soft hover:text-ink'
            }`}
          >
            {p.kind}
          </button>
        ))}
        <span className="ml-auto hidden text-xs text-faint sm:block">
          {POLICIES.find((p) => p.kind === kind)!.blurb}
        </span>
      </div>

      <div className="px-5 pt-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <label className="flex min-w-[16rem] flex-1 items-center gap-3">
            <span className="w-28 shrink-0 font-mono text-faint">
              {kind === 'min_cost' && `floor ${floor.toFixed(2)}`}
              {kind === 'max_quality' && `ceiling ${usd(ceiling)}`}
              {kind === 'latency_bound' && `p95 ≤ ${p95.toLocaleString()} ms`}
            </span>
            {kind === 'min_cost' && (
              <input type="range" min={0.4} max={1} step={0.01} value={floor}
                onChange={(e) => setFloor(Number(e.target.value))} className="flex-1 accent-[#0f766e]" />
            )}
            {kind === 'max_quality' && (
              <input type="range" min={0} max={1} step={0.01} value={ceilT}
                onChange={(e) => setCeilT(Number(e.target.value))} className="flex-1 accent-[#0f766e]" />
            )}
            {kind === 'latency_bound' && (
              <input type="range" min={1000} max={15000} step={250} value={p95}
                onChange={(e) => setP95(Number(e.target.value))} className="flex-1 accent-[#0f766e]" />
            )}
          </label>
        </div>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img"
        aria-label="Measured quality against cost for the multi-step-reasoning frontier">
        {qTicks.map((q) => (
          <g key={q}>
            <line x1={ML} x2={W - MR} y1={y(q)} y2={y(q)} stroke="#e7e2da" strokeWidth="1" />
            <text x={ML - 8} y={y(q) + 3} textAnchor="end" fontSize="10" fill="#a8a29e" fontFamily="monospace">
              {q.toFixed(1)}
            </text>
          </g>
        ))}
        {cTicks.map((c) => (
          <text key={c} x={x(c)} y={H - MB + 16} textAnchor="middle" fontSize="10" fill="#a8a29e" fontFamily="monospace">
            {`$${c}`}
          </text>
        ))}
        <text x={(ML + W - MR) / 2} y={H - 6} textAnchor="middle" fontSize="10" fill="#a8a29e">
          cost per 1,000 requests (log)
        </text>
        <text x={12} y={(MT + H - MB) / 2} textAnchor="middle" fontSize="10" fill="#a8a29e"
          transform={`rotate(-90 12 ${(MT + H - MB) / 2})`}>
          measured quality
        </text>

        {/* the frontier's step edge — solid, quiet, beneath the points */}
        <path d={steps} fill="none" stroke="#e7e2da" strokeWidth="1.5" />

        {/* the constraint, drawn: the slider IS this line */}
        {kind === 'min_cost' && (
          <g>
            <line x1={ML} x2={W - MR} y1={y(floor)} y2={y(floor)} stroke="#0f766e" strokeWidth="1" strokeDasharray="2 4" opacity="0.5" />
            <text x={W - MR} y={y(floor) - 5} textAnchor="end" fontSize="9.5" fontFamily="monospace" fill="#0f766e" opacity="0.75">
              floor {floor.toFixed(2)}
            </text>
          </g>
        )}
        {kind === 'max_quality' && (
          <g>
            <line x1={x(ceiling)} x2={x(ceiling)} y1={MT} y2={H - MB} stroke="#0f766e" strokeWidth="1" strokeDasharray="2 4" opacity="0.5" />
            <text x={x(ceiling) + 5} y={MT + 10} textAnchor="start" fontSize="9.5" fontFamily="monospace" fill="#0f766e" opacity="0.75">
              ceiling {usd(ceiling)}
            </text>
          </g>
        )}

        {EXPLORER.points.map((p) => {
          const sel = chosen?.label === p.label;
          const qualifies =
            kind === 'min_cost' ? p.quality >= floor :
            kind === 'max_quality' ? p.costPer1K <= ceiling :
            p.p95Ms <= p95;
          const dim = qualifies ? 1 : 0.3;
          const { dx, dy, anchor } = labelPlacement(x(p.costPer1K), y(p.quality));
          return (
            <g key={p.label} className="group" opacity={dim} style={{ transition: 'opacity 200ms' }}>
              <title>{`${p.label} — q ${p.quality.toFixed(2)} ±${p.ci.toFixed(2)} · ${usd(p.costPer1K)}/1k · p95 ${p.p95Ms.toLocaleString()} ms`}</title>
              {/* CI as a capless hairline — present, never shouting */}
              <line x1={x(p.costPer1K)} x2={x(p.costPer1K)} y1={y(Math.min(Q_MAX, p.quality + p.ci))}
                y2={y(Math.max(Q_MIN, p.quality - p.ci))} stroke={sel ? '#0f766e' : '#a8a29e'}
                strokeWidth="1" strokeLinecap="round" opacity={sel ? 0.55 : 0.3} />
              {sel && <circle cx={x(p.costPer1K)} cy={y(p.quality)} r="10" fill="#0f766e" opacity="0.12" />}
              <circle cx={x(p.costPer1K)} cy={y(p.quality)} r="4.5"
                fill={sel ? '#0f766e' : qualityTint(p.quality)} stroke={sel ? '#0f766e' : '#0f766e'} strokeWidth="1"
                strokeOpacity={sel ? 1 : 0.35} />
              <text x={x(p.costPer1K) + dx} y={y(p.quality) + dy} textAnchor={anchor} fontSize="10.5"
                fontFamily="monospace" fill={sel ? '#0f766e' : '#57534e'} fontWeight={sel ? '600' : '400'}
                stroke="#ffffff" strokeWidth="3.5" style={{ paintOrder: 'stroke' }}
                className={sel ? '' : 'pointer-events-none opacity-0 transition-opacity group-hover:opacity-100'}>
                {p.label}
              </text>
              {/* invisible fat hit-area so hovering a 4.5px dot is not a dexterity test */}
              <circle cx={x(p.costPer1K)} cy={y(p.quality)} r="14" fill="transparent" />
            </g>
          );
        })}
      </svg>

      <div className="border-t border-line px-5 py-4">
        {chosen ? (
          <p className="text-sm leading-relaxed text-soft">
            <span className="font-mono font-medium text-ink">{chosen.label}</span> — quality{' '}
            <span className="font-mono text-ink">{chosen.quality.toFixed(2)}</span>
            <span className="font-mono text-faint"> ±{chosen.ci.toFixed(2)}</span>, {usd(chosen.costPer1K)} per
            1k requests, p95 {chosen.p95Ms.toLocaleString()} ms.
          </p>
        ) : (
          <p className="text-sm leading-relaxed text-soft">
            <span className="font-medium text-warn">Nothing measured qualifies.</span> Potion refuses to
            invent a number — the request rides the default strategy and the trace says so.
          </p>
        )}
        <div className="mt-3 overflow-x-auto rounded bg-[#292524] px-3 py-2 font-mono text-[11px] leading-relaxed text-[#e7e2da]">
          <span className="text-[#a8a29e]">x-frontier-trace:</span> {trace}
        </div>
        <p className="mt-3 text-xs leading-relaxed text-faint">
          Real measured points, quoted from the committed frontier — hover any dot for its name and
          numbers. The cheapest row costs under a cent per 1k and measures 0.50, a coin flip, which
          is exactly why the router will not send reasoning work there: cheap only wins where the
          measurement clears your floor. Try <span className="font-mono">latency_bound</span> at
          2,500 ms — the answer changes.
        </p>
      </div>
    </div>
  );
}
