// The coverage ratchet report (Observatory rung 5, 2026-08-23): a monthly
// artifact computed from what the Observatory already wrote — run records,
// the ledger, the measured roster — so the "28 → 45 in 30 days, ≤ $40/mo"
// target is a number that moves or does not, in writing, every week.
import { readFileSync } from 'node:fs';

export const RATCHET_TARGET = { start: 28, end: 45, days: 30, from: '2026-08-20T00:00:00Z', envelopeUsd: 50 } as const;

export interface RatchetRun {
  week: string; at: string; spendUsd: number;
  canaries: { clusterId: string; model: string; verdict: string; spendUsd: number }[];
  auditions: { alias: string; clusterId: string; lane: string; earnedSlot: boolean; spendUsd: number }[];
  catalogue?: { listings?: number; newSinceRegistry?: number; freeTierExcluded?: number; ranked?: unknown[] };
}
export interface RatchetLedgerRow { at: string; week: string; lane: string; spendUsd: number; detail: string }

export function ratchetReport(runs: RatchetRun[], ledger: RatchetLedgerRow[], roster: string[], now: Date): string {
  const month = now.toISOString().slice(0, 7);
  const inMonth = (iso: string) => iso.slice(0, 7) === month;
  const monthRuns = runs.filter((r) => inMonth(r.at)).sort((a, b) => a.at.localeCompare(b.at));
  const monthLedger = ledger.filter((r) => inMonth(r.at));
  const spendByLane = new Map<string, number>();
  for (const r of monthLedger) spendByLane.set(r.lane, (spendByLane.get(r.lane) ?? 0) + r.spendUsd);
  const monthSpend = [...spendByLane.values()].reduce((a, b) => a + b, 0);
  const canaries = monthRuns.flatMap((r) => r.canaries);
  const drift = canaries.filter((c) => c.verdict !== 'ok');
  const auditions = monthRuns.flatMap((r) => r.auditions);
  const earned = auditions.filter((a) => a.earnedSlot);
  const watched = new Set(canaries.map((c) => `${c.clusterId}/${c.model}`));
  const elapsedDays = Math.max(1, Math.round((now.getTime() - Date.parse(RATCHET_TARGET.from)) / 86_400_000));
  const expected = Math.min(RATCHET_TARGET.end, RATCHET_TARGET.start + ((RATCHET_TARGET.end - RATCHET_TARGET.start) * Math.min(elapsedDays, RATCHET_TARGET.days)) / RATCHET_TARGET.days);
  const lines = [
    `# Coverage ratchet — ${month}`,
    ``,
    `Generated ${now.toISOString()} from ${monthRuns.length} weekly run record(s) and ${monthLedger.length} ledger row(s).`,
    ``,
    `## The number`,
    ``,
    `| | |`,
    `|---|---|`,
    `| Measured roster now | **${roster.length}** models |`,
    `| Ratchet | ${RATCHET_TARGET.start} → ${RATCHET_TARGET.end} over ${RATCHET_TARGET.days} days from 2026-08-20 |`,
    `| Where the line says we should be today | ${expected.toFixed(1)} |`,
    `| Status | ${roster.length >= expected ? 'on or ahead of the line' : `**behind by ${(expected - roster.length).toFixed(1)}**`} |`,
    ``,
    `## What the month bought`,
    ``,
    `| Lane | Spend |`,
    `|---|---|`,
    ...[...spendByLane.entries()].sort().map(([lane, usd]) => `| ${lane} | $${usd.toFixed(2)} |`),
    `| **total** | **$${monthSpend.toFixed(2)}** of the $${RATCHET_TARGET.envelopeUsd.toFixed(0)} envelope |`,
    ``,
    `- Canaries: ${canaries.length} checks on ${watched.size} model×cluster pairs; ${drift.length} drift alarm${drift.length === 1 ? '' : 's'}${drift.length ? ` (${drift.map((d) => `${d.clusterId}/${d.model}: ${d.verdict}`).join('; ')})` : ''}.`,
    `- Auditions: ${auditions.length} tried, ${earned.length} earned a slot${earned.length ? ` (${earned.map((a) => `${a.alias} on ${a.clusterId}`).join('; ')})` : ''}.`,
    `- Cost per earned slot: ${earned.length ? `$${(auditions.reduce((s, a) => s + a.spendUsd, 0) / earned.length).toFixed(2)}` : 'n/a — nothing earned yet'}.`,
    ``,
    `## Weeks`,
    ``,
    `| Week | Canaries (drift) | Auditions (earned) | New listings seen | Spend |`,
    `|---|---|---|---|---|`,
    ...monthRuns.map((r) => `| ${r.week} | ${r.canaries.length} (${r.canaries.filter((c) => c.verdict !== 'ok').length}) | ${r.auditions.length} (${r.auditions.filter((a) => a.earnedSlot).length}) | ${r.catalogue?.newSinceRegistry ?? '—'} | $${r.spendUsd.toFixed(2)} |`),
    ``,
    `## Reading it honestly`,
    ``,
    `- The roster grows only when an audition earns a slot on a measured frontier; "tried" is spend, not coverage.`,
    `- A drift alarm is a stored quality the canary no longer reproduces within its interval — it triggers a re-measure, it is not itself a verdict.`,
    `- The envelope is a hard belt; a month that ends under it with no slots earned is a null result worth publishing, not a failure to hide.`,
    ``,
  ];
  return lines.join('\n');
}

export function measuredRoster(pricesPath: string): string[] {
  const t = JSON.parse(readFileSync(pricesPath, 'utf8')) as { entries: { alias: string; provider: string }[] };
  return t.entries.filter((e) => e.provider !== 'mock' && !/-class$/.test(e.alias)).map((e) => e.alias);
}

