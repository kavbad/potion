// Figure 4 — the research loop, drawn as a figure. What runs every week
// without a person in it: measure → replay → audition → publish → route →
// (receipts feed back). Says what the machine does, never how a particular
// combination is built: no mechanism names, no thresholds, no components.
const INK = '#1c1a17';
const RULE = '#b8b3a6';
const FAINT = '#8a857a';
const ACCENT = '#0f766e';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

export function ResearchLoop() {
  // Four stages on the corners of a square, the product in the middle, the
  // loop drawn clockwise, receipts feeding back to the first measurement.
  const B = { w: 156, h: 46 };
  const TL = { x: 24, y: 44 }, TR = { x: 300, y: 44 }, BR = { x: 300, y: 250 }, BL = { x: 24, y: 250 };
  const box = (p: { x: number; y: number }, title: string, sub: string) => (
    <g>
      <rect x={p.x} y={p.y} width={B.w} height={B.h} fill="none" stroke={INK} strokeWidth="1" />
      <text x={p.x + B.w / 2} y={p.y + 20} textAnchor="middle" fontSize="12" fill={INK} fontFamily="inherit">{title}</text>
      <text x={p.x + B.w / 2} y={p.y + 35} textAnchor="middle" fontSize="6.5" fill={FAINT} letterSpacing="0.05em">{sub}</text>
    </g>
  );
  return (
    <div className="bg-[#fbfaf7]">
      <div className="border-b border-[#d9d5cb] px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.16em] text-faint">
        the research loop · runs weekly · no one in it
      </div>
      <div className="px-5 py-6 sm:px-7">
        <svg viewBox="0 0 480 372" className="w-full" role="img" fontFamily={MONO}
          aria-label="Potion's weekly research loop: measure, replay, audition, publish, route; receipts feed the next measurement">
          <defs>
            <marker id="rl" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0 0.5 L7 4 L0 7.5" fill="none" stroke={INK} strokeWidth="1" />
            </marker>
            <marker id="rlA" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0 0.5 L7 4 L0 7.5" fill="none" stroke={ACCENT} strokeWidth="1" />
            </marker>
          </defs>

          {box(TL, 'measure', 'EVERY MODEL · EVERY KIND OF WORK')}
          {box(TR, 'replay', 'COMBINATIONS · FROM STORED RESULTS')}
          {box(BR, 'audition', 'NEW MODELS · THE WEEK THEY SHIP')}
          {box(BL, 'publish', 'ONLY WHAT DOMINATES')}

          {/* clockwise */}
          <line x1={TL.x + B.w} y1={TL.y + 23} x2={TR.x - 8} y2={TR.y + 23} stroke={INK} strokeWidth="1" markerEnd="url(#rl)" />
          <line x1={TR.x + B.w / 2} y1={TR.y + B.h} x2={BR.x + B.w / 2} y2={BR.y - 8} stroke={INK} strokeWidth="1" markerEnd="url(#rl)" />
          <line x1={BR.x} y1={BR.y + 23} x2={BL.x + B.w + 8} y2={BL.y + 23} stroke={INK} strokeWidth="1" markerEnd="url(#rl)" />
          <text x="240" y={BR.y + 17} textAnchor="middle" fontSize="7" fill={FAINT} letterSpacing="0.06em">EARNED A SLOT?</text>

          {/* publish → route (the product), centre */}
          <rect x="162" y="124" width="156" height="46" fill={ACCENT} stroke={ACCENT} />
          <text x="240" y="144" textAnchor="middle" fontSize="12" fill="#fbfaf7" fontFamily="inherit">route</text>
          <text x="240" y="159" textAnchor="middle" fontSize="6.5" fill="#ccfbf1" letterSpacing="0.05em">YOUR TRAFFIC · WITH RECEIPTS</text>
          <path d={`M ${BL.x + B.w / 2} ${BL.y} L ${BL.x + B.w / 2} 147 L 154 147`} fill="none" stroke={ACCENT} strokeWidth="1.25" markerEnd="url(#rlA)" />
          <text x={BL.x + B.w / 2 + 6} y="212" fontSize="7" fill={ACCENT} letterSpacing="0.06em">THE FRONTIER</text>

          {/* receipts feed the next measurement */}
          <path d={`M 240 124 L 240 ${TL.y + B.h + 8}`} fill="none" stroke={INK} strokeWidth="1" strokeDasharray="3 3" />
          <path d={`M 240 ${TL.y + B.h + 8} L ${TL.x + B.w / 2} ${TL.y + B.h + 8} L ${TL.x + B.w / 2} ${TL.y + B.h + 8}`} fill="none" stroke={INK} strokeWidth="1" strokeDasharray="3 3" markerEnd="url(#rl)" />
          <text x="246" y="112" fontSize="7" fill={FAINT} letterSpacing="0.06em">RECEIPTS → NEXT WEEK</text>

          {/* what compounds */}
          <line x1="24" y1="326" x2="456" y2="326" stroke={RULE} strokeWidth="1" />
          <text x="24" y="344" fontSize="7.5" fill={FAINT} letterSpacing="0.06em">WHAT COMPOUNDS · ITEM-LEVEL RESULTS, EVERY MODEL AND COMBINATION, WEEKLY, WITH INTERVALS</text>
          <text x="24" y="358" fontSize="7.5" fill={FAINT} letterSpacing="0.06em">A COMBINATION IS ONE HASH · WHAT IT IS MADE OF IS NOT PUBLISHED</text>
        </svg>
      </div>
    </div>
  );
}
