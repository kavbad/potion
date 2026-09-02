'use client';

// G2 rungs 1–3 — the discovered-structure block: what the org's consented
// samples reveal INSIDE each serving cluster, and the explicit adopt/retire
// controls that turn a MEASURED workload into routing (rung 3). Honest by
// construction: the exemplar IS a (redacted) real sample, cohesion is shown
// so the reader can weigh each group, every non-adopted row says it is not
// routed, and adoption only ever happens through the button — never because
// a clustering ran. Absent when nothing is discovered, never an empty frame.
import { useCallback, useEffect, useState } from 'react';

interface DiscoveredWorkloadDto {
  id: string;
  parentCluster: string;
  sampleCount: number;
  cohesion: number;
  exemplarText: string;
  status: string;
  windowDays: number;
  measurement: {
    servingModel: string;
    servingQuality: number;
    incumbentModel: string;
    incumbentQuality: number;
    retention: { mean: number; ci95?: [number, number] };
    items: number;
  } | null;
}

export function DiscoveredWorkloads() {
  const [rows, setRows] = useState<DiscoveredWorkloadDto[]>([]);
  const [admin, setAdmin] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [res, me] = await Promise.all([
      fetch('/api/workloads/discovered', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch('/api/auth/me', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    if (me) setAdmin((me as { role?: string }).role === 'admin');
    setRows(
      ((res as { workloads?: DiscoveredWorkloadDto[] } | null)?.workloads ?? []).filter(
        (w) => w.status === 'observed' || w.status === 'measured' || w.status === 'adopted',
      ),
    );
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function flip(w: DiscoveredWorkloadDto, action: 'adopt' | 'retire') {
    setBusy(w.id);
    setError(null);
    const res = await fetch(`/api/workloads/${encodeURIComponent(w.id)}/${action}`, { method: 'POST' }).catch(() => null);
    setBusy(null);
    if (!res?.ok) {
      const body = (await res?.json().catch(() => null)) as { error?: { message?: string } } | null;
      setError(body?.error?.message ?? `Could not ${action} — try again.`);
      return;
    }
    void load();
  }

  if (rows.length === 0) return null;
  const windowDays = rows[0]!.windowDays;
  const adoptedCount = rows.filter((w) => w.status === 'adopted').length;

  return (
    <div className="mt-10">
      <div className="flex items-baseline justify-between border-b border-[#d9d5cb] pb-2 font-mono text-[12px] uppercase tracking-[0.14em] text-faint">
        <span className="text-soft">What your traffic actually is</span>
        <span>observed on your samples · {windowDays}d{adoptedCount > 0 ? ` · ${adoptedCount} routed` : ' · not yet routed'}</span>
      </div>
      <ul className="mt-2 space-y-1.5">
        {rows.map((w) => (
          <li key={w.id} className="font-mono text-[12.5px] leading-snug">
            <div className="flex items-baseline gap-3">
              <span className="shrink-0 text-ink">{w.parentCluster}</span>
              {w.status === 'adopted' ? (
                <span className="shrink-0 text-[11px] uppercase tracking-[0.1em] text-kept">routing</span>
              ) : null}
              <span className="shrink-0 tabular-nums text-soft">{w.sampleCount} samples · cohesion {w.cohesion.toFixed(2)}</span>
              <span className="truncate text-faint">&ldquo;{w.exemplarText}&rdquo;</span>
            </div>
            {w.measurement !== null ? (
              <div className="mt-0.5 flex items-baseline gap-3 pl-4 text-[12px] tabular-nums text-soft">
                <span>
                  measured on {w.measurement.items} of these: serving ({w.measurement.servingModel}) retains{' '}
                  <span className="text-ink">{(w.measurement.retention.mean * 100).toFixed(1)}%</span>
                  {w.measurement.retention.ci95 ? (
                    <span className="text-faint"> (95% CI {(w.measurement.retention.ci95[0] * 100).toFixed(1)}–{(w.measurement.retention.ci95[1] * 100).toFixed(1)}%)</span>
                  ) : null}{' '}
                  of {w.measurement.incumbentModel} on this work
                </span>
                {admin && w.status === 'measured' ? (
                  <button
                    type="button"
                    onClick={() => void flip(w, 'adopt')}
                    disabled={busy !== null}
                    className="shrink-0 border border-ink px-2 py-0.5 text-[11px] text-ink hover:bg-ink hover:text-[#f4f2ec] disabled:opacity-40"
                  >
                    {busy === w.id ? 'adopting…' : 'route on this'}
                  </button>
                ) : null}
                {admin && w.status === 'adopted' ? (
                  <button
                    type="button"
                    onClick={() => void flip(w, 'retire')}
                    disabled={busy !== null}
                    className="shrink-0 border border-[#c4bfb2] px-2 py-0.5 text-[11px] text-soft hover:border-ink hover:text-ink disabled:opacity-40"
                  >
                    {busy === w.id ? 'retiring…' : 'hand back to parent'}
                  </button>
                ) : null}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {error && <p className="mt-2 font-mono text-[12px] text-warn">{error}</p>}
      <p className="mt-2 font-mono text-[12px] text-faint">
        the taxonomy is the prior; this is the structure your own requests reveal — routing by it happens only through the explicit control above, never silently
      </p>
    </div>
  );
}
