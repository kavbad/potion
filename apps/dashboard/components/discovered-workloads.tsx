'use client';

// G2 rung 1 — the discovered-structure block: what the org's consented
// samples reveal INSIDE each serving cluster. Honest by construction: the
// exemplar IS a (redacted) real sample, cohesion is shown so the reader can
// weigh each group, and every row says "observed — not yet routed". Absent
// when nothing is discovered, never an empty frame.
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

  const load = useCallback(async () => {
    const res = await fetch('/api/workloads/discovered', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    setRows(((res as { workloads?: DiscoveredWorkloadDto[] } | null)?.workloads ?? []).filter((w) => w.status === 'observed' || w.status === 'measured'));
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (rows.length === 0) return null;
  const windowDays = rows[0]!.windowDays;

  return (
    <div className="mt-10">
      <div className="flex items-baseline justify-between border-b border-[#d9d5cb] pb-2 font-mono text-[12px] uppercase tracking-[0.14em] text-faint">
        <span className="text-soft">What your traffic actually is</span>
        <span>observed on your samples · {windowDays}d · not yet routed</span>
      </div>
      <ul className="mt-2 space-y-1.5">
        {rows.map((w) => (
          <li key={w.id} className="font-mono text-[12.5px] leading-snug">
            <div className="flex gap-3">
              <span className="shrink-0 text-ink">{w.parentCluster}</span>
              <span className="shrink-0 tabular-nums text-soft">{w.sampleCount} samples · cohesion {w.cohesion.toFixed(2)}</span>
              <span className="truncate text-faint">&ldquo;{w.exemplarText}&rdquo;</span>
            </div>
            {w.measurement !== null ? (
              <div className="mt-0.5 pl-4 text-[12px] tabular-nums text-soft">
                measured on {w.measurement.items} of these: serving ({w.measurement.servingModel}) retains{' '}
                <span className="text-ink">{(w.measurement.retention.mean * 100).toFixed(1)}%</span>
                {w.measurement.retention.ci95 ? (
                  <span className="text-faint"> (95% CI {(w.measurement.retention.ci95[0] * 100).toFixed(1)}–{(w.measurement.retention.ci95[1] * 100).toFixed(1)}%)</span>
                ) : null}{' '}
                of {w.measurement.incumbentModel} on this work
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="mt-2 font-mono text-[12px] text-faint">
        the taxonomy is the prior; this is the structure your own requests reveal — routing by it comes as an explicit proposal, never silently
      </p>
    </div>
  );
}
