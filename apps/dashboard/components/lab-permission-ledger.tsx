'use client';

// L-G3 — THE PERMISSION LEDGER (Lab direction v2): permission as the output
// of evidence. No trust score exists anywhere on this surface — three
// groups (can act alone / asks first / blocked), and behind every line the
// evidence that put it there. Admin view fires an evaluation pass on mount:
// looking at the ledger IS the re-evaluation moment, and a pass may
// auto-tighten (fail closed) — the UI then shows exactly that.
import { useCallback, useEffect, useState } from 'react';

interface GrantEvidence { n: number; approved: number; edited: number; rejected: number; lastAt: string | null }
export interface GrantRow {
  id: string;
  actionClass: string;
  riskTier: 'reversible-read' | 'reversible-act' | 'irreversible-act' | 'never-graduates';
  state: 'supervised' | 'autonomous' | 'blocked';
  auditRate: number;
  stateReason: string | null;
  grantedAt: string | null;
  revokedAt: string | null;
  evidence: GrantEvidence;
}
export interface LedgerResponse {
  grants: GrantRow[];
  observedUngranted: Array<{ actionClass: string; evidence: GrantEvidence }>;
}
interface Proposal { grantId: string; actionClass: string; decision: { why: string } }

const TIER_LABEL: Record<GrantRow['riskTier'], string> = {
  'reversible-read': 'reversible · read',
  'reversible-act': 'reversible · act',
  'irreversible-act': 'irreversible',
  'never-graduates': 'never graduates',
};

function EvidenceLine({ e }: { e: GrantEvidence }) {
  if (e.n === 0) return <span className="font-mono text-[10.5px] text-faint">no supervised observations yet</span>;
  return (
    <span className="font-mono text-[10.5px] text-faint">
      {e.n} observed · {e.approved} approved{e.edited > 0 ? ` · ${e.edited} edited` : ''}
      {e.rejected > 0 ? ` · ${e.rejected} rejected` : ''}
      {e.lastAt ? ` · last ${new Date(e.lastAt).toLocaleDateString()}` : ''}
    </span>
  );
}

