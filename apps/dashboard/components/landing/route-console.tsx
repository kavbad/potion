'use client';

// THE ROUTE CONSOLE — exa's hero demo, emulated whole rather than borrowed
// from. Their first page is not a headline with decoration: it is the product
// RUNNING — a filled query, a controls rail, and a results table visibly
// enriching row by row. This is that composition, driven by our data:
//
//   · the "query" is a real measured prompt, cycling as the table streams
//   · the results table replays the five ROUTE_DEMO decisions — every
//     cluster, model, price and quality is a committed frontier point,
//     shimmering in exa-style but never invented
//   · where exa puts EFFORT/OUTPUT controls, we put THE RECEIPT for the
//     highlighted row — the product's actual signature — because a control
//     that does nothing would be staged, and this page does not stage
//   · typing your own prompt interrupts the reel and gets the honest CTA:
//     real routing needs a key; we never show a pretend result
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ROUTE_DEMO } from '@/lib/evidence';
import { premiumCostFor } from '@/lib/economics';

function usd(n: number): string {
  return n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

const STEP_MS = 1150;
const HOLD_MS = 3600;

export function RouteConsole() {
  const [revealed, setRevealed] = useState(1);
  const [selected, setSelected] = useState<number | null>(null);
  const [typed, setTyped] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const interrupted = typed.length > 0 || selected !== null;

  useEffect(() => {
    if (interrupted) return;
    timer.current = setTimeout(
      () => setRevealed((r) => (r >= ROUTE_DEMO.length ? 1 : r + 1)),
      revealed >= ROUTE_DEMO.length ? HOLD_MS : STEP_MS,
    );
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [revealed, interrupted]);

  const activeIdx = selected ?? revealed - 1;
  const d = typed.length > 0 ? null : ROUTE_DEMO[activeIdx]!;
  const premium = d ? premiumCostFor(d.cluster) : null;
  const savedPct =
    d && premium && d.costPer1K < premium * 0.98 ? Math.floor((1 - d.costPer1K / premium) * 100) : null;
  const typedSomething = typed.trim().length > 8;

  return (
    <div className="w-full rounded-2xl border border-line bg-panel shadow-paper lift shadow-[0_24px_70px_-18px_rgba(41,37,36,0.22)]">
      {/* ---- the query row ---- */}
      <div className="flex items-center gap-3 border-b border-line px-5 py-4">
        <input
          value={typed.length > 0 ? typed : d ? d.prompt : typed}
          onChange={(e) => {
            setTyped(e.target.value);
            setSelected(null);
          }}
          spellCheck={false}
          aria-label="Try a prompt"
          className="min-w-0 flex-1 bg-transparent text-[15px] text-ink placeholder:text-faint focus:outline-none"
        />
        {typed.length > 0 && (
          <button
            onClick={() => setTyped('')}
            aria-label="Clear"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-faint transition-colors hover:bg-line/50 hover:text-ink"
          >
            ×
          </button>
        )}
        <Link
          href="/login"
          aria-label="Route it for real"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-ink text-white transition-opacity hover:opacity-85"
        >
          ↑
        </Link>
      </div>

      <div className="grid lg:grid-cols-[15rem_1fr]">
        {/* ---- the receipt rail (exa's controls column, honest version) ---- */}
        <div className="flex flex-col border-b border-line px-5 py-5 text-left lg:border-b-0 lg:border-r">
          <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-faint">receipt</div>
          {d ? (
            <dl className="mt-4 space-y-3.5 font-mono text-xs">
              <div>
                <dt className="text-[10px] uppercase tracking-wide text-faint">kind of work</dt>
                <dd className="mt-1 inline-block rounded bg-accent-soft px-1.5 py-0.5 font-medium text-accent">
                  {d.cluster}
                </dd>
              </div>
              <div>
                <dt className="text-[10px] uppercase tracking-wide text-faint">routed to</dt>
                <dd className="mt-1 font-medium text-ink">{d.label}</dd>
              </div>
              <div>
                <dt className="text-[10px] uppercase tracking-wide text-faint">price · quality</dt>
                <dd className="mt-1 text-soft">
                  {usd(d.costPer1K)}/1k · q {d.quality.toFixed(2)}{' '}
                  {savedPct !== null ? (
                    <span className="text-accent">−{savedPct}%</span>
                  ) : (
                    <span className="text-warn">full price</span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-[10px] uppercase tracking-wide text-faint">why</dt>
                <dd className="mt-1 leading-relaxed text-soft">{d.note}</dd>
              </div>
            </dl>
          ) : (
            <p className="mt-4 font-mono text-xs leading-relaxed text-soft">
              your prompt routes for real with a key — receipt included, never simulated
            </p>
          )}
          <div className="mt-auto flex items-center gap-2 pt-6">
            <Link
              href="/docs"
              className="rounded-md bg-paper px-3 py-1.5 font-mono text-[11px] text-soft ring-1 ring-line transition-colors hover:bg-line/40 hover:text-ink"
            >
              Docs ↗
            </Link>
            <Link
              href="/docs"
              className="rounded-md bg-paper px-3 py-1.5 font-mono text-[11px] text-soft ring-1 ring-line transition-colors hover:bg-line/40 hover:text-ink"
            >
              {'</>'}
            </Link>
          </div>
        </div>

        {/* ---- the results field ---- */}
        <div className="px-5 py-5">
          {typedSomething ? (
            <div className="flex h-full min-h-[15rem] items-center rounded-lg border border-accent/25 bg-accent-soft/30 px-6 py-5">
              <p className="text-left text-sm leading-relaxed text-ink">
                Routing <em>your</em> prompt takes a measurement pass we only run for real keys —
                we won&apos;t show you an invented answer.{' '}
                <Link href="/login" className="font-medium text-accent underline underline-offset-4">
                  Get a key
                </Link>{' '}
                and this exact prompt routes for real, receipt included.
              </p>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 font-mono text-[11px] text-faint">
                <span
                  aria-hidden
                  className="inline-block h-3 w-3 animate-spin rounded-full border border-faint border-t-accent"
                />
                routing {ROUTE_DEMO.length} measured requests…
              </div>
              <div className="mt-3 overflow-x-auto">
                <div className="min-w-[34rem]">
                  <div className="grid grid-cols-[minmax(0,1fr)_7.5rem_6.5rem_4.5rem] gap-x-4 border-b border-line pb-2 text-left font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
                    <span>request</span>
                    <span>routed to</span>
                    <span>price/1k</span>
                    <span>quality</span>
                  </div>
                  {ROUTE_DEMO.map((r, i) => {
                    const shown = typed.length === 0 && i < revealed;
                    const isActive = shown && i === activeIdx;
                    return (
                      <button
                        key={i}
                        onClick={() => shown && setSelected(i)}
                        disabled={!shown}
                        className={`grid w-full grid-cols-[minmax(0,1fr)_7.5rem_6.5rem_4.5rem] items-center gap-x-4 border-b border-line/60 py-2.5 text-left transition-colors ${
                          isActive ? 'bg-accent-soft/25' : shown ? 'hover:bg-paper' : ''
                        }`}
                      >
                        {shown ? (
                          <>
                            <span className="truncate text-[13px] text-ink">{r.prompt}</span>
                            <span className="font-mono text-xs font-medium text-ink">{r.label}</span>
                            <span className="font-mono text-xs text-soft">{usd(r.costPer1K)}</span>
                            <span className="font-mono text-xs text-soft">{r.quality.toFixed(2)}</span>
                          </>
                        ) : (
                          <>
                            <span className="h-3.5 w-4/5 animate-pulse rounded-sm bg-line/70" />
                            <span className="h-3.5 w-16 animate-pulse rounded-sm bg-line/70" />
                            <span className="h-3.5 w-12 animate-pulse rounded-sm bg-line/70" />
                            <span className="h-3.5 w-9 animate-pulse rounded-sm bg-line/70" />
                          </>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
              <p className="mt-3 text-left font-mono text-[11px] text-faint">
                six real decisions from the measured frontier — not a simulation · click a row for
                its receipt
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
