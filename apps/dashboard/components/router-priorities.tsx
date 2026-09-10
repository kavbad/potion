'use client';

// O2 — ADJUST PRIORITIES (the ideal-journey doctrine, 2026-08-27): the user
// learns the frontier by playing with OUTCOMES, never by configuring
// models. Move the quality floor; the composition, cost, and quality
// respond — every preview answered by the SERVE PATH'S own functions
// through /api/router/whatif (pure, mints nothing). Applying goes through
// POST /api/policies with rebindKeys, which recompiles the real plan as
// a new version with the change written on it.
//
// The asymmetry holds by shape: there is no model picker here. You state
// what you want; Potion recompiles.
import { useCallback, useEffect, useRef, useState } from 'react';
import { priceVsBaseline } from '@/lib/price-words';
import type { Policy } from '@potion/core';

interface WhatIfAssignment {
  clusterId: string;
  label: string;
  quality: number | null;
  costPer1K: number | null;
  latencyP95: number | null;
  fallback: string | null;
}

interface WhatIfResponse {
  description: string;
  assignments: WhatIfAssignment[];
  expected: { quality: number; costPer1K: number; baselineCostPer1K: number; baselineQuality?: number; savingsPct: number } | null;
}

interface CurrentAssignment {
  clusterId: string;
  strategy: { label: string };
  quality: number | null;
  costPer1K: number | null;
}

const CARD = 'border border-[#d9d5cb] bg-[#fbfaf7]';
const CEILING_STOPS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10];

function intentOf(p: Policy | null): 'floor' | 'ceiling' {
  return p?.type === 'max_quality' ? 'ceiling' : 'floor';
}

