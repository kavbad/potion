'use client';

// P1-7: the org-wide quality floor as a first-class settings surface.
// Reads the bound policy from /api/connection; admins move the floor via
// PUT /api/floor (a new policy row, every active key rebound — same shape
// as applying a learning proposal). Per-kind floors are shown read-only
// here; they come from measurement (/api/learning) and survive a change.
import { useCallback, useEffect, useState } from 'react';
import type { Policy } from '@/lib/types';

interface ConnPolicy {
  id: string;
  name: string;
  config: Policy;
  description: string;
}

export function FloorCard() {
  const [policy, setPolicy] = useState<ConnPolicy | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [role, setRole] = useState('viewer');
  const [editing, setEditing] = useState(false);
  const [floor, setFloor] = useState('0.95');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [meRes, connRes] = await Promise.all([
      fetch('/api/auth/me', { cache: 'no-store' }).catch(() => null),
      fetch('/api/connection', { cache: 'no-store' }).catch(() => null),
    ]);
    if (meRes?.ok) setRole(((await meRes.json()) as { role?: string }).role ?? 'viewer');
    if (connRes?.ok) {
      const body = (await connRes.json()) as { policy: ConnPolicy | null };
      setPolicy(body.policy);
      const cfg = body.policy?.config;
      if (cfg && (cfg.type === 'min_cost' || cfg.type === 'compound')) setFloor(cfg.qualityFloor.toFixed(2));
    }
    setLoaded(true);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function save() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/floor', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ qualityFloor: Number(floor) }),
      });
      const body = (await res.json()) as { keysRebound?: number; error?: { message?: string } };
      if (!res.ok) setError(body.error?.message ?? `save failed (${res.status})`);
      else {
        setEditing(false);
        setNotice(`Floor set. ${body.keysRebound} key${body.keysRebound === 1 ? '' : 's'} now serve at it.`);
        await load();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return null;
  const cfg = policy?.config ?? null;
  const currentFloor = cfg && (cfg.type === 'min_cost' || cfg.type === 'compound') ? cfg.qualityFloor : null;
  const clusterFloors = cfg && (cfg.type === 'min_cost' || cfg.type === 'compound') ? (cfg.clusterFloors ?? {}) : {};
  const kinds = Object.entries(clusterFloors).sort(([a], [b]) => a.localeCompare(b));
  const floorNum = Number(floor);
  const floorValid = !Number.isNaN(floorNum) && floorNum >= 0.5 && floorNum <= 1;

  return (
    <section className="mb-8 rounded-xl border border-line bg-panel px-8 py-8">
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="text-lg font-medium text-ink">Quality floor</h2>
        {role === 'admin' && (
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            className="rounded border border-line px-2 py-0.5 text-xs text-soft hover:text-ink"
          >
            {editing ? 'Cancel' : currentFloor !== null ? 'Edit' : 'Set a floor'}
          </button>
        )}
      </div>

      {currentFloor !== null ? (
        <div className="flex items-baseline gap-4">
          <span className="text-[2.4rem] font-medium tracking-[-0.02em] text-ink">{currentFloor.toFixed(2)}</span>
          <p className="max-w-md text-sm leading-relaxed text-soft">
            Every request is served by the cheapest option measured at or above this score on its kind
            of work. Raising it buys quality; lowering it buys savings.
          </p>
        </div>
      ) : cfg ? (
        <p className="max-w-md text-sm leading-relaxed text-soft">
          {policy!.description} This policy has no quality floor; setting one here replaces it with a
          floor-based policy{cfg.type === 'latency_bound' ? ' that keeps the latency bound' : ''}.
        </p>
      ) : (
        <p className="max-w-md text-sm leading-relaxed text-soft">
          No policy is bound yet — requests route at the platform default floor of 0.95. Setting a
          floor here creates your policy and binds it to your keys.
        </p>
      )}

      {kinds.length > 0 && (
        <div className="mt-6">
          <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.16em] text-faint">
            Measured bars per kind of work
          </div>
          <div className="flex flex-wrap gap-2">
            {kinds.map(([k, v]) => (
              <span key={k} className="rounded border border-line bg-paper px-2.5 py-1 text-xs text-soft">
                {k} <span className="font-medium text-ink">{v.toFixed(2)}</span>
              </span>
            ))}
          </div>
          <p className="mt-2 max-w-md text-xs leading-relaxed text-faint">
            These come from measuring your own workloads and override the default floor for their kind
            of work. They survive a change to the default.
          </p>
        </div>
      )}

      {editing && (
        <div className="mt-6 flex flex-wrap items-end gap-3 rounded-lg border border-line bg-paper px-4 py-4">
          <label className="text-xs text-faint">
            Floor (0.50–1.00)
            <input
              type="number"
              min="0.5"
              max="1"
              step="0.01"
              value={floor}
              onChange={(e) => setFloor(e.target.value)}
              className="mt-1 block w-28 rounded-md border border-line bg-panel px-3 py-2 text-sm text-ink"
            />
          </label>
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy || !floorValid}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Set the floor'}
          </button>
          <span className="text-xs text-faint">Applies to every active key immediately.</span>
        </div>
      )}
      {error && <p className="mt-3 text-xs text-warn">{error}</p>}
      {notice && <p className="mt-3 text-xs text-accent">{notice}</p>}
    </section>
  );
}
