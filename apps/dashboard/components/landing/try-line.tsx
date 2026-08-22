'use client';

// THE TRY-LINE — exa.ai's signature move (a working input in the hero flow),
// adapted to what we can offer honestly at $0 to an anonymous visitor.
//
// It LOOKS like an input because it is one — but the five suggestion chips
// are the routes we have real measurements for, and picking one replays the
// genuine decision (cluster, model, price, quality, receipt) from the
// committed frontier. Typing your own prompt gets the honest answer instead
// of a fake one: classification runs server-side with a key, so the CTA is
// "get a key and route it for real" — never a pretend result. No API call,
// no abuse surface, no invented output.
import { useState } from 'react';
import Link from 'next/link';
import { ROUTE_DEMO } from '@/lib/evidence';
import { cheapestCostFor, premiumCostFor } from '@/lib/economics';

function usd(n: number): string {
  return n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

export function TryLine({ embedded = false }: { embedded?: boolean }) {
  const [picked, setPicked] = useState<number | null>(null);
  const [custom, setCustom] = useState('');

  const d = picked !== null ? ROUTE_DEMO[picked]! : null;
  const premium = d ? premiumCostFor(d.cluster) : null;
  const cheapest = d ? cheapestCostFor(d.cluster) : null;
  const up =
    d !== null &&
    premium !== null &&
    cheapest !== null &&
    d.costPer1K >= premium * 0.98 &&
    premium > cheapest * 3;
  const saved = d && premium && !up ? Math.round((1 - d.costPer1K / premium) * 100) : null;
  const typedSomething = custom.trim().length > 8;

  const body = (
    <div className={embedded ? 'w-full max-w-3xl' : 'mx-auto max-w-3xl'}>
        {!embedded && (
          <div className="text-center font-mono text-xs uppercase tracking-[0.18em] text-faint">
            See a route happen
          </div>
        )}
        <div className={`rounded-xl border border-line bg-panel lift shadow-paper ${embedded ? 'px-5 py-4 shadow-[0_18px_50px_-12px_rgba(41,37,36,0.18)]' : 'mt-6 px-5 py-4'}`}>
          <input
            value={custom}
            onChange={(e) => {
              setCustom(e.target.value);
              setPicked(null);
            }}
            placeholder="Type a prompt — or pick one we've measured…"
            className="w-full bg-transparent text-[15px] text-ink placeholder:text-faint focus:outline-none"
          />
          <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3">
            {ROUTE_DEMO.map((r, i) => (
              <button
                key={i}
                onClick={() => {
                  setPicked(i);
                  setCustom('');
                }}
                className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                  picked === i
                    ? 'border-accent bg-accent-soft text-accent'
                    : 'border-line text-soft hover:border-faint hover:text-ink'
                }`}
              >
                {r.cluster}
              </button>
            ))}
          </div>
        </div>

        {/* the readout */}
        <div className="mt-4 min-h-[7rem]">
          {d && (
            <div className="rounded-xl border border-line bg-panel px-5 py-4">
              <p className="text-sm leading-snug text-ink">{d.prompt}</p>
              <p className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 font-mono text-xs">
                <span className="text-accent">→</span>
                <span className="rounded bg-accent-soft px-1.5 py-0.5 font-medium text-accent">
                  {d.cluster}
                </span>
                <span className="font-medium text-ink">{d.label}</span>
                <span className="text-soft">{usd(d.costPer1K)}/1k</span>
                <span className="text-faint">quality {d.quality.toFixed(2)} measured</span>
                {up ? (
                  <span className="text-warn">full price — nothing cheaper measures good enough</span>
                ) : saved !== null && saved > 0 ? (
                  <span className="text-accent">−{saved}% vs the premium option</span>
                ) : null}
              </p>
              <p className="mt-2 font-mono text-[11px] text-faint">
                a real decision from the measured frontier — not a simulation
              </p>
            </div>
          )}
          {!d && typedSomething && (
            <div className="rounded-xl border border-accent/25 bg-accent-soft/30 px-5 py-4">
              <p className="text-sm leading-relaxed text-ink">
                Routing <em>your</em> prompt takes a measurement pass we only run for real keys —
                we won&apos;t show you an invented answer.{' '}
                <Link href="/login" className="font-medium text-accent underline underline-offset-4">
                  Get a key
                </Link>{' '}
                and this exact prompt routes for real, receipt included.
              </p>
            </div>
          )}
        </div>
    </div>
  );

  if (embedded) return body;
  return <section className="mx-auto max-w-6xl px-6 py-24">{body}</section>;
}
