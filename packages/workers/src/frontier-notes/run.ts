// Frontier Notes — the weekly step, callable from the Observatory script or
// standalone (scripts/frontier-notes-week.ts). Composes, writes, gates,
// writes the files, returns the issue and a one-line digest.
import type { Provider } from '@potion/providers';
import type { ObservatoryRun } from '../observatory.js';
import { composeFactSheet } from './compose.js';
import { deltaDraft, type DeltaWriterOptions } from './delta.js';
import { assembleIssue, writeIssue } from './publish.js';
import { loadReplaysFromStore, type StoreLike } from './replay-source.js';
import type { Issue } from './types.js';
import { deterministicDraft, modelDraft, potionDraft } from './write.js';

export interface FrontierNotesOptions {
  run: ObservatoryRun;
  db: StoreLike;
  pricesVersion: string;
  notesDir: string;
  now: Date;
  /** Omit to use the deterministic writer only. */
  writer?: { provider: Provider; model: string };
  /** Preferred: write THROUGH Potion's own API (the dogfood path). Falls back to `writer`, then deterministic. */
  potion?: { url: string; apiKey: string; model?: string; policy?: string; cluster?: string };
  /** F0 (docs/RESEARCH-FLEET.md): Delta, the persistent Worker writer — a
   * recorded lab run drafts the issue. Tried FIRST; potion → writer →
   * deterministic remain the fallback chain, so the note always publishes. */
  delta?: DeltaWriterOptions;
  byline?: string;
  gate?: boolean;
  extraNeverName?: readonly string[];
}

export async function runFrontierNotes(o: FrontierNotesOptions): Promise<{ issue: Issue; files: { json: string; md: string }; digest: string }> {
  const replays = await loadReplaysFromStore(o.db, o.pricesVersion);
  const facts = composeFactSheet(o.run, replays, o.extraNeverName !== undefined ? { extraNeverName: o.extraNeverName } : {});
  let draft = deterministicDraft(facts);
  let writer: Issue['writer'] = null;
  let fallbackNote: string | null = null;
  let deltaWrote = false;
  if (o.delta) {
    const r = await deltaDraft(facts, o.delta);
    fallbackNote = r.fallback;
    if (!r.fallback && r.receipt) {
      draft = r.draft;
      writer = { model: `delta:${o.delta.harnessHash.slice(0, 8)}`, costUsd: r.receipt.meteredUsd, runId: r.receipt.runId };
      deltaWrote = true;
    }
  }
  if (!writer && o.potion) {
    const r = await potionDraft(facts, o.potion);
    fallbackNote = fallbackNote ? `${fallbackNote}; ${r.fallback ?? ''}`.replace(/; $/, '') : r.fallback;
    if (!r.fallback) {
      draft = r.draft;
      writer = { model: `potion:${o.potion.model ?? 'potion-auto'}`, costUsd: 0, ...(r.receipt ? { receipt: r.receipt } : {}) };
    }
  }
  if (!writer && o.writer) {
    const r = await modelDraft(facts, { provider: o.writer.provider, model: o.writer.model });
    draft = r.draft;
    writer = { model: r.fallback ? 'deterministic' : o.writer.model, costUsd: r.costUsd };
    fallbackNote = fallbackNote ? `${fallbackNote}; ${r.fallback ?? ''}`.replace(/; $/, '') : r.fallback;
  }
  // The byline is a provenance claim: 'Delta' only when Delta's run wrote
  // the draft (the writer.runId is its evidence) — never on a fallback.
  const byline = o.byline ?? (deltaWrote ? 'Delta' : undefined);
  const issue = assembleIssue(facts, draft, {
    publishedAt: o.now.toISOString(),
    writer,
    gate: o.gate ?? false,
    ...(byline !== undefined ? { byline } : {}),
    ...(o.extraNeverName !== undefined ? { extraNeverName: o.extraNeverName } : {}),
  });
  const files = writeIssue(o.notesDir, issue);
  const digest = `frontier notes ${issue.week}: ${issue.status.toUpperCase()} — "${issue.title}"${issue.status === 'held' ? ` (${issue.heldReason?.split('\n')[0]})` : ''}${writer ? ` · writer ${writer.model} $${writer.costUsd.toFixed(3)}` : ''}${writer?.runId ? ` · run ${writer.runId}` : ''}${fallbackNote ? ` · fallback: ${fallbackNote}` : ''}`;
  return { issue, files, digest };
}
