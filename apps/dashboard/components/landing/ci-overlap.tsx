// The "too close to call" claim, drawn instead of asserted. Two horizontal
// intervals on a shared quality axis; the shaded band is where they overlap.
// Server-rendered SVG — no client JS. Geometry is computed from the same
// TOO_CLOSE_EXAMPLE rows the table quotes, so the picture cannot drift from
// the numbers beside it.
import { TOO_CLOSE_EXAMPLE } from '@/lib/evidence';

const W = 620;
const H = 128;
const ML = 116;
const MR = 24;
const A_MIN = 0.78;
const A_MAX = 1.0;

function x(q: number): number {
  return ML + ((q - A_MIN) / (A_MAX - A_MIN)) * (W - ML - MR);
}

export function CiOverlap() {
  const { strong, cheap } = TOO_CLOSE_EXAMPLE;
  const rows = [
    { ...strong, y: 38 },
    { ...cheap, y: 74 },
  ];
  const overlapLo = Math.max(strong.quality - strong.ci, cheap.quality - cheap.ci);
  const overlapHi = Math.min(strong.quality + strong.ci, cheap.quality + cheap.ci);
  const ticks = [0.8, 0.85, 0.9, 0.95, 1.0];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img"
      aria-label="The two strategies' quality confidence intervals overlap almost entirely">
      <defs>
        {/* diagonal hairline hatching: the instrument-drawing convention for
            "one region, shared" — richer than a flat wash and still one ink */}
        <pattern id="ci-hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="7" stroke="#0f766e" strokeWidth="1" opacity="0.22" />
        </pattern>
      </defs>
      <rect x={x(overlapLo)} y={22} width={x(overlapHi) - x(overlapLo)} height={68}
        fill="#ccfbf1" opacity="0.35" />
      <rect x={x(overlapLo)} y={22} width={x(overlapHi) - x(overlapLo)} height={68}
        fill="url(#ci-hatch)" />
      {ticks.map((t) => (
        <g key={t}>
          <line x1={x(t)} x2={x(t)} y1={22} y2={90} stroke="#e7e2da" strokeWidth="1" opacity="0.6" />
          <text x={x(t)} y={106} textAnchor="middle" fontSize="10" fill="#a8a29e" fontFamily="monospace">
            {t.toFixed(2)}
          </text>
        </g>
      ))}
      {rows.map((r) => (
        <g key={r.label}>
          <text x={ML - 10} y={r.y + 4} textAnchor="end" fontSize="11" fontFamily="monospace" fill="#292524">
            {r.label}
          </text>
          {/* the interval is the subject here, so it keeps more weight than
              the frontier map's whiskers — but the caps go: a rounded end
              says “this is where the evidence stops” without scaffolding */}
          <line x1={x(r.quality - r.ci)} x2={x(r.quality + r.ci)} y1={r.y} y2={r.y}
            stroke="#a8a29e" strokeWidth="3.5" strokeLinecap="round" opacity="0.55" />
          <circle cx={x(r.quality)} cy={r.y} r="4.5" fill="#0f766e" stroke="#ffffff" strokeWidth="1.5" />
        </g>
      ))}
      <text x={(x(overlapLo) + x(overlapHi)) / 2} y={14} textAnchor="middle" fontSize="10"
        fill="#0f766e" fontFamily="monospace">
        shared ground
      </text>
    </svg>
  );
}
