'use client';

// "Your frontier is forming" (operator, 2026-08-24) — the learning period's
// progress, visible OUTSIDE onboarding step 02. One line per kind of work
// seen in the org's traffic, each in exactly one honest state:
//   forming    n of 8 requests collected (progress bar)
//   measuring  enough collected; the side-by-side run is due or in flight
//   proposed   measured — the proposal awaits the button on Home
//   set        the bar is applied and live
// Reads GET /api/learning (same source as the onboarding card). Renders
// nothing while sampling is off or before the first sample: silence, not a
// nag — onboarding step 02 owns the pitch.
import { useEffect, useState } from 'react';
import Link from 'next/link';

interface Proposal {
  clusterId: string;
  incumbentQuality: number;
  suggestedFloor: number;
  projectedSaving: number | null;
  status: string;
}
interface LearningState {
  samplingConsent: boolean;
  samples: Record<string, number>;
  proposals: Proposal[];
}

export function FrontierStatus() {
  const [state, setState] = useState<LearningState | null>(null);
  useEffect(() => {
    fetch('/api/learning', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: LearningState | null) => setState(b))
      .catch(() => setState(null));
  }, []);

  if (!state || !state.samplingConsent) return null;
  const clusters = Object.keys(state.samples).sort();
  if (clusters.length === 0) return null;

  const byCluster = new Map<string, Proposal>();
  for (const p of state.proposals.filter(Boolean)) {
    const prev = byCluster.get(p.clusterId);
    // an applied bar outranks an open proposal for display
    if (!prev || (prev.status !== 'applied' && p.status === 'applied')) byCluster.set(p.clusterId, p);
  }

  return (
    <section className="mb-8 border border-[#d9d5cb] bg-[#fbfaf7] px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-mono text-[11.5px] uppercase tracking-[0.13em] text-faint">
          Your frontier, per kind of work
        </span>
        <span className="font-mono text-[12px] text-faint">measured on your own requests</span>
      </div>
      <ul className="mt-3 space-y-2">
        {clusters.map((c) => {
          const n = state.samples[c] ?? 0;
          const p = byCluster.get(c);
          return (
            <li key={c} className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]">
              <span className="w-40 shrink-0 font-mono text-soft">{c}</span>
              {p?.status === 'applied' ? (
                <span className="text-ink">
                  your bar is set at {p.suggestedFloor.toFixed(2)}
                  {p.projectedSaving !== null && p.projectedSaving > 0 ? (
                    <span className="text-accent"> · saving {Math.round(p.projectedSaving * 100)}%</span>
                  ) : null}
                </span>
              ) : p?.status === 'proposed' ? (
                <span className="text-ink">
                  measured — your model scores {p.incumbentQuality.toFixed(2)} here.{' '}
                  <Link href="/" className="text-accent underline">Review the proposal</Link>
                </span>
              ) : n >= 8 ? (
                <span className="text-soft">measuring — your model vs Potion&rsquo;s pick, on your own prompts</span>
              ) : (
                <span className="flex items-center gap-3 text-soft">
                  <span className="relative h-1.5 w-24 overflow-hidden rounded-full bg-[#e8e5db]">
                    <span className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${(n / 8) * 100}%` }} />
                  </span>
                  forming — {n} of 8 requests collected
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
