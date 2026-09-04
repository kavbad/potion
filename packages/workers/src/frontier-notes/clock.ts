// Frontier Notes — THE CLOCK (F4 of the fleet, docs/RESEARCH-FLEET.md +
// docs/RESEARCH-OPS.md): the Tuesday chain as a server-side tick, so no
// operator machine is in the loop. The queue runs ONE worker at
// concurrency 1, so a job that waited on a lab:run would deadlock it —
// the clock therefore follows the reaper's pattern: an in-process
// 60-second tick advancing a durable state machine, one small step at a
// time. Every step is idempotent and every transition is written to the
// state file BEFORE its side effect is relied on.
//
// The chain per week, unchanged from the manual ceremony:
//   compose facts (from the observatory run + a fresh store copy)
//   → Delta run drafts (redacted facts attached)
//   → deterministic guards (counts, style, vague ratios)
//   → Auditor run verifies (typed record; no verdict = fail for prose)
//   → the publish gate (native decideAction on the author's grant)
//   → the issue lands in the notes dir (published, or held with the
//     supervisor question on a recorded gate session).
// Bounded retries; when the model chain exhausts its attempts the
// DETERMINISTIC draft publishes through the same gate — the note always
// ships, and model prose never ships unverified.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ObservatoryRun } from '../observatory.js';
import { composeFactSheet } from './compose.js';
import { parseDailyDraft, utcDay } from './daily.js';
import { generateAgenda, generateCatalogueAgenda, type AgendaCandidate, type CatalogueEntry, type ClusterSignal } from './agenda.js';
import { assemblePieceIssue, auditPieceNumbers, deterministicPiece } from './piece.js';
import { auditDraftCounts, auditVagueRatios, normalizeDraftText, redactFactsForWriter } from './delta.js';
import { parseVerdict } from './auditor.js';
import { lintDraft } from './lint.js';
import { assembleIssue, writeIssue } from './publish.js';
import { publishActionId, publishArgsHash } from './publisher.js';
import { loadReplaysFromStore, type StoreLike } from './replay-source.js';
import type { FactSheet, Issue } from './types.js';
import { deterministicDraft, parseDraft, type Draft } from './write.js';

export type ClockPhase = 'delta' | 'auditor' | 'gate-held' | 'done' | 'skipped' | 'awaiting-writer';

/** F8: the DAILY PIECE tick — Atlas picks, Delta writes, the corpus
 * remembers. The daily post is the top item on the agenda: a question
 * somebody is asking, answered with numbers we measured. It replaced the
 * LEDGER, which reported what the instruments DID — true, verified, and
 * worthless: nobody searches for "three cycles ran". */
export interface DailyIo {
  now(): Date;
  /** The measured corpus the agenda reasons over. */
  agendaSignals(): Promise<readonly ClusterSignal[]>;
  /** The priced catalogue — keeps the agenda fed on days nothing was
   * measured: 375 models move even when the instruments are quiet. */
  catalogueEntries?(): Promise<readonly CatalogueEntry[]>;
  /** Claims the published corpus already spent — the cooldown's memory. */
  publishedClaims(): Promise<ReadonlyMap<string, string>>;
  /** Today's measurement activity, for the provenance footer only. */
  measurementFooter(): Promise<string>;
  readIssue(day: string): Issue | null;
  writeIssueFiles(issue: Issue): void;
  startWorkerRun(harnessHash: string, attachment: { name: string; content: string }, extra?: { name: string; content: string }): Promise<string>;
  runTerminalState(runId: string): Promise<string | null>;
  readRunFile(runId: string, name: string): Promise<string | null>;
  readState(day: string): ClockState | null;
  writeState(state: ClockState, opts?: { exclusive?: boolean }): boolean;
  /** The daily writing generation. Null = publish the deterministic piece —
   * still a real answer to a real question, never a chore log. */
  deltaHarness: string | null;
  framingDeadlineMs?: number;
  /** How long a merely-LATE writer keeps its claim on the day (default 6h). */
  lateWriterCeilingMs?: number;
  log(line: string): void;
}

/**
 * One daily tick: the agenda decides, the writer writes, the laws check.
 *
 * NEVER MISSED AND NEVER PADDED. If the writer parks, fails, runs long, or
 * states a number outside its evidence, the deterministic piece publishes —
 * the agenda's own headline and dek, composed from the measurements, which
 * answer the same question. If the AGENDA is empty (nothing the corpus can
 * prove that has not just been said), NOTHING publishes: an empty agenda is
 * a real answer, and silence beats filler.
 */
