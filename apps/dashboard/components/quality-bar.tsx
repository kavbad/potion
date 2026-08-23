'use client';

// YOUR QUALITY BAR — the learning period, seen from the customer's side:
// how many of their requests have been sampled per kind of work, and, when
// enough have, the proposal: what their model scores on their own work,
// what Potion's pick retains of it, the floor Potion suggests, the saving.
// One button sets the bar. Nothing is applied without it.
import { useEffect, useState } from 'react';

interface Proposal {
  id: string; clusterId: string; incumbentModel: string; incumbentQuality: number; incumbentCostPer1K: number | null;
  servingModel: string; servingQuality: number; servingCostPer1K: number | null;
  retention: { mean?: number; ci95?: [number, number] } | null; suggestedFloor: number; projectedSaving: number | null;
  items: number; status: string; createdAt: string; appliedAt: string | null;
}
interface LearningState { samplingConsent: boolean; sampleCapPerCluster: number; samples: Record<string, number>; proposals: Proposal[] }

const usd = (n: number) => (n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

export function QualityBar({ admin }: { admin: boolean }) {
  const [state, setState] = useState<LearningState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function load() {
    const r = await fetch('/api/learning', { cache: 'no-store' }).catch(() => null);
    if (r?.ok) setState((await r.json()) as LearningState);
  }
  useEffect(() => { void load(); }, []);

  async function applyAll() {
    setBusy('all');
    const r = await fetch('/api/learning/proposals/apply-all', { method: 'POST' }).catch(() => null);
    setBusy(null);
    if (r?.ok) await load();
  }
  async function apply(id: string) {
    setBusy(id); setNote(null);
    const r = await fetch(`/api/learning/proposals/${id}/apply`, { method: 'POST' }).catch(() => null);
    if (r?.ok) { const b = (await r.json()) as { qualityFloor: number; keysRebound: number }; setNote(`Your bar is set at ${b.qualityFloor.toFixed(2)} on ${b.keysRebound} key${b.keysRebound === 1 ? '' : 's'}. Every receipt from now on is measured against it.`); }
    else setNote('Could not set the bar; try again.');
    setBusy(null); await load();
  }
  async function measureNow() {
    setBusy('run'); setNote(null);
    const r = await fetch('/api/learning/run', { method: 'POST' }).catch(() => null);
    setNote(r?.ok ? 'Measuring. This takes a few minutes; the proposal appears here when it is done.' : 'Could not start a measurement.');
    setBusy(null);
  }

  if (!state) return <p className="font-mono text-[11px] text-faint">loading</p>;
  const clusters = Object.entries(state.samples).sort(([a], [b]) => a.localeCompare(b));
  const total = clusters.reduce((s, [, n]) => s + n, 0);
  const open = state.proposals.filter((p) => p.status === 'proposed');
  const applied = state.proposals.filter((p) => p.status === 'applied');

  return (
    <div className="mt-4 border border-[#d9d5cb] bg-[#fbfaf7] px-5 py-4 font-mono text-[12px]">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-[10px] uppercase tracking-[0.16em] text-faint">measuring your workloads</div>
        <div className="text-[11px] text-faint">
          {state.samplingConsent ? `${total} request${total === 1 ? '' : 's'} sampled so far` : 'sampling is off'}
        </div>
      </div>
      {!state.samplingConsent ? (
        <p className="mt-2 text-soft">Allow sampling above and Potion measures your own workloads to route each one to the right model.</p>
      ) : clusters.length === 0 ? (
        <p className="mt-2 text-soft">Potion is measuring your workloads as your requests come in, to route each kind of work to the right model. It starts on its own after your first requests; each kind of work takes a little time.</p>
      ) : (
        <ul className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2">
          {clusters.map(([c, n]) => (
            <li key={c} className="flex justify-between"><span className="text-soft">{c}</span><span className={n >= 8 ? 'text-ink' : 'text-faint'}>{n >= 8 ? 'measuring' : `${n} of 8 requests seen`}</span></li>
          ))}
        </ul>
      )}

      {admin && open.length >= 2 && (
        <div className="mt-3 flex items-baseline justify-between gap-3">
          <span className="text-soft">{open.length} kinds of work measured — set every bar at once, or one at a time below.</span>
          <button type="button" disabled={busy !== null} onClick={() => void applyAll()} className="bg-ink px-4 py-2 text-[12px] font-medium text-[#f4f2ec] hover:opacity-90 disabled:opacity-40">
            {busy === 'all' ? 'Setting…' : `Set all ${open.length} bars`}
          </button>
        </div>
      )}
      {(open.length > 0 || applied.length > 0) && (
        <div className="mt-4 border-t border-[#d9d5cb] pt-3">
          {[...open, ...applied].map((p) => {
            const ret = p.retention?.mean ?? null;
            return (
              <div key={p.id} className="py-2 first:pt-0">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-ink">{p.clusterId}</span>
                  <span className="text-faint">{p.items} of your prompts · {p.status === 'applied' ? `set ${p.appliedAt?.slice(0, 10)}` : 'proposed'}</span>
                </div>
                <p className="mt-1 leading-relaxed text-soft">
                  <span className="text-ink">{p.incumbentModel}</span> scores <span className="text-ink">{p.incumbentQuality.toFixed(2)}</span> on your work.{' '}
                  Potion&apos;s pick, <span className="text-ink">{p.servingModel}</span>, {ret === null ? 'keeps an unmeasured share of that' : ret >= 1 ? <>matches or beats it</> : <>keeps <span className="text-ink">{Math.round(ret * 100)}%</span> of that</>}
                  {p.projectedSaving !== null ? <> at <span className="text-accent">{Math.round(p.projectedSaving * 100)}% less</span></> : p.servingCostPer1K !== null ? <> at {usd(p.servingCostPer1K)} per 1,000</> : null}.
                </p>
                {p.status === 'proposed' && admin && (
                  <button type="button" disabled={busy !== null} onClick={() => void apply(p.id)} className="mt-2 bg-ink px-4 py-2 text-[12px] font-medium text-[#f4f2ec] hover:opacity-90 disabled:opacity-40">
                    {busy === p.id ? 'Setting…' : `Set my bar at ${p.suggestedFloor.toFixed(2)}`}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {admin && state.samplingConsent && total >= 8 && open.length === 0 && (
        <button type="button" disabled={busy !== null} onClick={() => void measureNow()} className="mt-3 border border-[#d9d5cb] px-3 py-1.5 text-[12px] text-soft hover:border-ink hover:text-ink disabled:opacity-40">
          {busy === 'run' ? 'Starting…' : 'Measure now'}
        </button>
      )}
      {note && <p className="mt-3 text-[12px] text-accent">{note}</p>}
      <p className="mt-3 text-[11px] leading-relaxed text-faint">Measured on your own requests against what you use today. Your rule changes only when you set it.</p>
    </div>
  );
}
