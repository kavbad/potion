// Frontier Notes — assemble, gate, and write an issue (docs/FRONTIER-NOTES.md).
//
// The issue is a file: `${dir}/<week>.json` (the dashboard renders it) and
// `${dir}/<week>.md` (a human-readable copy). Held issues are written too,
// with status 'held' and the reason, so a failed week is visible rather
// than silent. The redaction pass runs over EVERY string that can reach the
// page, including the fact sheet's own names.

import { mkdirSync, writeFileSync } from 'node:fs';
import { assertPublishable } from './redact.js';
import type { FactSheet, Issue } from './types.js';
import { METHOD_NOTE, type Draft } from './write.js';

export const DEFAULT_BYLINE = 'Potion Research';

/**
 * The issue's address is its week, full stop: `2026-w34`. A title-derived
 * slug changed every time an issue was regenerated, so links and search
 * entries went stale within the day. Titles live in the page, not the URL.
 */
export function issueSlug(week: string, _title?: string): string {
  return week.toLowerCase();
}

export interface AssembleOptions {
  byline?: string;
  publishedAt: string;
  writer: Issue['writer'];
  gate: boolean;
  extraNeverName?: readonly string[];
}

export function assembleIssue(facts: FactSheet, draft: Draft, opts: AssembleOptions): Issue {
  const base: Omit<Issue, 'status' | 'heldReason'> = {
    slug: issueSlug(facts.week, draft.title),
    week: facts.week,
    title: draft.title,
    summary: draft.summary,
    publishedAt: opts.publishedAt,
    byline: opts.byline ?? DEFAULT_BYLINE,
    plain: draft.plain,
    lede: draft.lede,
    frontierNote: draft.frontierNote,
    auditionNote: draft.auditionNote,
    mixingNote: draft.mixingNote,
    takeaway: draft.takeaway,
    method: METHOD_NOTE,
    faq: draft.faq,
    facts,
    writer: opts.writer,
  };
  try {
    assertPublishable(publishableText(base), opts.extraNeverName);
  } catch (e) {
    return { ...base, status: 'held', heldReason: e instanceof Error ? e.message : String(e) };
  }
  if (opts.gate) return { ...base, status: 'held', heldReason: 'FRONTIER_NOTES_GATE is set: awaiting operator release' };
  return { ...base, status: 'published' };
}

/** Every string that can reach a page, concatenated for the redaction pass. */
export function publishableText(i: Omit<Issue, 'status' | 'heldReason'>): string {
  const f = i.facts;
  return [
    i.title, i.summary, i.plain, i.lede, i.frontierNote, i.auditionNote, i.mixingNote, i.takeaway, i.method,
    ...i.faq.flatMap((x) => [x.q, x.a]),
    // F6: a daily ledger's paragraphs go through the SAME redaction pass.
    ...(i.body !== undefined ? [i.body] : []),
    ...(f?.frontier ?? []).map((c) => `${c.clusterId} ${c.pick}`),
    ...(f?.auditions ?? []).map((a) => `${a.alias} ${a.lane} ${a.clusterId} ${a.outcome}`),
    ...(f?.caveats ?? []),
  ].join('\n');
}

/** F6: the daily ledger renders as prose — no frontier table, no FAQ. */
function renderDailyMarkdown(i: Issue): string {
  return [
    `# ${i.title}`,
    '',
    `*Frontier Notes · daily · ${i.week} · ${i.byline}*${i.status === 'held' ? `\n\n> HELD: ${i.heldReason}` : ''}`,
    '',
    '## In plain words',
    '',
    i.plain,
    '',
    '## The ledger',
    '',
    ...(i.body ?? i.lede).split('\n\n').flatMap((p) => [p, '']),
    '## What it means for you',
    '',
    i.takeaway,
    '',
    ...(i.writer?.runId
      ? ['---', '', `*Written by ${i.byline} in a recorded worker run (${i.writer.runId}), $${i.writer.costUsd.toFixed(4)} metered.${i.writer.verifiedBy ? ` Verified by Auditor, a Potion research-integrity worker, in a recorded run (${i.writer.verifiedBy.runId}).` : ''}*`, '']
      : []),
  ].join('\n');
}

