// Figure 4 — the research loop, typeset (redesign 2026-08-27: the old
// boxes-and-arrows square read as engineer clipart). The week is a RAIL:
// five stations left to right in the order the machine actually runs them,
// ink dots and mono labels, the one accent on the station where your
// traffic lives — and the loop closes underneath, receipts feeding the
// next measurement. Says what the machine does, never how a combination is
// built: no mechanism names, no thresholds, no components.
const INK = '#1c1a17';
const FAINT = '#8a857a';
const ACCENT = '#0f766e';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

// Sub-labels live in the FIGURE CAPTION (HTML, legible), never in tiny SVG
// text — the legibility floor applies inside figures too.
const STATIONS: Array<{ x: number; label: string; accent?: boolean }> = [
  { x: 52, label: 'measure' },
  { x: 143, label: 'replay' },
  { x: 234, label: 'audition' },
  { x: 325, label: 'publish' },
  { x: 416, label: 'serve', accent: true },
];

export function ResearchLoop() {
  return (
    <div className="bg-[#fbfaf7]">
      <div className="border-b border-[#d9d5cb] px-4 py-2.5 font-mono text-[11.5px] uppercase tracking-[0.13em] text-faint">
        the research loop · runs weekly · no one in it
      </div>
      <div className="px-5 py-6 sm:px-7">
        <svg viewBox="0 0 468 132" className="w-full" role="img" fontFamily={MONO}
          aria-label="Potion's weekly research loop: measure, replay, audition, publish, serve; receipts feed the next measurement">
          <defs>
            <marker id="rlk" viewBox="0 0 8 8" refX="6.5" refY="4" markerWidth="6.5" markerHeight="6.5" orient="auto">
              <path d="M0 0.5 L7 4 L0 7.5" fill="none" stroke={INK} strokeWidth="1" />
            </marker>
            <marker id="rlkD" viewBox="0 0 8 8" refX="6.5" refY="4" markerWidth="6.5" markerHeight="6.5" orient="auto">
              <path d="M0 0.5 L7 4 L0 7.5" fill="none" stroke={FAINT} strokeWidth="1" />
            </marker>
          </defs>

          {/* the rail: one week, left to right */}
          {STATIONS.slice(0, -1).map((s, i) => (
            <line key={s.label} x1={s.x + 9} y1="56" x2={STATIONS[i + 1]!.x - 11} y2="56" stroke={INK} strokeWidth="1" markerEnd="url(#rlk)" />
          ))}
          {STATIONS.map((s) => (
            <g key={s.label}>
              <circle cx={s.x} cy="56" r={s.accent ? 5.5 : 4} fill={s.accent ? ACCENT : INK} />
              <text x={s.x} y="36" textAnchor="middle" fontSize="14" fill={s.accent ? ACCENT : INK}>{s.label}</text>
            </g>
          ))}

          {/* the loop closes: receipts feed the next measurement */}
          <path d="M 416 68 C 416 96, 350 102, 234 102 C 118 102, 52 96, 52 68" fill="none" stroke={FAINT} strokeWidth="1" strokeDasharray="3 4" markerEnd="url(#rlkD)" />
          <text x="234" y="122" textAnchor="middle" fontSize="10" fill={FAINT} letterSpacing="0.05em">receipts feed the next measurement</text>
        </svg>
      </div>
      <div className="border-t border-[#d9d5cb] px-4 py-2.5 font-mono text-[11.5px] leading-relaxed text-faint">
        what compounds: item-level results, every model and combination, weekly, with intervals and
        dates on every point · a combination is one hash — what it is made of is not published
      </div>
    </div>
  );
}
