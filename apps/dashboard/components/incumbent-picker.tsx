'use client';

// "What do you use today?" — the onboarding question that makes the quality
// bar theirs (operator, 2026-08-22). One or more models from the roster,
// or a typed name we have not measured yet (the audit waits for it).
// Saved per org; the learning period measures the first one as the
// incumbent, the rest are recorded for later.
import { useEffect, useState } from 'react';

interface RosterEntry { alias: string; name: string; vendor: string; native: string }
export interface Incumbents { models: string[]; other: string | null; samplingConsent: boolean; sampleCapPerCluster: number; designatedAt: string | null }

export function IncumbentPicker({ initial, onSaved }: { initial: Incumbents | null; onSaved?: (i: Incumbents) => void }) {
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [chosen, setChosen] = useState<string[]>(initial?.models ?? []);
  const [other, setOther] = useState(initial?.other ?? '');
  // Consent is explicit: shown checked, saved only when they press Save.
  const [consent, setConsent] = useState(initial?.samplingConsent ?? true);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<Incumbents | null>(initial);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/incumbents/options', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { roster: [] }))
      .then((b: { roster: RosterEntry[] }) => setRoster(b.roster ?? []))
      .catch(() => setRoster([]));
  }, []);

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

  return (
    <div className="border border-[#d9d5cb] bg-[#fbfaf7] px-5 py-4">
      <div className="grid gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
        {Object.entries(byVendor).map(([vendor, entries]) => (
          <div key={vendor}>
            <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">{vendor}</div>
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
      <label className="mt-4 flex cursor-pointer items-start gap-2.5 border-t border-[#d9d5cb] pt-4 text-[13px] leading-relaxed text-soft">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-1 h-3.5 w-3.5 accent-[#1c1a17]" />
        <span>
          Keep a sample of my requests so Potion can measure my bar. At most {initial?.sampleCapPerCluster ?? 40} per kind of work, prompt and answer, with
          personal data redacted before it is stored. Without this, the audit waits; routing works either way.
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
        <p className="mt-3 font-mono text-[11px] leading-relaxed text-faint">
          Measuring against <span className="text-ink">{saved.models[0] ?? saved.other}</span>
          {saved.models.length > 1 ? ` (+${saved.models.length - 1} more recorded)` : ''}. {saved.samplingConsent ? 'Sampling is on: your bar is what it scores on your own requests.' : 'Sampling is off: the audit waits until you allow it.'}
        </p>
      )}
    </div>
  );
}