export async function dailyPieceTick(io: DailyIo): Promise<string | null> {
  const day = utcDay(io.now());
  const state = io.readState(day);
  // Today is filed — unless it was filed WITHOUT its writer, in which case
  // the day stays open for the upgrade below (see THE LATE WRITER).
  if (io.readIssue(day) !== null && state?.phase !== 'awaiting-writer') return null;

  // THE LATE WRITER (found live 2026-09-04, run-d21f0a1b). The writer's run
  // did 95 seconds of work — after sitting 29 MINUTES in a queue that runs
  // one job at a time. The framing deadline was measuring queue latency and
  // calling it a slow writer, so the composed fallback published and the
  // finished draft was thrown away.
  //
  // Both things a reader deserves are now true: the day is filed on time
  // (the composed piece answers the same question), and the writer's prose
  // replaces it the moment the run lands and passes the laws. A writer that
  // is merely LATE no longer loses its piece; only one that is wrong does.
  if (state?.phase === 'awaiting-writer') {
    const filed = io.readIssue(day);
    const runId = state.deltaRunId;
    if (filed === null || runId === undefined || io.deltaHarness === null) {
      io.writeState({ ...state, phase: 'done' });
      return null;
    }
    const startedMs = Date.parse(state.startedAt);
    const abandon = Number.isFinite(startedMs) && io.now().getTime() - startedMs > (io.lateWriterCeilingMs ?? 6 * 60 * 60_000);
    const terminal = await io.runTerminalState(runId);
    if (terminal === null) {
      if (!abandon) return null;
      io.log(`fnotes daily ${day}: writer ${runId} never landed — the composed piece stands`);
      io.writeState({ ...state, phase: 'done' });
      return null;
    }
    // The writer is judged against the assignment it was GIVEN, not against
    // an agenda recomputed since — otherwise a measurement that landed while
    // it was queued would make its correct numbers look invented.
    const assigned = state.assignment;
    const text = terminal === 'completed' ? await io.readRunFile(runId, 'piece.json') : null;
    if (terminal === 'completed' && text === null && !abandon) return null; // read-after-write
    io.writeState({ ...state, phase: 'done' });
    if (text === null || assigned === undefined) {
      io.log(`fnotes daily ${day}: writer ${runId} ended ${terminal} with no usable piece — the composed piece stands`);
      return null;
    }
    const footer = await io.measurementFooter();
    const parsed = parseDailyDraft(normalizeDraftText(text), deterministicPiece(assigned, footer));
    const violation = parsed === null ? 'no usable piece.json' : (auditPieceNumbers(parsed, assigned, io.now()) ?? lintDraft({ ...parsed, faq: [] }));
    if (parsed === null || violation !== null) {
      io.log(`fnotes daily ${day}: late writer refused (${violation}) — the composed piece stands`);
      return null;
    }
    const upgraded = assemblePieceIssue(assigned, { ...parsed, mixingNote: '', auditionNote: footer, faq: [] }, day, {
      publishedAt: filed.publishedAt,
      byline: 'Delta',
      writer: { model: `delta:${io.deltaHarness.slice(0, 8)}`, costUsd: 0, runId },
    });
    io.writeIssueFiles(upgraded);
    io.log(`fnotes daily ${day}: ${upgraded.status.toUpperCase()} — the late writer's piece replaces the composed one (${runId})`);
    return 'daily-upgraded';
  }

  const published = await io.publishedClaims();
  const agenda = [
    ...generateAgenda({ signals: await io.agendaSignals(), published, now: io.now() }),
    ...(io.catalogueEntries ? generateCatalogueAgenda({ entries: await io.catalogueEntries(), published, now: io.now() }) : []),
  ].sort((a, b) => b.score - a.score);
  const candidate = agenda[0];
  if (candidate === undefined) {
    if (state === null) io.log(`fnotes daily ${day}: the agenda is empty — nothing provable left unsaid. Publishing nothing.`);
    io.writeState({ week: day, phase: 'done', startedAt: io.now().toISOString(), attempts: 0, note: 'empty agenda' });
    return 'agenda-empty';
  }

  if (state === null) {
    if (!io.writeState({ week: day, phase: 'delta', startedAt: io.now().toISOString(), attempts: 1, note: candidate.id }, { exclusive: true })) return null;
    if (io.deltaHarness !== null) {
      const runId = await io.startWorkerRun(io.deltaHarness, {
        name: 'assignment.json',
        content: JSON.stringify(
          { headline: candidate.headline, dek: candidate.dek, question: candidate.demandQuery, clusterId: candidate.clusterId, evidence: candidate.evidence },
          null,
          1,
        ),
      });
      io.writeState({ week: day, phase: 'delta', startedAt: io.now().toISOString(), attempts: 1, deltaRunId: runId, note: candidate.id, assignment: candidate });
      io.log(`fnotes daily ${day}: assigned "${candidate.headline}" to ${runId} (score ${candidate.score})`);
      return `daily-delta:${runId}`;
    }
    io.log(`fnotes daily ${day}: no writing generation — publishing the composed piece`);
  }
  if (state?.phase === 'done') return null;

  const footer = await io.measurementFooter();
  let draft = deterministicPiece(candidate, footer);
  let writer: Issue['writer'] = null;
  let note = `composed: ${candidate.id}`;
  let late = false;
  if (state?.deltaRunId) {
    const terminal = await io.runTerminalState(state.deltaRunId);
    const startedMs = Date.parse(state.startedAt);
    const overdue = Number.isFinite(startedMs) && io.now().getTime() - startedMs > (io.framingDeadlineMs ?? 20 * 60_000);
    if (terminal === null && !overdue) return null;
    const text = terminal === 'completed' ? await io.readRunFile(state.deltaRunId, 'piece.json') : null;
    if (terminal === 'completed' && text === null && !overdue) return null; // read-after-write
    const parsed = text !== null ? parseDailyDraft(normalizeDraftText(text), draft) : null;
    const violation =
      terminal === null
        ? `writing overdue (run ${state.deltaRunId})`
        : parsed === null
          ? `no usable piece.json (run ended ${terminal})`
          : (auditPieceNumbers(parsed, candidate, io.now()) ?? lintDraft({ ...parsed, faq: [] }));
    if (parsed !== null && violation === null && io.deltaHarness !== null) {
      draft = { ...parsed, mixingNote: '', auditionNote: footer, faq: [] };
      writer = { model: `delta:${io.deltaHarness.slice(0, 8)}`, costUsd: 0, runId: state.deltaRunId };
      note = `written by Delta (${state.deltaRunId}): ${candidate.id}`;
    } else {
      io.log(`fnotes daily ${day}: writing refused (${violation}) — the composed piece publishes`);
      // Late is not wrong. A writer that simply has not finished keeps its
      // claim on the day and replaces the composed piece when it lands.
      if (terminal === null) late = true;
    }
  }
  const issue = assemblePieceIssue(candidate, draft, day, {
    publishedAt: io.now().toISOString(),
    writer,
    ...(writer !== null ? { byline: 'Delta' } : {}),
  });
  io.writeIssueFiles(issue);
  io.writeState({
    week: day, startedAt: state?.startedAt ?? io.now().toISOString(), attempts: state?.attempts ?? 1, ...state,
    phase: late ? 'awaiting-writer' : 'done', note, ...(late ? { assignment: candidate } : {}),
  });
  io.log(`fnotes daily ${day}: ${issue.status.toUpperCase()} — "${issue.title}" (${note})`);
  return 'daily-published';
}


