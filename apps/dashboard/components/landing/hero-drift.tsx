// THE MARGINS — small measurement artifacts at the edges of the first
// viewport. Each card is a complete statement on its own (a reader who looks
// at only one should still learn something true), they hold still, and they
// use the page's paper/ink palette with the one teal accent — no gradients,
// no motion. Every number is one the page already says (the code-generation
// table in the evidence band); nothing here leaks inventory or identity.
//
// Decorative, so: aria-hidden, pointer-events-none, hidden below xl.
import type { ReactNode } from 'react';

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="w-[9.5rem] rounded-lg border border-line bg-panel/90 p-3 shadow-paper">
      <div className="font-mono text-[9px] uppercase tracking-[0.14em] text-faint">{title}</div>
      <div className="mt-2">{children}</div>
    </div>
  );
}

// Five models on one coding task: quality (up) against price (right). The
// routed pick is the teal dot at the far left — nearly the top, a fraction of
// the price.
function QualityVsPrice() {
  const pts = [
    { x: 10, y: 16, pick: true },
    { x: 30, y: 15 },
    { x: 48, y: 13 },
    { x: 66, y: 12 },
    { x: 90, y: 10 },
  ];
  return (
    <svg viewBox="0 0 100 40" className="w-full" aria-hidden>
      <line x1="4" y1="34" x2="98" y2="34" stroke="#e7e5e4" strokeWidth="1" />
      <line x1="4" y1="4" x2="4" y2="34" stroke="#e7e5e4" strokeWidth="1" />
      <line x1="4" y1="18.5" x2="98" y2="18.5" stroke="#0f766e" strokeWidth="0.6" strokeDasharray="2 2" opacity="0.5" />
      {pts.map((p) => (
        <circle key={p.x} cx={p.x} cy={p.y} r={p.pick ? 3.4 : 2.3} fill={p.pick ? '#0f766e' : '#a8a29e'} />
      ))}
      <text x="98" y="39.5" textAnchor="end" fontSize="5.5" fill="#a8a29e" fontFamily="ui-monospace, monospace">cheap → expensive</text>
      <text x="6" y="24" fontSize="5" fill="#0f766e" fontFamily="ui-monospace, monospace">0.95 floor</text>
    </svg>
  );
}

// Cost per 1,000 requests, same five models, top to bottom. The teal bar is
// the one the 0.95 floor actually buys.
function CostBars() {
  const bars = [
    { w: 92, label: '$6.26' },
    { w: 9, label: '$0.55' },
    { w: 4.5, label: '$0.25' },
    { w: 3.5, label: '$0.19' },
    { w: 1.6, label: '$0.02', pick: true },
  ];
  return (
    <div className="space-y-1.5">
      {bars.map((b) => (
        <div key={b.label} className="flex items-center gap-1.5">
          <div className="h-2 flex-1 overflow-hidden rounded-sm bg-line/60">
            <div className={`h-full rounded-sm ${b.pick ? 'bg-accent' : 'bg-faint/50'}`} style={{ width: `${b.w}%` }} />
          </div>
          <span className={`w-9 text-right font-mono text-[8px] ${b.pick ? 'text-accent' : 'text-faint'}`}>{b.label}</span>
        </div>
      ))}
    </div>
  );
}

export function HeroDrift() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-y-0 left-0 right-0 hidden xl:block">
      <div className="absolute inset-y-0 left-5 flex w-[9.5rem] flex-col justify-center gap-5 2xl:left-10">
        <Card title="one coding task · 5 models">
          <QualityVsPrice />
          <p className="mt-1 text-[11.5px] leading-snug text-soft">Quality within two points. Price apart by 270×.</p>
        </Card>
        <Card title="the routed pick">
          <div className="font-mono text-xl font-medium tracking-tight text-ink">$0.0231</div>
          <p className="mt-1 text-[11.5px] leading-snug text-soft">per 1,000 requests, at 99% of the best scorer&apos;s quality.</p>
        </Card>
        <Card title="quality floor">
          <div className="font-mono text-[12px] text-ink">
            0.979 <span className="text-faint">± 0.021</span>
          </div>
          <p className="mt-1 text-[11.5px] leading-snug text-soft">
            Measured above the 0.95 floor, error bars included. <span className="text-accent">Holds.</span>
          </p>
        </Card>
      </div>
      <div className="absolute inset-y-0 right-5 flex w-[9.5rem] flex-col justify-center gap-5 2xl:right-10">
        <Card title="cost per 1,000 requests">
          <CostBars />
          <p className="mt-1.5 text-[11.5px] leading-snug text-soft">Same work, top to bottom. Teal is what the floor buys.</p>
        </Card>
        <Card title="how it is scored">
          <p className="text-[11.5px] leading-snug text-soft">
            Code is run, not judged. 30 tasks the models have never seen. Every point carries an interval.
          </p>
        </Card>
        <Card title="the receipt">
          <div className="font-mono text-[9px] leading-relaxed text-ink">
            cluster <span className="text-faint">code-gen</span>
            <br />
            strategy <span className="text-faint">220a2558</span>
            <br />
            cost <span className="text-faint">$0.0231 /1k</span>
          </div>
          <p className="mt-1 text-[11.5px] leading-snug text-soft">Every answer says what ran, and why.</p>
        </Card>
      </div>
    </div>
  );
}
