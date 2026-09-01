'use client';
// W3 — the Improve inbox (WORKERS-DIRECTION §60/§61, 2026-09-01). Potion
// proposes a DESCENDANT with receipts: what I noticed / what I changed /
// why / the rehearsal proof / the permission impact — and the operator
// promotes it. Nothing here edits a generation in place.
import { useCallback, useEffect, useState } from 'react';

interface Proposal {
  id: string;
  evidenceN: number;
  mutation: { type: string; summary: string; noticed: string; why: string; change: Record<string, unknown> };
}
interface RunSummary { runId: string; state: string; judgeOverall: number | null; spentUsd: number; steps: number; asks: number }
interface Candidate {
  candidateHash: string;
  generation: number;
  mutation: Proposal['mutation'] | null;
  supersededParent: boolean;
  shadow: RunSummary | null;
  baseline: RunSummary | null;
}

const EYEBROW = 'font-mono text-[12px] uppercase tracking-[0.13em] text-faint';
const BTN = 'border border-accent/60 px-3 py-1.5 font-mono text-[12.5px] text-accent hover:bg-accent hover:text-white disabled:opacity-40';

export function ImproveInbox({ harnessHash, role }: { harnessHash: string; role: string }) {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [ir, cr] = await Promise.all([
      fetch(`/api/lab/harnesses/${harnessHash}/improvements`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(`/api/lab/harnesses/${harnessHash}/candidates`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    if (ir) setProposals((ir as { improvements: Proposal[] }).improvements);
    if (cr) setCandidates((cr as { candidates: Candidate[] }).candidates);
  }, [harnessHash]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 8000);
    return () => clearInterval(t);
  }, [load]);

  const build = useCallback(async (improvementId: string) => {
    setBusy(improvementId);
    setNote(null);
    try {
      const res = await fetch(`/api/lab/harnesses/${harnessHash}/candidates`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ improvementId }),
      });
      if (res.status === 201) setNote('candidate built — rehearsing in shadow (acts stubbed, reads real)');
      else setNote(`could not build: ${((await res.json()) as { error?: { message?: string } }).error?.message ?? res.status}`);
      await load();
    } finally { setBusy(null); }
  }, [harnessHash, load]);

  const promote = useCallback(async (candidateHash: string) => {
    setBusy(candidateHash);
    setNote(null);
    try {
      const res = await fetch(`/api/lab/harnesses/${harnessHash}/promote`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ candidateHash }),
      });
      if (res.ok) {
        const body = (await res.json()) as { plan: Array<{ actionClass: string; preserve: boolean }> };
        const kept = body.plan.filter((p) => p.preserve).length;
        setNote(`promoted — ${kept}/${body.plan.length} earned permission(s) carried; the rest re-prove`);
        window.location.href = `/lab/harness/${candidateHash}`;
      } else setNote('promotion refused');
    } finally { setBusy(null); }
  }, [harnessHash]);

  if (proposals.length === 0 && candidates.length === 0) return null;
  const admin = role === 'admin';

  return (
    <section className="mt-8" data-testid="improve-inbox">
      <h2 className={EYEBROW}>improve — what the record taught, with receipts</h2>
      {note !== null ? <p className="mt-2 font-mono text-[12.5px] text-accent">{note}</p> : null}

      {proposals.map((p) => (
        <div key={p.id} className="mt-3 border border-[#d9d5cb] bg-[#fbfaf7] px-5 py-4" data-testid="improve-proposal">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-mono text-[12px] uppercase tracking-[0.1em] text-accent">{p.mutation.type} mutation · {p.evidenceN} observation(s)</span>
          </div>
          <p className="mt-2 text-[14px] leading-relaxed text-ink"><b>What I noticed:</b> {p.mutation.noticed}</p>
          <p className="mt-1 text-[14px] leading-relaxed text-ink"><b>What I would change:</b> {p.mutation.summary}</p>
          <p className="mt-1 text-[13.5px] leading-relaxed text-soft"><b>Why:</b> {p.mutation.why}</p>
          {admin ? (
            <button type="button" disabled={busy !== null} onClick={() => void build(p.id)} className={`${BTN} mt-3`} data-testid="build-candidate">
              build the descendant &amp; rehearse it →
            </button>
          ) : null}
        </div>
      ))}

      {candidates.map((c) => (
        <div key={c.candidateHash} className="mt-3 border border-[#d9d5cb] bg-white px-5 py-4" data-testid="candidate-card">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-mono text-[12px] uppercase tracking-[0.1em] text-ink">
              generation {c.generation} · candidate {c.candidateHash.slice(0, 12)}…
            </span>
            {c.supersededParent ? <span className="font-mono text-[11.5px] text-accent">PROMOTED</span> : null}
          </div>
          {c.mutation !== null ? <p className="mt-1 text-[13.5px] text-soft">{c.mutation.summary} — {c.mutation.noticed}</p> : null}
          <div className="mt-3 grid gap-1 font-mono text-[12.5px] tabular-nums text-ink">
            <div className="text-faint">the rehearsal (shadow: acts stubbed, reads real) vs the current generation:</div>
            <div>judge&nbsp;&nbsp;&nbsp;{c.baseline?.judgeOverall ?? '—'} → {c.shadow?.judgeOverall ?? (c.shadow?.state === 'completed' ? 'scoring…' : c.shadow?.state ?? 'queued')}</div>
            <div>spend&nbsp;&nbsp;&nbsp;${c.baseline?.spentUsd?.toFixed(4) ?? '—'} → ${c.shadow?.spentUsd?.toFixed(4) ?? '—'}</div>
            <div>asks&nbsp;&nbsp;&nbsp;&nbsp;{c.baseline?.asks ?? '—'} → {c.shadow?.asks ?? '—'}</div>
          </div>
          {admin && !c.supersededParent && c.shadow?.state === 'completed' ? (
            <button type="button" disabled={busy !== null} onClick={() => void promote(c.candidateHash)} className={`${BTN} mt-3`} data-testid="promote-candidate">
              promote generation {c.generation} →
            </button>
          ) : null}
        </div>
      ))}
    </section>
  );
}