export function renderMarkdown(i: Issue): string {
  if (i.kind === 'daily' || i.facts === null) return renderDailyMarkdown(i);
  const f = i.facts;
  const q = (x: number) => x.toFixed(3);
  // 'drifted', never 'moved': a drift verdict means the canary left its
  // interval — the routed pick did NOT change (the v3 verdict semantics;
  // 'moved' implied a reroute that never happened).
  const rows = f.frontier.map(
    (c) => `| ${c.clusterId} | ${c.verdict === 'ok' ? 'held' : c.verdict === 'drift' ? 'drifted' : 'inconclusive'} | ${c.pick} | ${q(c.storedQuality)} ± ${q(c.storedCi95)} | ${c.observedMean === null ? '—' : q(c.observedMean)} (n=${c.n}) |`,
  );
  const lines = [
    `# ${i.title}`,
    '',
    `*Frontier Notes · ${i.week} · ${i.publishedAt.slice(0, 10)} · ${i.byline}*${i.status === 'held' ? `\n\n> HELD: ${i.heldReason}` : ''}`,
    '',
    '## In plain words',
    '',
    i.plain,
    '',
    i.lede,
    '',
    '## This week\'s frontiers',
    '',
    '| cluster | verdict | routed pick | stored quality | canary |',
    '|---|---|---|---|---|',
    ...rows,
    '',
    i.frontierNote,
    '',
    '## Auditions',
    '',
    i.auditionNote,
    '',
    '## Mixing',
    '',
    i.mixingNote,
    '',
    '## What it means for you',
    '',
    i.takeaway,
    '',
    '## Method',
    '',
    i.method,
    '',
    '## Numbers',
    '',
    `${f.numbers.canaries} canaries · ${f.numbers.clustersHeld} held · ${f.numbers.clustersMoved} drifted · ${f.numbers.inconclusive} inconclusive · ${f.numbers.itemsGraded} items graded · ${f.numbers.candidatesScreened} listings screened · ${f.numbers.candidatesMeasured} measured · $${f.numbers.spendUsd.toFixed(2)}`,
    '',
    '## Questions',
    '',
    ...i.faq.flatMap((x) => [`**${x.q}**`, '', x.a, '']),
    '## Caveats',
    '',
    ...f.caveats.map((c) => `- ${c}`),
    '',
    ...(i.writer?.runId
      ? [
          '---',
          '',
          `*Written by ${i.byline} in a recorded worker run (${i.writer.runId}), $${i.writer.costUsd.toFixed(4)} metered.${
            i.writer.verifiedBy ? ` Verified by Auditor, a Potion research-integrity worker, in a recorded run (${i.writer.verifiedBy.runId}).` : ''
          }*`,
          '',
        ]
      : []),
    ...(i.writer?.receipt
      ? [
          '---',
          '',
          `*Written through Potion's own API. Receipt: kind of work ${i.writer.receipt.cluster} · strategy ${i.writer.receipt.strategy8} · policy ${i.writer.receipt.policy} · ${i.writer.receipt.promptTokens + i.writer.receipt.completionTokens} tokens.*`,
          '',
        ]
      : []),
  ];
  return lines.join('\n');
}

export function writeIssue(dir: string, issue: Issue): { json: string; md: string } {
  mkdirSync(dir, { recursive: true });
  const json = `${dir}/${issue.week}.json`;
  const md = `${dir}/${issue.week}.md`;
  writeFileSync(json, JSON.stringify(issue, null, 1) + '\n');
  writeFileSync(md, renderMarkdown(issue));
  return { json, md };
}
