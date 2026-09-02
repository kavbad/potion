'use client';

// G1 VERIFIED SAVINGS (0086) — the randomized-holdout block on the Savings
// page: the only place the product says "verified", and the place the
// consented slice is always visible. States are honest: off invites, an
// insufficient window shows its count, and only randomized evidence renders
// dollar claims — with the conservative LOWER bound named as the billable
// number.
import { useCallback, useEffect, useState } from 'react';
import type { VerifiedSavingsDto } from '@/lib/types';

const usd = (n: number): string => (Math.abs(n) < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const pct = (r: number): string => `${(r * 100).toFixed(1).replace(/\.0$/, '')}%`;

export function HoldoutCard({ verified }: { verified: VerifiedSavingsDto }) {
  const [state, setState] = useState<{ enabled: boolean; rate: number; maxRate: number; eligible: boolean; incumbentModel: string | null } | null>(null);
  const [admin, setAdmin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [h, me] = await Promise.all([
      fetch('/api/holdout', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch('/api/auth/me', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    if (h) setState(h as typeof state);
    if (me) setAdmin((me as { role?: string }).role === 'admin');
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(enabled: boolean) {
    setBusy(true);
    setError(null);
    const res = await fetch('/api/holdout', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }).catch(() => null);
    setBusy(false);
    if (!res?.ok) {
      const body = (await res?.json().catch(() => null)) as { error?: { message?: string } } | null;
      setError(body?.error?.message ?? 'Could not update — try again.');
      return;
    }
    void load();
  }

  const v = verified;
  return (
    <section className="mb-8 border border-[#d9d5cb] border-t-4 border-t-kept bg-[#fbfaf7] px-8 py-6">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-medium text-ink">Verified savings</h2>
        <span className="font-mono text-[11.5px] uppercase tracking-[0.13em] text-faint">
          {v.status === 'verified' && v.holdoutRate !== null
            ? `live baseline · ${pct(v.holdoutRate)} of eligible requests`
            : 'randomized live baseline'}
        </span>
      </div>

      {v.status === 'verified' ? (
        <>
          <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4">
            <div>
              <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-faint">without Potion</div>
              <div className="mt-1 text-[1.2rem] tabular-nums text-ink">{usd(v.withoutPotionUsd!)}</div>
            </div>
            <div>
              <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-faint">with Potion</div>
              <div className="mt-1 text-[1.2rem] tabular-nums text-ink">{usd(v.routedSpendUsd)}</div>
            </div>
            <div>
              <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-faint">verified savings</div>
              <div className="mt-1 text-[1.2rem] tabular-nums text-kept">{usd(v.verifiedSavingsUsd!)}</div>
            </div>
            <div>
              <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-faint">95% lower bound</div>
              <div className="mt-1 text-[1.2rem] tabular-nums text-ink">{usd(v.verifiedSavingsLowerUsd!)}</div>
            </div>
          </div>
          <p className="mt-3 text-[12.5px] leading-relaxed text-faint">
            Basis: {v.holdoutRequests} randomized requests served by your {v.incumbentModel} measured{' '}
            {usd(v.meanIncumbentCostUsd!)} per request
            {v.meanCi95 ? ` (95% CI ${usd(v.meanCi95[0])}–${usd(v.meanCi95[1])})` : ''} · projected over {v.routedRequests} routed
            requests vs their measured spend. The lower bound is the number billing will use — never the estimate.
          </p>
        </>
      ) : v.status === 'insufficient' ? (
        <p className="mt-3 max-w-xl text-[13.5px] leading-relaxed text-soft">
          The baseline is live: <span className="font-medium text-ink">{v.holdoutRequests} of {v.minHoldoutRequests}</span> randomized
          requests measured so far this window. Dollar claims stay off until your own traffic proves them.
        </p>
      ) : v.status === 'no-incumbent' ? (
        <p className="mt-3 max-w-xl text-[13.5px] leading-relaxed text-soft">
          The holdout is on, but no designated incumbent resolves to a servable model — name what you use today in Settings and the
          baseline starts measuring.
        </p>
      ) : (
        <p className="mt-3 max-w-xl text-[13.5px] leading-relaxed text-soft">
          Savings here are projections until you turn on the live baseline: a{' '}
          <span className="font-medium text-ink">{state ? pct(Math.min(state.rate, state.maxRate)) : 'small'}</span> randomized slice of
          eligible requests goes to your named incumbent, and month-end savings are then verified against what your own traffic
          measured — billed at the conservative lower bound. Those requests are served by the model you use today; every one is
          labeled on its receipt.
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {state !== null && admin ? (
          <button
            type="button"
            onClick={() => void toggle(!state.enabled)}
            disabled={busy || (!state.enabled && !state.eligible)}
            className="bg-ink px-5 py-2.5 text-[13px] font-medium text-[#f4f2ec] hover:opacity-90 disabled:opacity-40"
          >
            {busy ? 'Saving…' : state.enabled ? 'Turn the live baseline off' : 'Verify my savings with a live baseline'}
          </button>
        ) : state !== null && !admin ? (
          <span className="text-[12px] text-faint">An admin can turn the live baseline on.</span>
        ) : null}
        {state !== null && !state.eligible && !state.enabled ? (
          <span className="text-[12px] text-faint">needs a designated incumbent that resolves to a servable model</span>
        ) : null}
      </div>
      {error && <p className="mt-3 text-[12px] text-warn">{error}</p>}
    </section>
  );
}
