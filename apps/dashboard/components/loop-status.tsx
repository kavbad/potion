'use client';

// WHERE YOUR COMPILER IS RIGHT NOW (2026-09-02) — the flywheel, made legible
// while it spins.
//
// THE GAP THIS CLOSES. RouterArc teaches the loop, but it renders only in
// the no-traffic branch of the compiler home: the moment a customer has real
// traffic — the moment the loop actually starts running — every explanation
// of the background machinery disappeared. Sampling, shadow measurement,
// workload discovery and the holdout all proceed invisibly for days, and
// the honest absent-when-empty cards below read as "nothing is happening"
// rather than "this is underway". A loop nobody can see is a loop nobody
// trusts, and the features it feeds are the ones this product is for.
//
// HONESTY RULES:
//   · Every row is derived from LOADED data. A fetch that failed or has not
//     returned contributes no row — absence is never rendered as a zero,
//     and "off" is only ever printed when the server actually said off.
//   · Rows state what IS, plus the one next thing that will happen. No
//     projected dates, no progress bars against invented denominators.
//   · Each row points at the surface that acts on it, so the strip is a
//     map of the machinery rather than a second copy of it.
import { useEffect, useState } from 'react';
import Link from 'next/link';

interface LearningDto {
  samplingConsent: boolean;
  samples: Record<string, number>;
  proposals: Array<{ status?: string }>;
}
interface WorkloadDto {
  status: string;
}
interface HoldoutDto {
  /** The server's field name is `enabled` — not `consent`. Reading the
   * wrong key printed "off" for every org regardless of the truth. */
  enabled: boolean;
  rate: number;
  /** False when no designated incumbent resolves to a servable priced
   * model — the holdout CANNOT run, so "switch it on" is wrong advice. */
  eligible?: boolean;
  why?: string;
}

export interface LoopRow {
  key: string;
  label: string;
  detail: string;
  href: string;
  /** true when this row is the one waiting on a human. */
  needsYou?: boolean;
}

/** Pure row derivation, so what the strip claims is testable without a DOM.
 * Each input may be null (not loaded / failed) and contributes nothing. */
export function loopRows(input: {
  learning: LearningDto | null;
  workloads: WorkloadDto[] | null;
  holdout: HoldoutDto | null;
  hasOutcomes: boolean | null;
  hasShadow: boolean | null;
}): LoopRow[] {
  const rows: LoopRow[] = [];

  if (input.learning !== null) {
    const total = Object.values(input.learning.samples).reduce((a, b) => a + b, 0);
    const kinds = Object.values(input.learning.samples).filter((n) => n > 0).length;
    const open = input.learning.proposals.filter((p) => p.status === undefined || p.status === 'proposed').length;
    if (!input.learning.samplingConsent) {
      rows.push({
        key: 'sampling',
        label: 'reading your traffic',
        detail: 'off — the compiler runs on platform evidence until you allow a sample',
        href: '/settings/controls',
        needsYou: true,
      });
    } else {
      rows.push({
        key: 'sampling',
        label: 'reading your traffic',
        detail:
          total === 0
            ? 'on — starts with your first requests'
            : `${total} sample${total === 1 ? '' : 's'} across ${kinds} kind${kinds === 1 ? '' : 's'} of work`,
        href: '/settings/controls',
      });
    }
    if (open > 0) {
      rows.push({
        key: 'bars',
        label: 'quality bars proposed',
        detail: `${open} waiting on you`,
        href: '/',
        needsYou: true,
      });
    }
  }

  if (input.hasShadow === true) {
    rows.push({
      key: 'shadow',
      label: 'testing alternatives',
      detail: 'candidates scored on your own traffic, after your answer went out',
      href: '/',
    });
  }

  if (input.workloads !== null && input.workloads.length > 0) {
    const measured = input.workloads.filter((w) => w.status === 'measured').length;
    const adopted = input.workloads.filter((w) => w.status === 'adopted').length;
    const observed = input.workloads.filter((w) => w.status === 'observed').length;
    const parts: string[] = [];
    if (adopted > 0) parts.push(`${adopted} routed`);
    if (measured > 0) parts.push(`${measured} measured, ready to route`);
    if (observed > 0) parts.push(`${observed} still being watched`);
    rows.push({
      key: 'workloads',
      label: 'your own kinds of work',
      detail: parts.join(' · '),
      href: '/',
      needsYou: measured > 0,
    });
  }

  if (input.hasOutcomes !== null) {
    rows.push(
      input.hasOutcomes
        ? { key: 'outcomes', label: "your app's verdicts", detail: 'arriving — the compiler can now learn from ground truth, not judges alone', href: '/' }
        : { key: 'outcomes', label: "your app's verdicts", detail: 'none yet — one line wires the strongest evidence there is', href: '/docs#outcomes', needsYou: true },
    );
  }

  if (input.holdout !== null) {
    const running = input.holdout.enabled && input.holdout.rate > 0;
    const blocked = input.holdout.eligible === false;
    rows.push({
      key: 'holdout',
      label: 'verified savings',
      detail: running
        ? `on — ${(input.holdout.rate * 100).toFixed(1)}% of traffic runs your old model as a live baseline`
        : blocked
          // Never tell someone to flip a switch that cannot do anything:
          // without a servable named incumbent there is no baseline to run.
          ? `needs a model to compare against — ${input.holdout.why ?? 'no incumbent designated'}`
          : 'off — savings stay projected until a live baseline proves them',
      href: blocked ? '/settings/controls' : '/usage',
      needsYou: !running,
    });
  }

  return rows;
}

export function LoopStatus({
  hasOutcomes,
  hasShadow,
}: {
  /** null until the plan document has loaded. */
  hasOutcomes: boolean | null;
  hasShadow: boolean | null;
}) {
  const [learning, setLearning] = useState<LearningDto | null>(null);
  const [workloads, setWorkloads] = useState<WorkloadDto[] | null>(null);
  const [holdout, setHoldout] = useState<HoldoutDto | null>(null);

  useEffect(() => {
    const j = (u: string) =>
      fetch(u, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    void j('/api/learning').then((b) => b && setLearning(b as LearningDto));
    void j('/api/workloads/discovered').then((b) => b && setWorkloads((b as { workloads?: WorkloadDto[] }).workloads ?? []));
    void j('/api/holdout').then((b) => b && setHoldout(b as HoldoutDto));
  }, []);

  const rows = loopRows({ learning, workloads, holdout, hasOutcomes, hasShadow });
  if (rows.length === 0) return null;

  return (
    <section className="mt-10" data-testid="loop-status">
      <div className="flex items-baseline justify-between border-b border-[#d9d5cb] pb-2 font-mono text-[12px] uppercase tracking-[0.14em] text-faint">
        <span className="text-soft">What your compiler is doing right now</span>
        <Link href="/docs#first-weeks" className="text-faint hover:text-ink">how the loop works</Link>
      </div>
      <ul className="mt-2 space-y-1.5">
        {rows.map((r) => (
          <li key={r.key} className="flex flex-wrap items-baseline gap-x-3 font-mono text-[12.5px] leading-snug">
            <span className="shrink-0 text-ink">{r.label}</span>
            <span className="text-soft">{r.detail}</span>
            <Link href={r.href} className={`shrink-0 ${r.needsYou ? 'text-accent hover:underline' : 'text-faint hover:text-ink'}`}>
              {r.needsYou ? 'act →' : 'look →'}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