export interface ClockState {
  week: string;
  phase: ClockPhase;
  startedAt: string;
  /** Draft attempts spent (Delta runs started). */
  attempts: number;
  deltaRunId?: string;
  auditorRunId?: string;
  /** Set when the model chain exhausted its attempts and the
   * deterministic draft is the one moving through the gate. */
  deterministic?: boolean;
  gateRunId?: string;
  gateActionId?: string;
  argsHash?: string;
  /** F8: the agenda candidate the writer was handed. A late draft is judged
   * against ITS OWN assignment, never against an agenda recomputed since. */
  assignment?: AgendaCandidate;
  note?: string;
}

/** Everything the tick touches, injectable so the machine is testable
 * without a database. The server wires the real implementations. */
export interface ClockIO {
  now(): Date;
  /** The observatory run JSON for a week, or null. */
  readObservatoryRun(week: string): ObservatoryRun | null;
  /** Compose the week's facts (opens a fresh store copy). */
  composeFacts(run: ObservatoryRun): Promise<FactSheet>;
  /** Notes-dir issue lookup (any status). */
  readIssue(week: string): Issue | null;
  writeIssueFiles(issue: Issue): void;
  readState(week: string): ClockState | null;
  /** Create-exclusive on first write (two replicas must not both start). */
  writeState(state: ClockState, opts?: { exclusive?: boolean }): boolean;
  /** Start a worker run with one attachment; returns the runId. */
  startWorkerRun(harnessHash: string, attachment: { name: string; content: string }, extra?: { name: string; content: string }): Promise<string>;
  /** Terminal state of a run, or null while it is still going. */
  runTerminalState(runId: string): Promise<string | null>;
  /** A named file from the run's workspace, or null. */
  readRunFile(runId: string, name: string): Promise<string | null>;
  /** Native gate ask for the publish act (the pore's decision block). */
  gateAsk(argsHash: string, actionId: string, summary: string): Promise<{ decision: 'allow' | 'hold' | 'blocked'; audit?: boolean; question?: string; gateRunId: string }>;
  /** The operator's recorded fingerprint-bound answer, when one exists. */
  gateResolution(gateRunId: string, actionId: string): Promise<'approved' | 'rejected' | null>;
  /** Record the executed publish on the gate session (outcome stream). */
  gateOutcome(gateRunId: string, actionId: string, argsHash: string, ok: boolean): Promise<void>;
  deltaHarness: string;
  auditorHarness: string;
  /** Max Delta drafting attempts before the deterministic draft ships. */
  maxAttempts?: number;
  log(line: string): void;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** ISO week id ('2026-W36') for a date. */
export function isoWeekOf(d: Date): string {
  const u = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = u.getUTCDay() || 7;
  u.setUTCDate(u.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(u.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((u.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${u.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** True from Tuesday 06:00 America/Los_Angeles until the week ends. */
export function inTuesdayWindow(d: Date): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'short',
    hour: 'numeric',
    hour12: false,
  }).formatToParts(d);
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? '';
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const order = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const idx = order.indexOf(weekday);
  if (idx < 1) return false; // Monday (or unknown) — measurement day
  if (idx === 1) return hour >= 6; // Tuesday from 06:00 PT
  return true; // Wednesday onward: still this week's window
}

/** One tick: observe, take at most one small step, return what happened. */
export async function frontierNotesTick(io: ClockIO): Promise<string | null> {
  const week = isoWeekOf(io.now());
  let state = io.readState(week);

  // ---- start guard ----
  if (state === null) {
    if (!inTuesdayWindow(io.now())) return null;
    if (io.readIssue(week) !== null) return null; // already produced (manually or earlier)
    const run = io.readObservatoryRun(week);
    if (run === null) return null; // Monday's measurement has not landed
    state = { week, phase: 'delta', startedAt: io.now().toISOString(), attempts: 0 };
    if (!io.writeState(state, { exclusive: true })) return null; // another replica started
    io.log(`fnotes ${week}: window open, observatory run present — starting the chain`);
  }

  if (state.phase === 'done' || state.phase === 'skipped') return null;
  const run = io.readObservatoryRun(week);
  if (run === null) return null;
  const facts = await io.composeFacts(run);
  const maxAttempts = io.maxAttempts ?? 4;

  // ---- drafting: start or collect a Delta run ----
  if (state.phase === 'delta') {
    if (!state.deltaRunId) {
      if (state.attempts >= maxAttempts) {
        state = { ...state, deterministic: true, phase: 'auditor' };
        io.writeState(state);
        io.log(`fnotes ${week}: ${maxAttempts} draft attempts spent — the deterministic draft moves to the gate`);
        return 'deterministic';
      }
      const runId = await io.startWorkerRun(io.deltaHarness, {
        name: 'facts.json',
        content: JSON.stringify(redactFactsForWriter(facts), null, 1),
      });
      state = { ...state, deltaRunId: runId, attempts: state.attempts + 1 };
      io.writeState(state);
      io.log(`fnotes ${week}: Delta drafting in ${runId} (attempt ${state.attempts})`);
      return `delta:${runId}`;
    }
    const terminal = await io.runTerminalState(state.deltaRunId);
    if (terminal === null) return null; // still running — the reaper owns stranded runs
    const text = terminal === 'completed' ? await io.readRunFile(state.deltaRunId, 'draft.json') : null;
    const parsed = text !== null ? parseDraft(normalizeDraftText(text), deterministicDraft(facts)) : null;
    const violation =
      parsed === null
        ? `run ${state.deltaRunId} ended ${terminal}${text === null && terminal === 'completed' ? ' without draft.json' : ''}`
        : (auditDraftCounts(parsed, facts) ?? lintDraft(parsed) ?? auditVagueRatios(parsed, facts));
    if (parsed === null || violation !== null) {
      io.log(`fnotes ${week}: draft refused — ${violation}`);
      state = { ...state, deltaRunId: undefined as never };
      delete state.deltaRunId;
      io.writeState(state);
      return 'draft-refused';
    }
    state = { ...state, phase: 'auditor' };
    delete state.auditorRunId;
    io.writeState(state);
    return 'draft-accepted';
  }

  // The draft under audit/gate: Delta's (re-read from the run record so a
  // restart never trusts memory) or the deterministic one.
  const draft: Draft | null = state.deterministic
    ? deterministicDraft(facts)
    : await (async () => {
        const t = state!.deltaRunId ? await io.readRunFile(state!.deltaRunId, 'draft.json') : null;
        return t !== null ? parseDraft(normalizeDraftText(t), deterministicDraft(facts)) : null;
      })();
  if (draft === null) {
    state = { ...state, phase: 'delta' };
    delete state.deltaRunId;
    io.writeState(state);
    return 'draft-lost';
  }

  // ---- verification: start or collect an Auditor run ----
  if (state.phase === 'auditor') {
    if (state.deterministic) {
      // Composed from the facts by code — needs no verifier; straight to the gate.
      return gatePhase();
    }
    if (!state.auditorRunId) {
      const runId = await io.startWorkerRun(
        io.auditorHarness,
        { name: 'facts.json', content: JSON.stringify(redactFactsForWriter(facts), null, 1) },
        { name: 'draft.json', content: JSON.stringify(draft, null, 1) },
      );
      state = { ...state, auditorRunId: runId };
      io.writeState(state);
      io.log(`fnotes ${week}: Auditor verifying in ${runId}`);
      return `auditor:${runId}`;
    }
    const terminal = await io.runTerminalState(state.auditorRunId);
    if (terminal === null) return null;
    const text = terminal === 'completed' ? await io.readRunFile(state.auditorRunId, 'verdict.json') : null;
    const verdict = text !== null ? parseVerdict(text) : null;
    if (verdict === null || verdict.verdict !== 'pass') {
      // No verdict or a fail — either way the model draft does not ship.
      const why = verdict === null ? `no verification record (run ${state.auditorRunId} ended ${terminal})` : `FAILED: ${verdict.requiredChanges[0] ?? 'see the record'}`;
      io.log(`fnotes ${week}: ${why} — back to drafting`);
      state = { ...state, phase: 'delta' };
      delete state.deltaRunId;
      delete state.auditorRunId;
      io.writeState(state);
      return 'verification-failed';
    }
    return gatePhase();
  }

  if (state.phase === 'gate-held') return gatePhase();
  return null;

  // ---- the publish gate + landing ----
  async function gatePhase(): Promise<string> {
    const argsHash = publishArgsHash(week, draft!);
    const actionId = publishActionId(week, argsHash);
    let decision: { decision: 'allow' | 'hold' | 'blocked'; audit?: boolean; question?: string; gateRunId: string };
    // A recorded operator answer on this exact fingerprint decides first.
    const prior = state!.gateRunId ? await io.gateResolution(state!.gateRunId, actionId) : null;
    if (prior === 'approved') decision = { decision: 'allow', gateRunId: state!.gateRunId! };
    else if (prior === 'rejected') decision = { decision: 'blocked', question: 'rejected by supervisor', gateRunId: state!.gateRunId! };
    else decision = await io.gateAsk(argsHash, actionId, `Publish Frontier Notes ${week}: "${draft!.title.slice(0, 140)}"`);

    const writerBase = state!.deterministic
      ? null
      : { model: `delta:${io.deltaHarness.slice(0, 8)}`, costUsd: 0, runId: state!.deltaRunId!, ...(state!.auditorRunId ? { verifiedBy: { runId: state!.auditorRunId, costUsd: 0 } } : {}) };
    const assembled = assembleIssue(facts, draft!, {
      publishedAt: io.now().toISOString(),
      writer: writerBase,
      gate: false,
      ...(state!.deterministic ? {} : { byline: 'Delta' }),
    });

    if (decision.decision === 'allow' && assembled.status === 'published') {
      const issue: Issue = {
        ...assembled,
        publishGate: {
          decision: 'allow',
          runId: decision.gateRunId,
          actionId,
          argsHash,
          ...(decision.audit !== undefined ? { audit: decision.audit } : {}),
          ...(prior === 'approved' ? { priorResolution: true } : {}),
        },
      };
      io.writeIssueFiles(issue);
      await io.gateOutcome(decision.gateRunId, actionId, argsHash, true);
      io.writeState({ ...state!, phase: 'done', gateRunId: decision.gateRunId, gateActionId: actionId, argsHash });
      io.log(`fnotes ${week}: PUBLISHED — "${issue.title}"${decision.audit ? ' · audit sampled' : ''}`);
      return 'published';
    }

    const held: Issue = {
      ...assembled,
      status: 'held',
      heldReason:
        assembled.status === 'held'
          ? (assembled.heldReason ?? 'held')
          : `publish gate ${decision.decision}: ${decision.question ?? 'awaiting operator'} — the clock re-checks every minute`,
      publishGate: { decision: decision.decision === 'allow' ? 'hold' : decision.decision, runId: decision.gateRunId, actionId, argsHash },
    };
    io.writeIssueFiles(held);
    io.writeState({ ...state!, phase: 'gate-held', gateRunId: decision.gateRunId, gateActionId: actionId, argsHash });
    io.log(`fnotes ${week}: HELD at the gate (${decision.decision}) — ${decision.question ?? ''}`);
    return 'gate-held';
  }
}

// ---------------------------------------------------------------------------
// The filesystem half of the real IO (state + notes + observatory + store
// copy). The db/queue half is wired by the server, which owns those handles.
// ---------------------------------------------------------------------------

export interface ClockFsOptions {
  /** The research dir (prod: /research) with artifacts/{runs,notes} + store. */
  researchDir: string;
  pricesVersion: string;
  /** Open a pglite handle on a store COPY path; caller closes. */
  openStore: (path: string) => Promise<{ db: StoreLike; close: () => Promise<void> }>;
}

export function clockFsIo(o: ClockFsOptions): Pick<ClockIO, 'readObservatoryRun' | 'composeFacts' | 'readIssue' | 'writeIssueFiles' | 'readState' | 'writeState'> {
  const notesDir = join(o.researchDir, 'artifacts', 'notes');
  const stateDir = join(o.researchDir, 'artifacts', 'fnotes-state');
  return {
    readObservatoryRun(week) {
      const p = join(o.researchDir, 'artifacts', 'runs', `${week}.json`);
      if (!existsSync(p)) return null;
      try {
        return JSON.parse(readFileSync(p, 'utf8')) as ObservatoryRun;
      } catch {
        return null;
      }
    },
    async composeFacts(run) {
      const tmp = join(tmpdir(), `fnotes-store-${randomUUID().slice(0, 8)}`);
      cpSync(join(o.researchDir, 'store'), tmp, { recursive: true });
      try {
        const handle = await o.openStore(tmp);
        try {
          const replays = await loadReplaysFromStore(handle.db, o.pricesVersion);
          return composeFactSheet(run, replays, {});
        } finally {
          await handle.close();
        }
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
    readIssue(week) {
      const p = join(notesDir, `${week}.json`);
      if (!existsSync(p)) return null;
      try {
        return JSON.parse(readFileSync(p, 'utf8')) as Issue;
      } catch {
        return null;
      }
    },
    writeIssueFiles(issue) {
      writeIssue(notesDir, issue);
    },
    readState(week) {
      const p = join(stateDir, `${week}.json`);
      if (!existsSync(p)) return null;
      try {
        return JSON.parse(readFileSync(p, 'utf8')) as ClockState;
      } catch {
        return null;
      }
    },
    writeState(state, opts) {
      mkdirSync(stateDir, { recursive: true });
      const p = join(stateDir, `${state.week}.json`);
      try {
        writeFileSync(p, JSON.stringify(state, null, 1), opts?.exclusive ? { flag: 'wx' } : {});
        return true;
      } catch {
        return false;
      }
    },
  };
}
