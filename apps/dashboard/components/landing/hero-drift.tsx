// THE DRIFT — exa's hero has loose columns of small artwork tiles floating
// down both edges of the first viewport. Ours are measurement artifacts
// instead of artwork: micro frontier charts, price fragments, interval
// notation — the things the product actually produces, at thumbnail scale.
// Every number is one the page already says (270×, the routed pick's price,
// the 0.95 floor); nothing here leaks inventory or identity.
//
// Decorative, so: aria-hidden, pointer-events-none, hidden below xl, and the
// float animation respects prefers-reduced-motion via the global setting.
import type { ReactNode } from 'react';

const FLOAT = 'animate-[heroFloat_11s_ease-in-out_infinite_alternate]';

function Tile({ children, delay, className = '' }: { children: ReactNode; delay: string; className?: string }) {
  return (
    <div
      className={`w-[8.5rem] rounded-lg border border-line bg-panel p-3 shadow-paper ${FLOAT} ${className}`}
      style={{ animationDelay: delay }}
    >
      {children}
    </div>
  );
}

function MiniFrontier() {
  return (
    <svg viewBox="0 0 100 56" className="w-full" aria-hidden>
      <path d="M6 46 L30 46 L30 30 L58 30 L58 12 L94 12" fill="none" stroke="#0f766e" strokeWidth="1.6" opacity="0.75" />
      {[[6, 46], [30, 30], [58, 12]].map(([x, y]) => (
        <circle key={`${x}`} cx={x} cy={y} r="2.6" fill="#0f766e" />
      ))}
      {[[20, 20], [44, 42], [70, 38], [84, 26]].map(([x, y]) => (
        <circle key={`${x}-${y}`} cx={x} cy={y} r="2" fill="#a8a29e" opacity="0.7" />
      ))}
    </svg>
  );
}

function MiniBars() {
  return (
    <svg viewBox="0 0 100 44" className="w-full" aria-hidden>
      {[
        { y: 4, w: 92, teal: false },
        { y: 16, w: 30, teal: false },
        { y: 28, w: 12, teal: false },
        { y: 40, w: 4, teal: true },
      ].map((b) => (
        <rect key={b.y} x="0" y={b.y - 3.5} width={b.w} height="7" rx="1.5" fill={b.teal ? '#0f766e' : '#d6d3d1'} />
      ))}
    </svg>
  );
}

export function HeroDrift() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-y-0 left-0 right-0 hidden xl:block">
      <div className="absolute inset-y-0 left-5 flex w-[8.5rem] flex-col justify-center gap-7 2xl:left-10">
        <Tile delay="0s" className="-ml-3">
          <MiniFrontier />
          <div className="mt-2 font-mono text-[9px] text-faint">the measured frontier</div>
        </Tile>
        <Tile delay="-4s" className="ml-4">
          <div className="font-mono text-2xl font-medium tracking-tight text-ink">270×</div>
          <div className="mt-1 font-mono text-[9px] text-faint">same work, price range</div>
        </Tile>
        <Tile delay="-8s" className="-ml-1">
          <div className="font-mono text-[10px] leading-relaxed text-soft">
            q 0.979 <span className="text-faint">± 0.021</span>
            <br />
            <span className="text-accent">floor ≥ 0.95 · holds</span>
          </div>
        </Tile>
      </div>
      <div className="absolute inset-y-0 right-5 flex w-[8.5rem] flex-col justify-center gap-7 2xl:right-10">
        <Tile delay="-2s" className="ml-2">
          <MiniBars />
          <div className="mt-2 font-mono text-[9px] text-faint">cost per 1k, five models</div>
        </Tile>
        <Tile delay="-6s" className="-ml-4">
          <div className="font-mono text-2xl font-medium tracking-tight text-accent">$0.0231</div>
          <div className="mt-1 font-mono text-[9px] text-faint">/1k · the routed pick</div>
        </Tile>
        <Tile delay="-9s" className="ml-1">
          <div className="font-mono text-[10px] leading-relaxed text-soft">
            receipt
            <br />
            <span className="text-faint">what served it, and why</span>
            <span aria-hidden className="mt-2 flex items-end">
              <span className="h-px w-8 bg-accent/70" />
              <span className="h-[6px] w-px bg-accent/70" />
            </span>
          </div>
        </Tile>
      </div>
    </div>
  );
}
