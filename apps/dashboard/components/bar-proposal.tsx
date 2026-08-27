'use client';

// THE BAR PROPOSAL (S3, brief v4): the learning period's output, surfaced as
// the product's most personal moment — "your work, measured; here's the bar
// I propose" — acceptable in one click. The machinery (learning proposals +
// the apply endpoint) predates this card; what was missing was the moment.
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Prov } from '@/components/primitives';

interface Proposal {
  id: string;
  clusterId: string;
  incumbentModel: string | null;
  incumbentQuality: number | null;
  incumbentCostPer1K: number | null;
  servingModel: string | null;
  servingQuality: number | null;
  servingCostPer1K: number | null;
  /** Bootstrap retention verdict: an OBJECT ({mean, ci95, pairs, …}) from
   * the learning period — typed as a bare number here until 2026-08-25,
   * which made `.toFixed` throw in render the moment a real org had a live
   * proposal (the operator's Today crash; the demo org never had one, so
   * every browser pass missed it and the SSR fixtures encoded the lie). */
  retention: { mean: number; ci95?: [number, number] } | number | null;
  suggestedFloor: number;
  projectedSaving: number | null;
  items: number;
  status: string;
  appliedAt: string | null;
}

const usd = (n: number): string => (n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

/** Normalize the retention field: object (live shape), bare number, or null. */
function retentionOf(r: Proposal['retention']): { mean: number; ci95?: [number, number] } | null {
  if (r === null) return null;
  if (typeof r === 'number') return Number.isFinite(r) ? { mean: r } : null;
  return typeof r.mean === 'number' && Number.isFinite(r.mean) ? r : null;
}

export function BarProposal({ initialProposals, initialAdmin }: { initialProposals?: Proposal[]; initialAdmin?: boolean } = {}) {
  const [proposals, setProposals] = useState<Proposal[]>(initialProposals ?? []);
  const [admin, setAdmin] = useState(initialAdmin ?? false);
  const [busy, setBusy] = useState<string | null>(null);
  const [applied, setApplied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [learning, me] = await Promise.all([
      fetch('/api/learning', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch('/api/auth/me', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    if (me) setAdmin((me as { role?: string }).role === 'admin');
    const list = ((learning as { proposals?: Array<Proposal | null> } | null)?.proposals ?? []).filter(
      (p): p is Proposal => p !== null && p.status === 'proposed' && p.appliedAt === null,
    );
    setProposals(list);
  }, []);
  useEffect(() => {
    if (initialProposals !== undefined) return; // test injection: no fetches
    void load();
  }, [load, initialProposals]);

  async function accept(p: Proposal) {
    setBusy(p.id);
    setError(null);
    const res = await fetch(`/api/learning/proposals/${p.id}/apply`, { method: 'POST' }).catch(() => null);
    setBusy(null);
    if (!res?.ok) {
      const body = (await res?.json().catch(() => null)) as { error?: { message?: string } } | null;
      setError(body?.error?.message ?? 'Could not apply — try again.');
      return;
    }
    setApplied(p.clusterId);
    void load();
  }

  if (applied) {
    return (
      <div className="mt-8 border border-[#c4bfb2] border-t-4 border-t-kept bg-[#fbfaf7] px-6 py-5">
        <div className="font-mono text-[11.5px] uppercase tracking-[0.13em] text-kept">bar set · {applied}</div>
        <p className="mt-2 max-w-lg text-[14px] leading-relaxed text-soft">
          <span className="font-medium text-ink">Done — the bar is yours now.</span> It becomes the
          quality line on Today, the fence on your frontier, and every receipt for this kind of work
          carries it from here on.
        </p>
      </div>
    );
  }

  const p = proposals[0];
  if (!p) return null;

  return (
    <div className="mt-8 border border-[#c4bfb2] border-t-4 border-t-warn bg-[#fbfaf7] px-6 py-5">
      <div className="flex items-baseline justify-between font-mono text-[11.5px] uppercase tracking-[0.13em] text-warn">
        <span>bar proposal · {p.clusterId}</span>
        <span>from your own traffic</span>
      </div>
      <h2 className="mt-2 text-[1.3rem] font-medium tracking-[-0.015em] text-ink">
        Your work, measured. Here&rsquo;s the bar I propose.
      </h2>
      <p className="mt-2 max-w-xl text-[14px] leading-relaxed text-soft">
        From{' '}
        <Prov card={<>your consented sample, capped per kind of work<br />personal data redacted at storage</>}>
          {p.items} sample{p.items === 1 ? '' : 's'}
        </Prov>{' '}
        of your real {p.clusterId} traffic:
        {p.incumbentModel && p.incumbentQuality !== null ? (
          <> your {p.incumbentModel} scores <span className="font-medium text-ink">{p.incumbentQuality.toFixed(2)} on your own work</span>.</>
        ) : (
          <> the premium reference scores <span className="font-medium text-ink">{(p.incumbentQuality ?? p.suggestedFloor).toFixed(2)} on your own work</span>.</>
        )}{' '}
        I propose the bar <span className="font-medium text-ink">never below {p.suggestedFloor.toFixed(2)}</span>
        {p.servingCostPer1K !== null && p.incumbentCostPer1K !== null && p.incumbentCostPer1K > p.servingCostPer1K ? (
          <> — served at <span className="font-semibold text-kept">{usd(p.servingCostPer1K)}/1k instead of {usd(p.incumbentCostPer1K)}</span>, re-verified on fresh items.</>
        ) : (
          <>, re-verified on fresh items.</>
        )}
        {(() => {
          const r = retentionOf(p.retention);
          if (!r) return null;
          return (
            <> Measured retention vs your baseline: <span className="font-medium text-ink">{r.mean.toFixed(2)}</span>
              {r.ci95 ? <span className="text-faint"> (95% CI {r.ci95[0].toFixed(2)}–{r.ci95[1].toFixed(2)})</span> : null}.</>
          );
        })()}
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {admin ? (
          <button
            type="button"
            onClick={() => void accept(p)}
            disabled={busy !== null}
            className="bg-ink px-5 py-2.5 text-[13px] font-medium text-[#f4f2ec] hover:opacity-90 disabled:opacity-40"
          >
            {busy ? 'Setting the bar…' : 'Accept the bar'}
          </button>
        ) : (
          <span className="text-[12px] text-faint">An admin can accept this in one click.</span>
        )}
        <Link href="/settings/controls" className="text-[12px] text-faint underline hover:text-soft">adjust first</Link>
        {proposals.length > 1 && <span className="text-[12px] text-faint">+{proposals.length - 1} more waiting</span>}
      </div>
      {error && <p className="mt-3 text-[12px] text-warn">{error}</p>}
    </div>
  );
}
