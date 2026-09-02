// Frontier Notes — the weekly step, callable from the Observatory script or
// standalone (scripts/frontier-notes-week.ts). Composes, writes, gates,
// writes the files, returns the issue and a one-line digest.
import type { Provider } from '@potion/providers';
import type { ObservatoryRun } from '../observatory.js';
import { auditorVerify } from './auditor.js';
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
  /** F1 (fleet R2): Auditor, the independent verifier. When set, Delta's
   * prose ships ONLY with a PASS verification record from an Auditor run —
   * no verdict (failed, parked, timed out, unparseable) is a fail for the
   * model-written draft, and the deterministic draft publishes instead. */
  auditor?: DeltaWriterOptions;
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
  // F1 (fleet R2): publish is gated on pass evidence. The typed verdict
  // outranks everything; no verdict at all is a fail for the model-written
  // draft. The deterministic draft is composed from the facts by code and
  // needs no verifier, so the note itself is never blocked.
  if (deltaWrote && o.auditor) {
    const v = await auditorVerify(facts, draft, o.auditor);
    if (v.verdict !== null && v.verdict.verdict === 'pass') {
      writer = { ...writer!, verifiedBy: { runId: v.verdict.runId, costUsd: v.verdict.meteredUsd } };
    } else {
      const why =
        v.verdict !== null
          ? `auditor run ${v.verdict.runId} FAILED the draft: ${
              v.verdict.requiredChanges.slice(0, 2).join('; ') ||
              v.verdict.checks.filter((c) => !c.ok).slice(0, 2).map((c) => c.claim).join('; ') ||
              'see the verification record'
            }`
          : (v.fallback ?? 'auditor produced no verdict');
      draft = deterministicDraft(facts);
      writer = null;
      deltaWrote = false;
      fallbackNote = fallbackNote ? `${fallbackNote}; ${why}` : why;
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
  const digest = `frontier notes ${issue.week}: ${issue.status.toUpperCase()} — "${issue.title}"${issue.status === 'held' ? ` (${issue.heldReason?.split('\n')[0]})` : ''}${writer ? ` · writer ${writer.model} $${writer.costUsd.toFixed(3)}` : ''}${writer?.runId ? ` · run ${writer.runId}` : ''}${writer?.verifiedBy ? ` · verified ${writer.verifiedBy.runId}` : ''}${fallbackNote ? ` · fallback: ${fallbackNote}` : ''}`;
  return { issue, files, digest };
}
