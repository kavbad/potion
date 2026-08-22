// A cascade, drawn. Server-rendered SVG, no client JS.
//
// The mechanism is the whole argument and it is easy to miss in prose: a
// cheap model answers, reports how sure it is, and only when that confidence
// falls below a measured threshold does the request escalate. Most traffic
// never reaches the expensive model at all — which is why a mixture can sit
// at the top of a quality range while costing a fraction of holding the
// strong model on every request.
export function MixDiagram() {
  const boxW = 132;
  const boxH = 46;
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-panel shadow-paper">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.16em] text-faint">
        <span aria-hidden className="inline-block h-2 w-2 rounded-full bg-accent/70" />
        a cascade · measured as one strategy
      </div>
      <div className="px-6 py-7">
      <svg viewBox="0 0 420 190" className="w-full" role="img"
        aria-label="A request answered by a cheap model, escalating to a strong model only when confidence is low">
        {/* request */}
        <text x="8" y="46" fontSize="11" fontFamily="monospace" fill="#a8a29e">request</text>
        <line x1="8" y1="56" x2="60" y2="56" stroke="#e7e2da" strokeWidth="1" />

        {/* cheap model */}
        <rect x="60" y="33" width={boxW} height={boxH} rx="7" fill="#ccfbf1" stroke="#5eead4" />
        <text x={60 + boxW / 2} y="52" textAnchor="middle" fontSize="12" fill="#292524">a cheap model</text>
        <text x={60 + boxW / 2} y="67" textAnchor="middle" fontSize="10" fontFamily="monospace" fill="#a8a29e">
          answers first
        </text>

        {/* confidence gate */}
        <line x1={60 + boxW} y1="56" x2="238" y2="56" stroke="#e7e2da" strokeWidth="1" />
        <circle cx="248" cy="56" r="10" fill="#0f766e" stroke="#0f766e" strokeWidth="1.2" />
        <text x="248" y="60" textAnchor="middle" fontSize="10" fontFamily="monospace" fill="#ffffff">?</text>
        <text x="248" y="30" textAnchor="middle" fontSize="10" fontFamily="monospace" fill="#a8a29e">
          sure enough?
        </text>

        {/* yes → done */}
        <line x1="258" y1="56" x2="330" y2="56" stroke="#14b8a6" strokeWidth="2" />
        <text x="294" y="47" textAnchor="middle" fontSize="10" fontFamily="monospace" fill="#0f766e">yes</text>
        <text x="336" y="60" fontSize="11" fill="#292524">done</text>

        {/* no → escalate */}
        <path d="M248 66 L248 116 L60 116 L60 133" fill="none" stroke="#a8a29e" strokeWidth="1" strokeDasharray="3 3" />
        <text x="262" y="94" fontSize="10" fontFamily="monospace" fill="#a8a29e">no</text>

        {/* strong model */}
        <rect x="60" y="133" width={boxW} height={boxH} rx="7" fill="#0f766e" stroke="#0f766e" />
        <text x={60 + boxW / 2} y="152" textAnchor="middle" fontSize="12" fill="#ffffff">a stronger model</text>
        <text x={60 + boxW / 2} y="167" textAnchor="middle" fontSize="10" fontFamily="monospace" fill="#99f6e4">
          only when needed
        </text>
        <line x1={60 + boxW} y1="156" x2="330" y2="156" stroke="#e7e2da" strokeWidth="1" />
        <text x="336" y="160" fontSize="11" fill="#292524">done</text>
      </svg>
      </div>
    </div>
  );
}