export function LabPermissionLedger({
  harnessHash,
  role,
  initialLedger,
  initialProposals,
}: {
  harnessHash: string;
  role: 'admin' | 'member' | 'viewer';
  /** Test injection (house idiom): initial props skip all fetching. */
  initialLedger?: LedgerResponse;
  initialProposals?: Proposal[];
}) {
  const [ledger, setLedger] = useState<LedgerResponse | null>(initialLedger ?? null);
  const [proposals, setProposals] = useState<Proposal[]>(initialProposals ?? []);
  const [tightened, setTightened] = useState<Array<{ actionClass: string; why: string }>>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/lab/harnesses/${harnessHash}/grants`, { cache: 'no-store' }).catch(() => null);
    if (res?.ok) setLedger((await res.json()) as LedgerResponse);
  }, [harnessHash]);

  useEffect(() => {
    if (initialLedger !== undefined) return; // test injection: no fetches
    void (async () => {
      if (role === 'admin') {
        // Viewing the ledger is the evaluation moment (admin only).
        const ev = await fetch(`/api/lab/harnesses/${harnessHash}/grants/evaluate`, { method: 'POST' }).catch(() => null);
        if (ev?.ok) {
          const body = (await ev.json()) as { proposals: Proposal[]; tightened: Array<{ actionClass: string; why: string }> };
          setProposals(body.proposals);
          setTightened(body.tightened);
        }
      }
      await load();
    })();
  }, [harnessHash, role, load, initialLedger]);

  async function accept(p: Proposal) {
    setBusy(p.grantId);
    const res = await fetch(`/api/lab/grants/${p.grantId}/accept`, { method: 'POST' }).catch(() => null);
    setBusy(null);
    if (res?.ok) {
      setProposals((cur) => cur.filter((x) => x.grantId !== p.grantId));
      await load();
    }
  }

  if (!ledger) return null;
  const groups: Array<{ title: string; note: string; rows: GrantRow[] }> = [
    { title: 'Can act alone', note: 'earned — and re-evaluated continuously; standing sampled audit', rows: ledger.grants.filter((g) => g.state === 'autonomous') },
    { title: 'Asks first', note: 'every action gated through the check-in', rows: ledger.grants.filter((g) => g.state === 'supervised') },
    { title: 'Blocked', note: 'not permitted at all', rows: ledger.grants.filter((g) => g.state === 'blocked') },
  ];

  return (
    <section className="mt-8 border border-[#d9d5cb] bg-[#fbfaf7] px-6 py-5">
      <div className="flex items-baseline justify-between font-mono text-[10px] uppercase tracking-[0.16em] text-faint">
        <span>Permission ledger</span>
        <span>permission is the output of evidence — there is no trust score</span>
      </div>

      {tightened.length > 0 && (
        <div className="mt-3 border border-refuse/40 bg-white px-4 py-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-refuse">re-supervised just now</div>
          {tightened.map((t) => (
            <p key={t.actionClass} className="mt-1 text-[13px] text-soft">
              <span className="font-mono text-ink">{t.actionClass}</span> — {t.why}
            </p>
          ))}
        </div>
      )}

      {proposals.length > 0 && (
        <div className="mt-3 border border-[#c4bfb2] border-t-4 border-t-warn bg-white px-4 py-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-warn">graduation proposals · evidence cleared the bar</div>
          {proposals.map((p) => (
            <div key={p.grantId} className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-[13px] text-soft">
                <span className="font-mono text-ink">{p.actionClass}</span> — {p.decision.why}
              </p>
              {role === 'admin' ? (
                <button
                  type="button"
                  onClick={() => void accept(p)}
                  disabled={busy !== null}
                  className="bg-ink px-3 py-1.5 text-[12px] font-medium text-[#f4f2ec] hover:opacity-90 disabled:opacity-40"
                >
                  {busy === p.grantId ? 'Granting…' : 'Grant autonomy'}
                </button>
              ) : (
                <span className="text-[11px] text-faint">an admin can grant this</span>
              )}
            </div>
          ))}
        </div>
      )}

      {groups.map((g) => (
        <div key={g.title} className="mt-4">
          <div className="flex items-baseline justify-between border-b border-[#c4bfb2] pb-1.5">
            <span className={`text-[13px] font-semibold ${g.title === 'Can act alone' ? 'text-kept' : g.title === 'Blocked' ? 'text-refuse' : 'text-ink'}`}>{g.title}</span>
            <span className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-faint">{g.note}</span>
          </div>
          {g.rows.length === 0 ? (
            <p className="py-2 font-mono text-[11px] text-faint">
              {g.title === 'Can act alone' ? 'nothing yet — autonomy is earned per action class, under supervision' : 'none'}
            </p>
          ) : (
            g.rows.map((r) => (
              <div key={r.id} className="flex flex-wrap items-baseline justify-between gap-x-4 border-b border-dashed border-[#d9d5cb] py-2">
                <span className="font-mono text-[12.5px] text-ink">{r.actionClass}</span>
                <span className="flex flex-wrap items-baseline gap-x-3">
                  <span className={`border px-1.5 py-px font-mono text-[9.5px] uppercase tracking-[0.08em] ${r.riskTier === 'never-graduates' ? 'border-refuse text-refuse' : 'border-line text-faint'}`}>
                    {TIER_LABEL[r.riskTier]}
                  </span>
                  <EvidenceLine e={r.evidence} />
                  {r.state === 'autonomous' && (
                    <span className="font-mono text-[10.5px] text-kept">audit {(r.auditRate * 100).toFixed(0)}%</span>
                  )}
                  {r.stateReason && <span className="font-mono text-[10.5px] text-refuse">{r.stateReason}</span>}
                </span>
              </div>
            ))
          )}
        </div>
      ))}

      {ledger.observedUngranted.length > 0 && (
        <p className="mt-3 font-mono text-[10.5px] text-faint">
          also observed: {ledger.observedUngranted.map((o) => o.actionClass).join(' · ')} — rows appear after the next evaluation
        </p>
      )}
    </section>
  );
}
