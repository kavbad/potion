'use client';

// THE CHALLENGER PROPOSAL (G1): the promotion loop's moment — "a cheaper
// route proved itself on your work; promote it in one click." Minted only
// when a shadow-qualified challenger (lower bound ≥ your floor on ≥30 of
// your live requests, cheaper on measured actuals) ALSO held retention
// against your current route on your own derived suite. Apply mints an ORG
// frontier from those same measurements — routing changes through the
// measured field under the lower-bound selection law, never by fiat.
import { useCallback, useEffect, useState } from 'react';
import { Prov } from '@/components/primitives';

interface ChallengerProposalDto {
  id: string;
  clusterId: string;
  status: string;
  servingModel: string;
  servingQuality: number;
  challengerModel: string;
  challengerQuality: number;
  retention: { mean: number; ci95?: [number, number]; pairs?: number } | null;
  shadow: {
    n?: number;
    quality?: number;
    qualityCi?: [number, number];
    costPer1K?: number;
    servingMeasuredCostPer1K?: number | null;
  } | null;
  items: number;
  appliedAt: string | null;
}

const usd = (n: number): string => (n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

export function ChallengerProposal({ initialProposals, initialAdmin }: { initialProposals?: ChallengerProposalDto[]; initialAdmin?: boolean } = {}) {
  const [proposals, setProposals] = useState<ChallengerProposalDto[]>(initialProposals ?? []);
  const [admin, setAdmin] = useState(initialAdmin ?? false);
  const [busy, setBusy] = useState<string | null>(null);
  const [applied, setApplied] = useState<{ clusterId: string; nowServes: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [res, me] = await Promise.all([
      fetch('/api/challengers', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch('/api/auth/me', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    if (me) setAdmin((me as { role?: string }).role === 'admin');
    const list = ((res as { proposals?: Array<ChallengerProposalDto | null> } | null)?.proposals ?? []).filter(
      (p): p is ChallengerProposalDto => p !== null && p.status === 'proposed' && p.appliedAt === null,
    );
    setProposals(list);
  }, []);
  useEffect(() => {
    if (initialProposals !== undefined) return; // test injection: no fetches
    void load();
  }, [load, initialProposals]);

  async function promote(p: ChallengerProposalDto) {
    setBusy(p.id);
    setError(null);
    const res = await fetch(`/api/challengers/${p.id}/apply`, { method: 'POST' }).catch(() => null);
    setBusy(null);
    if (!res?.ok) {
      const body = (await res?.json().catch(() => null)) as { error?: { message?: string } } | null;
      setError(body?.error?.message ?? 'Could not promote — try again.');
      return;
    }
    const body = (await res.json().catch(() => null)) as { nowServes?: { model?: string } | null } | null;
    setApplied({ clusterId: p.clusterId, nowServes: body?.nowServes?.model ?? null });
    void load();
  }

  if (applied) {
    return (
      <div className="mt-8 border border-[#c4bfb2] border-t-4 border-t-kept bg-[#fbfaf7] px-6 py-5">
        <div className="font-mono text-[11.5px] uppercase tracking-[0.13em] text-kept">promoted · {applied.clusterId}</div>
        <p className="mt-2 max-w-lg text-[14px] leading-relaxed text-soft">
          <span className="font-medium text-ink">Done — your own measurements route this work now.</span>{' '}
          {applied.nowServes !== null ? <>Serving: <span className="font-medium text-ink">{applied.nowServes}</span>. </> : null}
          Your plan recompiles as a new version with the change written on it, and every receipt names it.
        </p>
      </div>
    );
  }

  const p = proposals[0];
  if (!p) return null;
  const cheaper =
    p.shadow?.costPer1K !== undefined &&
    p.shadow?.servingMeasuredCostPer1K !== undefined &&
    p.shadow.servingMeasuredCostPer1K !== null;

  return (
    <div className="mt-8 border border-[#c4bfb2] border-t-4 border-t-warn bg-[#fbfaf7] px-6 py-5">
      <div className="flex items-baseline justify-between font-mono text-[11.5px] uppercase tracking-[0.13em] text-warn">
        <span>challenger · {p.clusterId}</span>
        <span>proved on your work</span>
      </div>
      <h2 className="mt-2 text-[1.3rem] font-medium tracking-[-0.015em] text-ink">
        A cheaper route proved itself. Promote it?
      </h2>
      <p className="mt-2 max-w-xl text-[14px] leading-relaxed text-soft">
        <span className="font-medium text-ink">{p.challengerModel}</span> cleared your bar on{' '}
        <Prov card={<>serve-judge scores on your sampled live traffic<br />gated on the 95% LOWER bound, never the mean</>}>
          {p.shadow?.n ?? '—'} of your live requests
        </Prov>
        {p.shadow?.qualityCi ? (
          <span className="text-faint"> (lower bound {p.shadow.qualityCi[0].toFixed(3)})</span>
        ) : null}
        , and on your own suite it retained{' '}
        <span className="font-medium text-ink">{p.retention ? (p.retention.mean * 100).toFixed(1) : '—'}%</span> of your current route&rsquo;s
        quality
        {p.retention?.ci95 ? (
          <span className="text-faint"> (95% CI {(p.retention.ci95[0] * 100).toFixed(1)}–{(p.retention.ci95[1] * 100).toFixed(1)}%)</span>
        ) : null}{' '}
        across {p.items} paired item{p.items === 1 ? '' : 's'}
        {cheaper ? (
          <> — at <span className="font-semibold text-kept">{usd(p.shadow!.costPer1K!)}/1k measured, vs {usd(p.shadow!.servingMeasuredCostPer1K!)} for your current route</span></>
        ) : null}
        . Promoting mints a plan built from <span className="font-medium text-ink">your measurements</span> — selection still holds your
        floor, so a route that cannot prove your bar never serves.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {admin ? (
          <button
            type="button"
            onClick={() => void promote(p)}
            disabled={busy !== null}
            className="bg-ink px-5 py-2.5 text-[13px] font-medium text-[#f4f2ec] hover:opacity-90 disabled:opacity-40"
          >
            {busy ? 'Promoting…' : 'Promote the challenger'}
          </button>
        ) : (
          <span className="text-[12px] text-faint">An admin can promote this in one click.</span>
        )}
        {proposals.length > 1 && <span className="text-[12px] text-faint">+{proposals.length - 1} more waiting</span>}
      </div>
      {error && <p className="mt-3 text-[12px] text-warn">{error}</p>}
    </div>
  );
}
