'use client';

// Budget autopilot card (M4 #35, SPEC §13.7): cap line + month-end forecast
// + hard-stop toggle on /reports. Reads GET /api/budgets; admins edit the
// cap / warn threshold / hard-stop inline (PUT). The progress bar shows MTD
// against the cap with the forecast as a ghost extension; state colors the
// card (ok ink, warn amber, exceeded red-amber).
import { useCallback, useEffect, useState } from 'react';
import { formatUsd } from '@/lib/usage-chart';

interface BudgetState {
  budget: { monthlyCapUsd: number; hardStop: boolean; warnPct: number; updatedAt: string } | null;
  mtdUsd: number;
  forecastUsd: number;
  warnAtUsd: number | null;
  state: 'ok' | 'warn' | 'exceeded' | 'unconfigured';
}

export function BudgetCard() {
  const [data, setData] = useState<BudgetState | null>(null);
  const [role, setRole] = useState<string>('viewer');
  const [editing, setEditing] = useState(false);
  const [cap, setCap] = useState('');
  const [warnPct, setWarnPct] = useState('80');
  const [hardStop, setHardStop] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [meRes, res] = await Promise.all([
      fetch('/api/auth/me', { cache: 'no-store' }).catch(() => null),
      fetch('/api/budgets', { cache: 'no-store' }).catch(() => null),
    ]);
    if (meRes?.ok) {
      const me = (await meRes.json()) as { role?: string };
      setRole(me.role ?? 'viewer');
    }
    if (res?.ok) {
      const body = (await res.json()) as BudgetState;
      setData(body);
      if (body.budget) {
        setCap(String(body.budget.monthlyCapUsd));
        setWarnPct(String(body.budget.warnPct));
        setHardStop(body.budget.hardStop);
      }
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/budgets', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          monthlyCapUsd: Number(cap),
          warnPct: Number(warnPct),
          hardStop,
        }),
      });
      const body = (await res.json()) as { error?: { message?: string } };
      if (!res.ok) {
        setError(body.error?.message ?? `save failed (${res.status})`);
      } else {
        setEditing(false);
        await load();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!data) return null;

  const capUsd = data.budget?.monthlyCapUsd ?? null;
  const pct = capUsd ? Math.min(100, (data.mtdUsd / capUsd) * 100) : 0;
  const forecastPct = capUsd ? Math.min(100, (data.forecastUsd / capUsd) * 100) : 0;
  const warnPctOfCap = data.budget && data.warnAtUsd ? (data.warnAtUsd / capUsd!) * 100 : 80;
  const barColor =
    data.state === 'exceeded' ? 'bg-warn' : data.state === 'warn' ? 'bg-warn' : 'bg-accent';

  return (
    <section className="mb-8 rounded-xl border border-line bg-panel px-8 py-8">
      <div className="mb-6 flex items-baseline justify-between">
        <h2 className="text-lg font-medium text-ink">Budget autopilot</h2>
        <span className="flex items-center gap-3 text-xs text-faint">
          {data.budget?.hardStop ? (
            <span className="rounded-full border border-warn bg-amber-50 px-2 py-0.5 text-[11.5px] font-semibold tracking-wide text-warn">
              HARD STOP
            </span>
          ) : null}
          {data.state !== 'unconfigured' ? <span>{data.state.toUpperCase()}</span> : null}
          {role === 'admin' ? (
            <button
              type="button"
              onClick={() => setEditing((v) => !v)}
              className="rounded border border-line px-2 py-0.5 text-soft hover:text-ink"
            >
              {editing ? 'Cancel' : data.budget ? 'Edit' : 'Set a budget'}
            </button>
          ) : null}
        </span>
      </div>

      {data.budget === null ? (
        <p className="text-sm text-soft">
          No monthly budget. Set one and Potion watches month-to-date spend against it — warnings
          at your threshold, an optional hard stop at the cap, and anomaly alerts on unusual
          spikes.
        </p>
      ) : (
        <div>
          <div className="mb-2 flex items-baseline justify-between text-sm">
            <span className="text-soft">
              Month to date:{' '}
              <span className="font-medium text-ink">{formatUsd(data.mtdUsd)}</span> of{' '}
              <span className="font-medium text-ink">{formatUsd(capUsd!)}</span>
            </span>
            <span className="text-xs text-faint">
              forecast {formatUsd(data.forecastUsd)} by month end
            </span>
          </div>
          {/* cap line: MTD bar + forecast ghost + warn marker */}
          <div className="relative h-3 overflow-hidden rounded-full bg-paper">
            <div className={`absolute inset-y-0 left-0 ${barColor}`} style={{ width: `${pct}%` }} />
            <div
              className="absolute inset-y-0 border-r border-dashed border-faint"
              style={{ left: `${forecastPct}%` }}
            />
            <div
              className="absolute inset-y-0 border-r-2 border-warn"
              style={{ left: `${warnPctOfCap}%` }}
            />
          </div>
          <div className="mt-2 flex justify-between text-[12px] text-faint">
            <span>warn at {formatUsd(data.warnAtUsd ?? 0)}</span>
            <span>cap {formatUsd(capUsd!)}</span>
          </div>
        </div>
      )}

      {editing ? (
        <div className="mt-6 flex flex-wrap items-end gap-3 rounded-lg border border-line bg-paper px-4 py-4">
          <label className="text-xs text-faint">
            Monthly cap (USD)
            <input
              type="number"
              min="1"
              step="1"
              value={cap}
              onChange={(e) => setCap(e.target.value)}
              className="mt-1 block w-32 rounded-md border border-line bg-panel px-3 py-2 text-sm text-ink"
            />
          </label>
          <label className="text-xs text-faint">
            Warn at (% of cap)
            <input
              type="number"
              min="1"
              max="100"
              step="1"
              value={warnPct}
              onChange={(e) => setWarnPct(e.target.value)}
              className="mt-1 block w-24 rounded-md border border-line bg-panel px-3 py-2 text-sm text-ink"
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-soft">
            <input
              type="checkbox"
              checked={hardStop}
              onChange={(e) => setHardStop(e.target.checked)}
              className="accent-accent"
            />
            Hard stop at cap (429s)
          </label>
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy || Number(cap) <= 0 || Number.isNaN(Number(cap))}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
          {error ? <span className="text-xs text-warn">{error}</span> : null}
        </div>
      ) : null}
    </section>
  );
}
