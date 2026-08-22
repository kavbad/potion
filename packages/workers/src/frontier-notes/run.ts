// Frontier Notes — the weekly step, callable from the Observatory script or
// standalone (scripts/frontier-notes-week.ts). Composes, writes, gates,
// writes the files, returns the issue and a one-line digest.
import type { Provider } from '@potion/providers';
import type { ObservatoryRun } from '../observatory.js';
import { composeFactSheet } from './compose.js';
import { assembleIssue, writeIssue } from './publish.js';
import { loadReplaysFromStore, type StoreLike } from './replay-source.js';
import type { Issue } from './types.js';
import { deterministicDraft, modelDraft } from './write.js';

export interface FrontierNotesOptions {
  run: ObservatoryRun;
  db: StoreLike;
  pricesVersion: string;
  notesDir: string;
  now: Date;
  /** Omit to use the deterministic writer only. */
  writer?: { provider: Provider; model: string };
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
  if (o.writer) {
    const r = await modelDraft(facts, { provider: o.writer.provider, model: o.writer.model });
    draft = r.draft;
    writer = { model: r.fallback ? 'deterministic' : o.writer.model, costUsd: r.costUsd };
    fallbackNote = r.fallback;
  }
  const issue = assembleIssue(facts, draft, {
    publishedAt: o.now.toISOString(),
    writer,
    gate: o.gate ?? false,
    ...(o.byline !== undefined ? { byline: o.byline } : {}),
    ...(o.extraNeverName !== undefined ? { extraNeverName: o.extraNeverName } : {}),
  });
  const files = writeIssue(o.notesDir, issue);
  const digest = `frontier notes ${issue.week}: ${issue.status.toUpperCase()} — "${issue.title}"${issue.status === 'held' ? ` (${issue.heldReason?.split('\n')[0]})` : ''}${writer ? ` · writer ${writer.model} $${writer.costUsd.toFixed(3)}` : ''}${fallbackNote ? ` · fallback: ${fallbackNote}` : ''}`;
  return { issue, files, digest };
}
