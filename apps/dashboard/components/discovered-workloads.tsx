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
}

export function DiscoveredWorkloads() {
  const [rows, setRows] = useState<DiscoveredWorkloadDto[]>([]);

  const load = useCallback(async () => {
    const res = await fetch('/api/workloads/discovered', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    setRows(((res as { workloads?: DiscoveredWorkloadDto[] } | null)?.workloads ?? []).filter((w) => w.status === 'observed'));
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
          <li key={w.id} className="flex gap-3 font-mono text-[12.5px] leading-snug">
            <span className="shrink-0 text-ink">{w.parentCluster}</span>
            <span className="shrink-0 tabular-nums text-soft">{w.sampleCount} samples · cohesion {w.cohesion.toFixed(2)}</span>
            <span className="truncate text-faint">&ldquo;{w.exemplarText}&rdquo;</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 font-mono text-[12px] text-faint">
        the taxonomy is the prior; this is the structure your own requests reveal — routing by it comes as an explicit proposal, never silently
      </p>
    </div>
  );
}
