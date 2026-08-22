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

const ART = [
  'linear-gradient(135deg, #042f2e 0%, #0f766e 55%, #2dd4bf 100%)',
  'linear-gradient(160deg, #0f766e 0%, #14b8a6 50%, #99f6e4 100%)',
  'linear-gradient(200deg, #134e4a 0%, #0d9488 60%, #5eead4 100%)',
  'linear-gradient(120deg, #2dd4bf 0%, #0f766e 60%, #042f2e 100%)',
  'linear-gradient(145deg, #5eead4 0%, #14b8a6 45%, #115e59 100%)',
  'linear-gradient(175deg, #0d9488 0%, #042f2e 100%)',
];

function Tile({ children, delay, art, className = '' }: { children: ReactNode; delay: string; art: number; className?: string }) {
  return (
    <div
      className={`w-[8.5rem] overflow-hidden rounded-lg p-3 text-white shadow-[0_12px_30px_-10px_rgba(15,118,110,0.45)] ${FLOAT} ${className}`}
      style={{ animationDelay: delay, backgroundImage: ART[art % ART.length] }}
    >
      {children}
    </div>
  );
}

function MiniFrontier() {
  return (
    <svg viewBox="0 0 100 56" className="w-full" aria-hidden>
      <path d="M6 46 L30 46 L30 30 L58 30 L58 12 L94 12" fill="none" stroke="#ffffff" strokeWidth="1.6" opacity="0.85" />
      {[[6, 46], [30, 30], [58, 12]].map(([x, y]) => (
        <circle key={`${x}`} cx={x} cy={y} r="2.6" fill="#ffffff" />
      ))}
      {[[20, 20], [44, 42], [70, 38], [84, 26]].map(([x, y]) => (
        <circle key={`${x}-${y}`} cx={x} cy={y} r="2" fill="#ffffff" opacity="0.45" />
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
        <rect key={b.y} x="0" y={b.y - 3.5} width={b.w} height="7" rx="1.5" fill={b.teal ? '#ffffff' : 'rgba(255,255,255,0.35)'} />
      ))}
    </svg>
  );
}

export function HeroDrift() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-y-0 left-0 right-0 hidden xl:block">
      <div className="absolute inset-y-0 left-5 flex w-[8.5rem] flex-col justify-center gap-7 2xl:left-10">
        <Tile delay="0s" art={0} className="-ml-3">
          <MiniFrontier />
          <div className="mt-2 font-mono text-[9px] text-white/80">the measured frontier</div>
        </Tile>
        <Tile delay="-4s" art={1} className="ml-4">
          <div className="font-mono text-2xl font-medium tracking-tight text-white">270×</div>
          <div className="mt-1 font-mono text-[9px] text-white/80">same work, price range</div>
        </Tile>
        <Tile delay="-8s" art={2} className="-ml-1">
          <div className="font-mono text-[10px] leading-relaxed text-white">
            q 0.979 <span className="text-white/70">± 0.021</span>
            <br />
            <span className="text-[#99f6e4]">floor ≥ 0.95 · holds</span>
          </div>
        </Tile>
      </div>
      <div className="absolute inset-y-0 right-5 flex w-[8.5rem] flex-col justify-center gap-7 2xl:right-10">
        <Tile delay="-2s" art={3} className="ml-2">
          <MiniBars />
          <div className="mt-2 font-mono text-[9px] text-white/80">cost per 1k, five models</div>
        </Tile>
        <Tile delay="-6s" art={4} className="-ml-4">
          <div className="font-mono text-2xl font-medium tracking-tight text-white">$0.0231</div>
          <div className="mt-1 font-mono text-[9px] text-white/80">/1k · the routed pick</div>
        </Tile>
        <Tile delay="-9s" art={5} className="ml-1">
          <div className="font-mono text-[10px] leading-relaxed text-white">
            receipt
            <br />
            <span className="text-white/70">what served it, and why</span>
            <span aria-hidden className="mt-2 flex items-end">
              <span className="h-px w-8 bg-white/80" />
              <span className="h-[6px] w-px bg-white/80" />
            </span>
          </div>
        </Tile>
      </div>
    </div>
  );
}
