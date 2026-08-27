'use client';

// THE LEDGER PRIMITIVES (redesign S1, brief v4). Three objects, used
// identically everywhere they appear:
//   Stamp        — held / attention / refused / pinned / live, slightly
//                  rotated like rubber on paper.
//   Prov         — a provenance number: dotted underline, hover shows the
//                  evidence card. Trust as an interaction, not a page.
//   ReceiptCard  — THE atomic object: perforated bottom edge, stamp,
//                  dashed rules, the kept-line in ledger green. `printing`
//                  plays the product's one moment of theater (globals.css;
//                  reduced-motion disables it).
import type { ReactNode } from 'react';
import type { Receipt } from '@/components/try-request';

export function Stamp({ kind, children }: { kind: 'held' | 'attention' | 'refused' | 'pinned' | 'live'; children?: ReactNode }) {
  const cls =
    kind === 'held'
      ? 'text-kept bg-kept-soft border-kept'
      : kind === 'refused'
        ? 'text-refuse bg-refuse-soft border-refuse -rotate-2'
        : kind === 'live'
          ? 'text-accent border-accent bg-transparent'
          : 'text-warn bg-amber-50 border-warn';
  return (
    <span className={`inline-block -rotate-1 border-[1.5px] px-2 py-0.5 font-mono text-[11.5px] font-semibold uppercase tracking-[0.1em] ${cls}`}>
      {children ?? kind}
    </span>
  );
}

export function Prov({ children, card }: { children: ReactNode; card: ReactNode }) {
  return (
    <span className="group relative cursor-help border-b-[1.5px] border-dotted border-accent">
      {children}
      <span className="pointer-events-none absolute left-0 top-full z-30 mt-2 w-72 -translate-y-1 border border-[#c4bfb2] bg-[#fbfaf7] px-3.5 py-3 font-mono text-[12px] leading-relaxed text-soft opacity-0 shadow-paper-lift transition-all duration-150 group-hover:pointer-events-auto group-hover:translate-y-0 group-hover:opacity-100 motion-reduce:transition-none">
        {card}
      </span>
    </span>
  );
}

/** The kept-line math, shared: premium counterfactual from the receipt's
 * quality-rule alternative — the same comparison every savings figure uses. */
export function keptOf(r: Receipt): { premium: { model: string; costPer1K: number } | null; savedPct: number | null } {
  const premium = r.alternatives.find((a) => a.rule === 'quality');
  if (!premium || premium.cost_per_1k === null || premium.model === null || r.costPer1K === null || premium.cost_per_1k <= 0) {
    return { premium: null, savedPct: null };
  }
  return {
    premium: { model: premium.model, costPer1K: premium.cost_per_1k },
    savedPct: Math.max(0, Math.floor((1 - r.costPer1K / premium.cost_per_1k) * 100)),
  };
}

const usd = (n: number): string => (n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

export function ReceiptCard({ r, subtitle, printing = false }: { r: Receipt; subtitle?: string; printing?: boolean }) {
  const { premium, savedPct } = keptOf(r);
  const perforation = {
    WebkitMask:
      'linear-gradient(#000 0 0) top/100% calc(100% - 9px) no-repeat, radial-gradient(circle at 8px 100%, transparent 6px, #000 6.5px) bottom left/16px 9px repeat-x',
    mask:
      'linear-gradient(#000 0 0) top/100% calc(100% - 9px) no-repeat, radial-gradient(circle at 8px 100%, transparent 6px, #000 6.5px) bottom left/16px 9px repeat-x',
  } as const;
  return (
    <div className="overflow-hidden">
      <div
        className={`relative w-full max-w-[400px] border border-[#c4bfb2] bg-[#fbfaf7] px-5 pb-6 pt-4 font-mono text-xs shadow-paper ${printing ? 'receipt-printing' : ''}`}
        style={perforation}
      >
        <span className="absolute right-3.5 top-3"><Stamp kind="held" /></span>
        <div className="border-b border-dashed border-[#c4bfb2] pb-2.5 text-center">
          <div className="text-[12px] font-semibold tracking-[0.14em] text-ink">POTION · RECEIPT</div>
          <div className="mt-0.5 text-[11.5px] text-faint">{subtitle ?? 'routed under your rule'}</div>
        </div>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3.5 gap-y-1">
          <dt className="text-faint">kind of work</dt>
          <dd className="text-right text-ink">{r.clusterId ?? '—'}</dd>
          <dt className="text-faint">served by</dt>
          <dd className="break-all text-right text-ink">{r.model ?? '—'}{r.strategyHash ? <span className="text-faint"> · {r.strategyHash.slice(0, 8)}</span> : null}</dd>
          {r.alternatives.length > 0 && (
            <>
              <dt className="text-faint">qualified above your bar</dt>
              <dd className="text-right text-ink">{r.alternatives.length} alternative{r.alternatives.length === 1 ? '' : 's'}</dd>
            </>
          )}
          <dt className="text-faint">why this one</dt>
          <dd className="text-right text-ink">{r.rule === 'policy' ? 'cheapest under your rule' : `optimize for ${r.rule}`}</dd>
          <dt className="text-faint">evidence</dt>
          <dd className="text-right text-ink">
            {r.quality !== null ? `scores ${r.quality.toFixed(2)}` : '—'}
            {r.floor !== null ? ` · floor ${r.floor.toFixed(2)}` : ''}
            {r.provenance ? <span className={r.provenance === 'live' ? ' text-kept' : ' text-warn'}> · {r.provenance}</span> : null}
          </dd>
        </dl>
        <div className="my-2.5 border-t border-dashed border-[#c4bfb2]" />
        <dl className="grid grid-cols-[auto_1fr] gap-x-3.5 gap-y-1">
          <dt className="text-faint">this request</dt>
          <dd className="text-right text-ink">{r.costUsd !== null ? `$${r.costUsd.toFixed(5)}` : '—'}{r.latencyMs !== null ? ` · ${Math.round(r.latencyMs)} ms` : ''}</dd>
          {premium && (
            <>
              <dt className="text-faint">the premium pick would be</dt>
              <dd className="text-right text-soft">{usd(premium.costPer1K)} per 1k</dd>
            </>
          )}
        </dl>
        {savedPct !== null && savedPct > 0 && (
          <>
            <div className="my-2.5 border-t border-dashed border-[#c4bfb2]" />
            <div className="flex items-baseline justify-between text-[13px] font-semibold text-kept">
              <span>KEPT</span>
              <span>{savedPct}% on this kind of work</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
