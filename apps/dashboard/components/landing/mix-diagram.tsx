// Figure 4 — a cascade, drawn as a figure rather than a UI.
//
// One stroke weight, an 8-unit grid, orthogonal routing, hairline nodes,
// labels in small mono caps set off their lines with leaders that never
// touch data. The only colour is the path most requests take. Server-
// rendered SVG, no client JS.
//
// The mechanism is the whole argument and it is easy to miss in prose: a
// cheap model answers and reports how sure it is; only when that confidence
// falls below a measured threshold does the request escalate. Most traffic
// never reaches the expensive model, which is why a mixture can sit at the
// top of a quality range while costing a fraction of the strong model.
const INK = '#1c1a17';
const RULE = '#b8b3a6';
const FAINT = '#8a857a';
const ACCENT = '#0f766e';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

export function MixDiagram() {
  return (
    <div className="bg-[#fbfaf7]">
      <div className="border-b border-[#d9d5cb] px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.16em] text-faint">
        a cascade · one strategy · measured as a unit
      </div>
      <div className="px-5 py-6 sm:px-7">
        <svg
          viewBox="0 0 480 232"
          className="w-full"
          role="img"
          aria-label="A request answered by a cheap model, escalating to a strong model only when its confidence is below a measured threshold"
          fontFamily={MONO}
        >
          <defs>
            <marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0 0.5 L7 4 L0 7.5" fill="none" stroke={INK} strokeWidth="1" />
            </marker>
            <marker id="arrA" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0 0.5 L7 4 L0 7.5" fill="none" stroke={ACCENT} strokeWidth="1" />
            </marker>
          </defs>

          {/* entry */}
          <text x="16" y="74" fontSize="9.5" fill={FAINT} letterSpacing="0.12em">REQUEST</text>
          <line x1="16" y1="80" x2="80" y2="80" stroke={INK} strokeWidth="1" markerEnd="url(#arr)" />

          {/* node A: cheap model */}
          <rect x="88" y="58" width="176" height="44" fill="none" stroke={INK} strokeWidth="1" />
          <text x="176" y="77" textAnchor="middle" fontSize="12" fill={INK} fontFamily="inherit">cheap model</text>
          <text x="176" y="92" textAnchor="middle" fontSize="8" fill={FAINT} letterSpacing="0.06em">ANSWERS · REPORTS CONFIDENCE c</text>

          {/* A → gate */}
          <line x1="264" y1="80" x2="300" y2="80" stroke={INK} strokeWidth="1" />

          {/* gate: a diamond */}
          <path d="M320 62 L340 80 L320 98 L300 80 Z" fill="#fbfaf7" stroke={INK} strokeWidth="1" />
          <text x="320" y="83.5" textAnchor="middle" fontSize="9" fill={INK}>c ≥ t</text>
          <line x1="320" y1="62" x2="320" y2="44" stroke={RULE} strokeWidth="1" />
          <text x="320" y="38" textAnchor="middle" fontSize="8.5" fill={FAINT} letterSpacing="0.08em">CONFIDENT ENOUGH? (t IS MEASURED)</text>

          {/* yes → answer: the common path, in the accent */}
          <line x1="340" y1="80" x2="412" y2="80" stroke={ACCENT} strokeWidth="1.25" markerEnd="url(#arrA)" />
          <text x="376" y="71" textAnchor="middle" fontSize="8.5" fill={ACCENT} letterSpacing="0.08em">YES · MOST</text>
          <text x="422" y="84" fontSize="11" fill={INK} fontFamily="inherit">answer</text>

          {/* no → escalate: straight down into the second node */}
          <path d="M320 98 L320 132 L176 132 L176 156" fill="none" stroke={INK} strokeWidth="1" markerEnd="url(#arr)" />
          <text x="328" y="118" fontSize="8.5" fill={FAINT} letterSpacing="0.08em">NO · THE REST</text>

          {/* node B: stronger model */}
          <rect x="88" y="158" width="176" height="44" fill="none" stroke={INK} strokeWidth="1" />
          <text x="176" y="177" textAnchor="middle" fontSize="12" fill={INK} fontFamily="inherit">stronger model</text>
          <text x="176" y="192" textAnchor="middle" fontSize="8.5" fill={FAINT} letterSpacing="0.08em">ONLY WHEN NEEDED</text>

          {/* B → answer */}
          <line x1="264" y1="180" x2="412" y2="180" stroke={INK} strokeWidth="1" markerEnd="url(#arr)" />
          <text x="422" y="184" fontSize="11" fill={INK} fontFamily="inherit">answer</text>

          {/* footnote rule */}
          <line x1="16" y1="226" x2="464" y2="226" stroke={RULE} strokeWidth="1" />
        </svg>
        <div className="mt-3 grid gap-1 font-mono text-[10px] leading-relaxed text-faint sm:grid-cols-3">
          <div><span className="text-ink">t</span> · the threshold, chosen by measurement per kind of work</div>
          <div><span className="text-ink">c</span> · the cheap model&apos;s reported confidence on this request</div>
          <div><span className="text-ink">one hash</span> · the whole cascade is measured, priced and served as a unit</div>
        </div>
      </div>
    </div>
  );
}
