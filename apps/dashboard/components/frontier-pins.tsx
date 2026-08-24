'use client';

// R7: version control for what serves you. Pin a cluster and the frontier
// stops moving under you; the changelog below says what the pin is holding
// back, and what moved recently on everything you have not pinned.
import { useCallback, useEffect, useState } from 'react';

interface PinRow {
  clusterId: string;
  name: string;
  servedVersion: number | null;
  latestVersion: number | null;
  pinned: { version: number; pinnedBy: string; pinnedAt: string } | null;
  holdingBack: boolean;
}
interface ChangeEntry {
  clusterId: string;
  name: string;
  kind: 'held-back' | 'applied';
  fromVersion: number;
  toVersion: number;
  at: string;
  narrative: string;
}

export function FrontierPins() {
  const [rows, setRows] = useState<PinRow[] | null>(null);
  const [entries, setEntries] = useState<ChangeEntry[]>([]);
  const [role, setRole] = useState('viewer');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [me, pins, log] = await Promise.all([
      fetch('/api/auth/me', { cache: 'no-store' }).catch(() => null),
      fetch('/api/pins', { cache: 'no-store' }).catch(() => null),
      fetch('/api/frontier-changelog', { cache: 'no-store' }).catch(() => null),
    ]);
    if (me?.ok) setRole(((await me.json()) as { role?: string }).role ?? 'viewer');
    setRows(pins?.ok ? ((await pins.json()) as { pins: PinRow[] }).pins : []);
    if (log?.ok) setEntries(((await log.json()) as { entries: ChangeEntry[] }).entries);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function toggle(row: PinRow) {
    setBusy(row.clusterId);
    setError(null);
    const res = await fetch(`/api/pins/${encodeURIComponent(row.clusterId)}`, {
      method: row.pinned ? 'DELETE' : 'PUT',
    }).catch(() => null);
    setBusy(null);
    if (!res?.ok) {
      const body = (await res?.json().catch(() => null)) as { error?: { message?: string } } | null;
      setError(body?.error?.message ?? 'could not change the pin');
      return;
    }
    await load();
  }

  if (rows === null) return null;
  const admin = role === 'admin';

  return (
    <>
      <section className="mb-8 rounded-xl border border-line bg-panel px-8 py-8">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-lg font-medium text-ink">Version control</h2>
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-faint">per kind of work</span>
        </div>
        <p className="mb-6 max-w-xl text-sm leading-relaxed text-soft">
          Potion re-measures continuously and moves you to better points as they are proven. Pin a
          kind of work and that stops for you — useful while you are testing your own product
          against ours. You can release a pin at any time.
        </p>

        {rows.length === 0 ? (
          <p className="text-sm text-faint">Nothing measured yet — pins appear once a kind of work has a frontier.</p>
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((r) => (
              <li key={r.clusterId} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[14px] text-ink">{r.name}</span>
                    {r.pinned && (
                      <span className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-soft">
                        pinned v{r.pinned.version}
                      </span>
                    )}
                    {r.holdingBack && (
                      <span className="rounded-full border border-warn bg-amber-50 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-warn">
                        v{r.latestVersion} available
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 font-mono text-[11px] text-faint">
                    serving v{r.servedVersion ?? '—'}
                    {r.pinned ? ` · pinned by ${r.pinned.pinnedBy} on ${r.pinned.pinnedAt.slice(0, 10)}` : ' · following the newest'}
                  </div>
                </div>
                {admin && (
                  <button
                    type="button"
                    onClick={() => void toggle(r)}
                    disabled={busy !== null}
                    className="border border-line px-3 py-1.5 text-[12px] text-ink hover:border-ink disabled:opacity-40"
                  >
                    {busy === r.clusterId ? '…' : r.pinned ? 'Release' : 'Pin this version'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {error && <p className="mt-3 text-xs text-warn">{error}</p>}
      </section>

      <section className="mb-8 rounded-xl border border-line bg-panel px-8 py-8">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-lg font-medium text-ink">What moved</h2>
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-faint">frontier changelog</span>
        </div>
        {entries.length === 0 ? (
          <p className="text-sm text-soft">
            Nothing has moved under you. When a measurement changes what serves your requests, it
            appears here — and by email if you add a <code className="font-mono text-[12px]">frontier_moved</code> alert.
          </p>
        ) : (
          <ul className="flex flex-col gap-4">
            {entries.map((e) => (
              <li key={`${e.clusterId}-${e.toVersion}`} className="border-l-2 border-line pl-4">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="text-[14px] text-ink">{e.name}</span>
                  <span className="font-mono text-[11px] text-faint">
                    v{e.fromVersion} → v{e.toVersion} · {String(e.at).slice(0, 10)}
                  </span>
                  {e.kind === 'held-back' && (
                    <span className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-soft">
                      held back by your pin
                    </span>
                  )}
                </div>
                <p className="mt-1 text-[13px] leading-relaxed text-soft">{e.narrative}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
