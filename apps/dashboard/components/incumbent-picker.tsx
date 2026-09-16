'use client';

// "What do you use today?" — the onboarding question that makes the quality
// bar theirs (operator, 2026-08-22). One or more models from the roster,
// or a typed name we have not measured yet (the audit waits for it).
// Saved per org; the learning period measures the first one as the
// incumbent, the rest are recorded for later.
import { useEffect, useState } from 'react';

interface RosterEntry { alias: string; name: string; vendor: string; native: string }
export interface Incumbents { models: string[]; other: string | null; samplingConsent: boolean; sampleCapPerCluster: number; designatedAt: string | null }

const SENTINELS: Record<string, string> = {
  'several or unsure — smart defaults': 'Smart defaults (several / not sure)',
  'building from scratch': 'Building from scratch',
};
function humanize(other: string): string {
  return SENTINELS[other] ?? other;
}

interface ObservedCluster {
  clusterId: string;
  namedRequests: number;
  models: { label: string; alias: string | null; requests: number; share: number; lastSeen: string }[];
}

export function IncumbentPicker({ initial, onSaved }: { initial: Incumbents | null; onSaved?: (i: Incumbents) => void }) {
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [chosen, setChosen] = useState<string[]>(initial?.models ?? []);
  const [other, setOther] = useState(initial?.other ?? '');
  // Consent is explicit: shown checked, saved only when they press Save.
  const [consent, setConsent] = useState(initial?.samplingConsent ?? true);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<Incumbents | null>(initial);
  const [error, setError] = useState<string | null>(null);
  // SEEN ON YOUR TRAFFIC (2026-09-16): what the org's requests already
  // named, per kind of work. Asking is the fallback; observing is the default.
  const [observed, setObserved] = useState<ObservedCluster[]>([]);

  useEffect(() => {
    fetch('/api/incumbents/options', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { roster: [] }))
      .then((b: { roster: RosterEntry[] }) => setRoster(b.roster ?? []))
      .catch(() => setRoster([]));
    fetch('/api/incumbents/observed', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { clusters: [] }))
      .then((b: { clusters: ObservedCluster[] }) => setObserved(b.clusters ?? []))
      .catch(() => setObserved([]));
  }, []);

  const observedAliases = Array.from(
    new Set(observed.flatMap((c) => c.models.map((m) => m.alias).filter((a): a is string => a !== null))),
  );
  function useObserved() {
    setChosen((prev) => Array.from(new Set([...prev, ...observedAliases])));
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/incumbents', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ models: chosen, other: other.trim() || null, samplingConsent: consent }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(b?.error?.message ?? `request failed (${res.status})`);
      }
      const b = (await res.json()) as Incumbents;
      setSaved(b);
      onSaved?.(b);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const byVendor = roster.reduce<Record<string, RosterEntry[]>>((acc, r) => {
    (acc[r.vendor] ??= []).push(r);
    return acc;
  }, {});

  const rosterGrid = (
    <div className="grid gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
      {Object.entries(byVendor).map(([vendor, entries]) => (
        <div key={vendor}>
          <div className="font-mono text-[11.5px] uppercase tracking-[0.14em] text-faint">{vendor}</div>
          <div className="mt-1.5 space-y-1">
            {entries.map((e) => {
              const on = chosen.includes(e.alias);
              return (
                <label key={e.alias} className="flex cursor-pointer items-center gap-2 text-[13px] text-ink">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => setChosen((c) => (on ? c.filter((x) => x !== e.alias) : [...c, e.alias]))}
                    className="h-3.5 w-3.5 accent-[#1c1a17]"
                  />
                  <span>{e.name}</span>
                </label>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );

  const observedBlock = observed.length > 0 && (
    <div className="mb-4 rounded-md border border-line bg-paper px-4 py-3">
      <div className="mb-1 flex items-center justify-between gap-3">
        <div className="font-mono text-[11.5px] uppercase tracking-[0.13em] text-faint">Seen on your traffic · last 30 days</div>
        {observedAliases.length > 0 && (
          <button type="button" onClick={useObserved} className="rounded border border-line px-2 py-0.5 text-xs text-soft hover:text-ink">
            Use these
          </button>
        )}
      </div>
      <ul className="space-y-1">
        {observed.map((c) => (
          <li key={c.clusterId} className="text-[12.5px] text-soft">
            <span className="font-medium text-ink">{c.clusterId}</span>
            {' — '}
            {c.models.slice(0, 3).map((m, i) => (
              <span key={m.label}>
                {i > 0 ? ', ' : ''}
                <span className={m.alias ? 'text-ink' : 'text-faint'}>{m.alias ?? m.label}</span> {Math.round(m.share * 100)}%
                {m.alias ? '' : ' (not on the measured roster)'}
              </span>
            ))}
            <span className="text-faint"> · {c.namedRequests} named request{c.namedRequests === 1 ? '' : 's'}</span>
          </li>
        ))}
      </ul>
      <p className="mt-1 text-[12px] leading-relaxed text-faint">
        Your requests already name what you use, per kind of work. Receipts compare against these when nothing is named here.
      </p>
    </div>
  );

  return (
    <div className="border border-[#d9d5cb] bg-[#fbfaf7] px-5 py-4">
      {observedBlock}
      {/* The first-run gate exists so nobody reads 28 checkboxes; settings
          must not undo that. A designated org sees its state, and the full
          roster waits behind one disclosure. */}
      {saved !== null && chosen.length === 0 ? (
        <details>
          <summary className="cursor-pointer font-mono text-[12px] uppercase tracking-[0.14em] text-faint hover:text-ink">
            Pick specific models (optional)
          </summary>
          <div className="mt-3">{rosterGrid}</div>
        </details>
      ) : (
        rosterGrid
      )}
      <label className="mt-4 flex cursor-pointer items-start gap-2.5 border-t border-[#d9d5cb] pt-4 text-[13px] leading-relaxed text-soft">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-1 h-3.5 w-3.5 accent-[#1c1a17]" />
        <span>
          Let Potion keep a sample of my requests to measure my workloads (at most {initial?.sampleCapPerCluster ?? 40} per kind of work, prompt and answer,
          personal data redacted before storage). Routing works either way; measuring needs this.
        </span>
      </label>
      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-[#d9d5cb] pt-4">
        <label className="flex flex-1 items-center gap-2 text-[13px] text-soft">
          <span className="shrink-0">Something else:</span>
          <input
            value={other}
            onChange={(e) => setOther(e.target.value)}
            placeholder="e.g. a fine-tune, or a model not listed"
            className="min-w-0 flex-1 border-b border-[#d9d5cb] bg-transparent py-1 text-ink placeholder:text-faint focus:border-ink focus:outline-none"
          />
        </label>
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy || (chosen.length === 0 && other.trim() === '')}
          className="bg-ink px-4 py-2 text-[13px] font-medium text-[#f4f2ec] hover:opacity-90 disabled:opacity-40"
        >
          {busy ? 'Saving…' : saved ? 'Update' : 'Save'}
        </button>
      </div>
      {error && <p className="mt-2 text-[12px] text-warn">{error}</p>}
      {saved && (
        <p className="mt-3 font-mono text-[12px] leading-relaxed text-faint">
          {saved.models.length === 0 && saved.other ? (
            SENTINELS[saved.other] ? (
              <>
                <span className="text-ink">{humanize(saved.other)}</span> — your bar is proposed from the models Potion has measured on your work. Name a specific model above if you also use one.{' '}
              </>
            ) : (
            <>
              <span className="text-ink">{humanize(saved.other)}</span> is not in the measured roster yet, so Potion cannot score it against your work. Your bar will be proposed from the models it has measured; pick one above if you also use one of them.{' '}
            </>
            )
          ) : (
            <>
              Measuring against <span className="text-ink">{saved.models[0]}</span>
              {saved.models.length > 1 ? ` (+${saved.models.length - 1} more recorded)` : ''}
              {saved.other && !SENTINELS[saved.other] ? <> · <span className="text-ink">{saved.other}</span> not in the roster yet</> : null}.{' '}
            </>
          )}
          {saved.samplingConsent ? 'Measuring starts with your first requests.' : 'Measuring is off until you allow a sample.'}
        </p>
      )}
    </div>
  );
}