export function RouterPriorities({
  currentPolicy,
  currentAssignments,
  currentExpected,
  role,
}: {
  currentPolicy: Policy | null;
  currentAssignments: CurrentAssignment[];
  currentExpected: { quality: number; costPer1K: number } | null;
  role: 'admin' | 'member' | 'viewer';
}) {
  const [intent, setIntent] = useState<'floor' | 'ceiling'>(intentOf(currentPolicy));
  const [floor, setFloor] = useState(() =>
    currentPolicy && (currentPolicy.type === 'min_cost' || currentPolicy.type === 'compound')
      ? Math.round(currentPolicy.qualityFloor * 100)
      : 90,
  );
  const [latencyOn, setLatencyOn] = useState(currentPolicy?.type === 'compound' || currentPolicy?.type === 'latency_bound');
  const [p95, setP95] = useState(() =>
    currentPolicy && (currentPolicy.type === 'compound' || currentPolicy.type === 'latency_bound')
      ? currentPolicy.p95Ms
      : 2000,
  );
  const [ceilingIdx, setCeilingIdx] = useState(() => {
    const c = currentPolicy?.type === 'max_quality' ? currentPolicy.costCeilingPer1K : 1;
    const i = CEILING_STOPS.findIndex((s) => s >= c);
    return i === -1 ? CEILING_STOPS.length - 1 : i;
  });
  const [preview, setPreview] = useState<WhatIfResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const epoch = useRef(0);

  const candidate: Policy =
    intent === 'ceiling'
      ? { type: 'max_quality', costCeilingPer1K: CEILING_STOPS[ceilingIdx]! }
      : latencyOn
        ? { type: 'compound', qualityFloor: floor / 100, p95Ms: p95 }
        : { type: 'min_cost', qualityFloor: floor / 100 };
  const candidateJson = JSON.stringify({ policy: candidate });

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    const mine = ++epoch.current;
    setBusy(true);
    debounce.current = setTimeout(() => {
      fetch('/api/router/whatif', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: candidateJson,
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((b) => {
          if (epoch.current !== mine) return;
          setBusy(false);
          if (b) setPreview(b as WhatIfResponse);
        })
        .catch(() => { if (epoch.current === mine) setBusy(false); });
    }, 250);
    return () => { if (debounce.current) clearTimeout(debounce.current); };
    // deps: candidateJson is the whole candidate — deliberate.
  }, [candidateJson]);

  const apply = useCallback(async () => {
    setApplying(true);
    setError(null);
    try {
      const res = await fetch('/api/policies', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ policy: candidate, rebindKeys: true, name: 'priorities' }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(b?.error?.message ?? `apply failed (${res.status})`);
        return;
      }
      // The real plan recompiles on the next read — reload so the page
      // shows the new version with "your rule changed" written on it.
      window.location.reload();
    } finally {
      setApplying(false);
    }
  }, [candidate]);

  // Changes vs the CURRENT plan, per kind of work.
  const changed = (preview?.assignments ?? []).filter((a) => {
    const cur = currentAssignments.find((c) => c.clusterId === a.clusterId);
    return cur !== undefined && cur.strategy.label !== a.label;
  });
  const costDelta =
    preview?.expected && currentExpected && currentExpected.costPer1K > 0
      ? (preview.expected.costPer1K - currentExpected.costPer1K) / currentExpected.costPer1K
      : null;
  const qualityDelta =
    preview?.expected && currentExpected ? preview.expected.quality - currentExpected.quality : null;

  const sliderCls = 'w-full accent-[#0f766e]';
  const labelCls = 'font-mono text-[11.5px] uppercase tracking-[0.12em] text-faint';

  return (
    <section className={`${CARD} px-6 py-5`} data-testid="router-priorities">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-mono text-[12px] uppercase tracking-[0.13em] text-soft">Adjust priorities</span>
        <span className="font-mono text-[11.5px] text-faint">steer by outcome — Potion picks the models</span>
      </div>

      {/* intent */}
      <div className="mt-3 flex gap-px border border-[#d9d5cb] bg-[#d9d5cb]">
        <button
          type="button"
          onClick={() => setIntent('floor')}
          className={`flex-1 px-3 py-2 font-mono text-[12px] ${intent === 'floor' ? 'bg-ink text-[#f4f2ec]' : 'bg-[#fbfaf7] text-soft hover:text-ink'}`}
        >
          hold quality · minimize cost
        </button>
        <button
          type="button"
          onClick={() => setIntent('ceiling')}
          className={`flex-1 px-3 py-2 font-mono text-[12px] ${intent === 'ceiling' ? 'bg-ink text-[#f4f2ec]' : 'bg-[#fbfaf7] text-soft hover:text-ink'}`}
        >
          hold cost · maximize quality
        </button>
      </div>

      {/* knobs */}
      {intent === 'floor' ? (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <div className="flex items-baseline justify-between">
              <span className={labelCls}>quality floor</span>
              <span className="font-mono text-[13px] tabular-nums text-ink">{floor}%</span>
            </div>
            <input type="range" min={50} max={99} step={1} value={floor} onChange={(e) => setFloor(Number(e.target.value))} className={`${sliderCls} mt-1`} data-testid="priority-floor" />
          </div>
          <div>
            <div className="flex items-baseline justify-between">
              <label className={`${labelCls} flex items-center gap-2`}>
                <input type="checkbox" checked={latencyOn} onChange={(e) => setLatencyOn(e.target.checked)} className="h-3 w-3 accent-[#0f766e]" />
                hold p95 latency
              </label>
              <span className="font-mono text-[13px] tabular-nums text-ink">{latencyOn ? `${p95} ms` : '—'}</span>
            </div>
            <input type="range" min={300} max={5000} step={100} value={p95} disabled={!latencyOn} onChange={(e) => setP95(Number(e.target.value))} className={`${sliderCls} mt-1 disabled:opacity-30`} />
          </div>
        </div>
      ) : (
        <div className="mt-4">
          <div className="flex items-baseline justify-between">
            <span className={labelCls}>cost ceiling per 1K requests</span>
            <span className="font-mono text-[13px] tabular-nums text-ink">${CEILING_STOPS[ceilingIdx]!.toFixed(2)}</span>
          </div>
          <input type="range" min={0} max={CEILING_STOPS.length - 1} step={1} value={ceilingIdx} onChange={(e) => setCeilingIdx(Number(e.target.value))} className={`${sliderCls} mt-1`} />
        </div>
      )}

      {/* the outcome */}
      <div className="mt-4 border-t border-dashed border-[#d9d5cb] pt-3" data-testid="priority-preview">
        {preview === null ? (
          <p className="font-mono text-[12px] text-faint">computing…</p>
        ) : (
          <>
            <p className="font-mono text-[12.5px] text-soft">{preview.description}</p>
            {preview.expected && (
              <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 font-mono text-[13px] tabular-nums">
                <span className="text-ink">quality {(preview.expected.quality * 100).toFixed(1)}%{qualityDelta !== null && Math.abs(qualityDelta) >= 0.0005 ? <span className={qualityDelta > 0 ? 'text-kept' : 'text-warn'}> ({qualityDelta > 0 ? '+' : ''}{(qualityDelta * 100).toFixed(1)})</span> : null}</span>
                <span className="text-ink">${preview.expected.costPer1K.toFixed(2)}/1K{costDelta !== null && Math.abs(costDelta) >= 0.005 ? <span className={costDelta > 0 ? 'text-warn' : 'text-kept'}> ({costDelta > 0 ? '+' : ''}{Math.round(costDelta * 100)}%)</span> : null}</span>
                <span className="text-kept">{priceVsBaseline(preview.expected.costPer1K, preview.expected.baselineCostPer1K)} vs the best scorer</span>
              </div>
            )}
            {changed.length > 0 ? (
              <div className="mt-2 grid gap-1">
                {changed.map((a) => {
                  const cur = currentAssignments.find((c) => c.clusterId === a.clusterId)!;
                  return (
                    <p key={a.clusterId} className="font-mono text-[12px] text-soft">
                      {a.clusterId}: <span className="text-faint">{cur.strategy.label}</span> → <span className="text-ink">{a.label}</span>
                      {a.quality !== null && cur.quality !== null ? ` · q ${cur.quality.toFixed(2)} → ${a.quality.toFixed(2)}` : ''}
                    </p>
                  );
                })}
              </div>
            ) : (
              <p className="mt-2 font-mono text-[12px] text-faint">{busy ? '…' : 'no assignment changes vs your current plan'}</p>
            )}
          </>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {role === 'admin' ? (
          <button
            type="button"
            onClick={() => void apply()}
            disabled={applying || preview === null}
            className="bg-ink px-4 py-2 text-[13px] font-semibold text-[#f4f2ec] hover:opacity-90 disabled:opacity-40"
            data-testid="apply-priorities"
          >
            {applying ? 'Recompiling…' : 'Use this plan'}
          </button>
        ) : (
          <span className="font-mono text-[12px] text-faint">an admin can apply this</span>
        )}
        <span className="font-mono text-[11.5px] text-faint">
          applying rebinds your keys and mints the next plan version — the change is written on it
        </span>
      </div>
      {error && <p className="mt-2 text-[12.5px] text-refuse">{error}</p>}
    </section>
  );
}
