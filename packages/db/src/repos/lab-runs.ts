// Lab runtime stores (Step 3, migration 0035): runs, per-step checkpoints,
// harness memory. Single-writer discipline via lease + fencing token.
//
// The concurrency model, in one paragraph: a run is durable rows adopted by
// at most one invocation at a time. `claimLabRun` is the only door in —
// compare-and-set with a lease (`claim_expires_at`) and a fence bump
// (`invocation_seq`). EVERY subsequent write from the invocation carries its
// fence and is guarded `WHERE invocation_seq = mine`, so when a lease
// expires and someone reclaims, the old winner's late writes are REJECTED,
// not merged (review addition 1 — a dead winner must not hold the claim
// forever, and a zombie winner must not corrupt the run it lost).
import { isNull, and, asc, desc, eq, gte, lt, ne, sql } from 'drizzle-orm';
import type { PotionDb } from '../db.js';
import { labDigests,
  labHarnessMemory,
  labRuns,
  labRunSteps,
  type LabRunRow,
  type LabRunState,
  type LabRunStepRow,
} from '../schema.js';

export interface CreateLabRunInput {
  id: string;
  orgId: string;
  harnessHash: string;
  harnessName: string;
  spec: unknown;
  /** X4: set when this run is a fan-out helper of another run. */
  parentRunId?: string;
  /** W3: a candidate's shadow rehearsal — proof, never evidence. */
  shadow?: boolean;
}

export async function createLabRun(db: PotionDb, input: CreateLabRunInput): Promise<void> {
  await db.insert(labRuns).values({
    id: input.id,
    orgId: input.orgId,
    harnessHash: input.harnessHash,
    harnessName: input.harnessName,
    spec: input.spec,
    state: 'pending',
    ...(input.parentRunId !== undefined ? { parentRunId: input.parentRunId } : {}),
    ...(input.shadow === true ? { shadow: true } : {}),
  });
}

/** X4: the family view — every helper of one parent, oldest first. */
export async function listLabRunChildren(
  db: PotionDb,
  orgId: string,
  parentRunId: string,
): Promise<Array<{ id: string; state: string; harnessName: string; spec: unknown; createdAt: Date }>> {
  return db
    .select({ id: labRuns.id, state: labRuns.state, harnessName: labRuns.harnessName, spec: labRuns.spec, createdAt: labRuns.createdAt })
    .from(labRuns)
    .where(and(eq(labRuns.orgId, orgId), eq(labRuns.parentRunId, parentRunId)))
    .orderBy(labRuns.createdAt, labRuns.id);
}

export type LabClaim =
  | {
      ok: true;
      fence: number;
      cursorSeq: number;
      spec: unknown;
      state: LabRunState;
      /** Unconsumed check-in answer, when resuming from awaiting-human. */
      pendingAnswer: string | null;
      pendingQuestion: string | null;
    }
  | {
      ok: false;
      reason:
        | 'not-found'
        | 'terminal'
        | 'claim-held'
        | 'awaiting-answer'
        | 'spec-drift';
      detail: string;
    };

/**
 * The only door into executing a run. Refusals are typed, not thrown.
 *
 * `expectedHarnessHash` is the resume identity gate: a run resumed under an
 * edited spec is a DIFFERENT harness wearing the same runId (the F7 lesson
 * applied to runs) — refused as 'spec-drift'; the remedy is an explicit
 * fork, never a silent continuation.
 */
export async function claimLabRun(
  db: PotionDb,
  input: {
    runId: string;
    orgId: string;
    expectedHarnessHash: string;
    leaseMs: number;
    now?: Date;
  },
): Promise<LabClaim> {
  const now = input.now ?? new Date();
  const rows = await db
    .select()
    .from(labRuns)
    .where(and(eq(labRuns.id, input.runId), eq(labRuns.orgId, input.orgId)));
  const run = rows[0];
  if (!run) return { ok: false, reason: 'not-found', detail: `no run '${input.runId}' for this org` };
  if (
    run.state === 'completed' ||
    run.state === 'failed' ||
    run.state === 'killed-budget' ||
    run.state === 'killed-operator'
  ) {
    // Terminal means terminal: continuation from here is a FORK (new runId),
    // never a resume — re-running against a spent budget is how double-spend
    // incidents start.
    return { ok: false, reason: 'terminal', detail: `run is '${run.state}' — terminal; fork to continue` };
  }
  if (run.harnessHash !== input.expectedHarnessHash) {
    return {
      ok: false,
      reason: 'spec-drift',
      detail:
        `run was started under spec ${run.harnessHash.slice(0, 12)}…, resume offered ` +
        `${input.expectedHarnessHash.slice(0, 12)}… — a different instrument; fork instead`,
    };
  }
  if (run.state === 'awaiting-human' && run.pendingAnswer === null) {
    return { ok: false, reason: 'awaiting-answer', detail: 'run is awaiting a check-in answer' };
  }

  // CAS: adopt only if unclaimed or the lease has expired. The fence bump is
  // in the same guarded UPDATE, so exactly one concurrent claimant wins.
  const claimed = await db
    .update(labRuns)
    .set({
      state: 'running',
      invocationSeq: sql`${labRuns.invocationSeq} + 1`,
      claimExpiresAt: new Date(now.getTime() + input.leaseMs),
      updatedAt: now,
    })
    .where(
      and(
        eq(labRuns.id, input.runId),
        eq(labRuns.orgId, input.orgId),
        eq(labRuns.invocationSeq, run.invocationSeq), // nobody claimed since we read
        sql`(${labRuns.claimExpiresAt} IS NULL OR ${labRuns.claimExpiresAt} < ${now})`,
      ),
    )
    .returning({ fence: labRuns.invocationSeq, cursorSeq: labRuns.cursorSeq });
  if (claimed.length === 0) {
    return { ok: false, reason: 'claim-held', detail: 'another invocation holds an unexpired claim' };
  }
  return {
    ok: true,
    fence: claimed[0]!.fence,
    cursorSeq: claimed[0]!.cursorSeq,
    spec: run.spec,
    state: run.state,
    pendingAnswer: run.pendingAnswer,
    pendingQuestion: run.pendingQuestion,
  };
}

export class LabFenceError extends Error {
  constructor(runId: string, op: string) {
    super(
      `run '${runId}': ${op} rejected — this invocation's claim was reclaimed ` +
        '(lease expired and another invocation holds the fence). Stop; do not retry.',
    );
    this.name = 'LabFenceError';
  }
}

/**
 * Append step N+1 and advance the cursor, atomically, fenced.
 *
 * The UPDATE guards fence AND cursor AND state in one statement: a zombie
 * invocation (stale fence), an out-of-order append (cursor mismatch), or a
 * run killed from outside (state no longer running) all reject without
 * writing. `memoryWrites` are applied in the same transaction so the memory
 * store is exactly the projection of the checkpointed step history.
 */
export async function appendLabStep(
  db: PotionDb,
  input: {
    runId: string;
    orgId: string;
    fence: number;
    seq: number;
    kind: LabRunStepRow['kind'];
    payload: unknown;
    harnessHash: string;
    memoryWrites?: Record<string, unknown>;
    leaseMs: number;
    now?: Date;
  },
): Promise<void> {
  const now = input.now ?? new Date();
  await db.transaction(async (tx) => {
    const advanced = await tx
      .update(labRuns)
      .set({
        cursorSeq: input.seq,
        claimExpiresAt: new Date(now.getTime() + input.leaseMs), // heartbeat
        updatedAt: now,
      })
      .where(
        and(
          eq(labRuns.id, input.runId),
          eq(labRuns.orgId, input.orgId),
          eq(labRuns.invocationSeq, input.fence),
          eq(labRuns.cursorSeq, input.seq - 1),
          eq(labRuns.state, 'running'),
        ),
      )
      .returning({ id: labRuns.id });
    if (advanced.length === 0) throw new LabFenceError(input.runId, `append step ${input.seq}`);
    await tx.insert(labRunSteps).values({
      runId: input.runId,
      orgId: input.orgId,
      seq: input.seq,
      kind: input.kind,
      payload: input.payload,
    });
    for (const [key, value] of Object.entries(input.memoryWrites ?? {})) {
      await tx
        .insert(labHarnessMemory)
        .values({ orgId: input.orgId, harnessHash: input.harnessHash, key, value, updatedAt: now })
        .onConflictDoUpdate({
          target: [labHarnessMemory.orgId, labHarnessMemory.harnessHash, labHarnessMemory.key],
          set: { value, updatedAt: now },
        });
    }
  });
}

/** Fenced state transition from inside an invocation (suspend, complete,
 * fail, budget-kill). Clears the lease so the run is immediately adoptable
 * where that makes sense (awaiting-human), and records the reason. */
export async function transitionLabRun(
  db: PotionDb,
  input: {
    runId: string;
    orgId: string;
    fence: number;
    to: LabRunState;
    reason?: string;
    question?: string;
    now?: Date;
  },
): Promise<void> {
  const now = input.now ?? new Date();
  const done = await db
    .update(labRuns)
    .set({
      state: input.to,
      stateReason: input.reason ?? null,
      pendingQuestion: input.question ?? null,
      pendingAnswer: null, // consumed or irrelevant on every transition
      claimExpiresAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(labRuns.id, input.runId),
        eq(labRuns.orgId, input.orgId),
        eq(labRuns.invocationSeq, input.fence),
      ),
    )
    .returning({ id: labRuns.id });
  if (done.length === 0) throw new LabFenceError(input.runId, `transition to ${input.to}`);
}

/** UNFENCED operator kill — must work from outside any invocation. The
 * running invocation's next fenced write then rejects (state guard), which
 * is exactly how a zombie discovers it lost. */
export async function killLabRun(
  db: PotionDb,
  runId: string,
  orgId: string,
  reason = 'operator kill',
): Promise<boolean> {
  const done = await db
    .update(labRuns)
    .set({ state: 'killed-operator', stateReason: reason, claimExpiresAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(labRuns.id, runId),
        eq(labRuns.orgId, orgId),
        sql`${labRuns.state} NOT IN ('completed', 'failed', 'killed-budget', 'killed-operator')`,
      ),
    )
    .returning({ id: labRuns.id });
  return done.length > 0;
}

/** Record a check-in answer. Only valid while awaiting-human with no answer
 * yet — answering twice, or answering a running run, is a caller bug
 * surfaced as `false`, not silently absorbed. */
/**
 * Step 12 (L3, CRITICAL): burn a consumed check-in answer, durably, at the
 * moment the authorization is USED.
 *
 * Consumption used to be an in-memory boolean in the loop while the durable
 * `pending_answer` column survived — and the leg-cap exit releases the lease
 * without transitioning, so the column stayed set. The next leg claimed the
 * run, saw the same answer beside the same check-in step, and re-armed the
 * external-action gate. One "yes" bought one unreviewed act per leg, for as
 * many legs as the run had.
 *
 * Scoped to a RUNNING run so it can never race a fresh answer being recorded
 * against a run that is waiting for one.
 */
export async function consumeLabRunAnswer(
  db: PotionDb,
  runId: string,
  orgId: string,
): Promise<void> {
  await db
    .update(labRuns)
    .set({ pendingAnswer: null, updatedAt: new Date() })
    .where(and(eq(labRuns.id, runId), eq(labRuns.orgId, orgId), eq(labRuns.state, 'running')));
}

export async function answerLabRun(
  db: PotionDb,
  runId: string,
  orgId: string,
  answer: string,
): Promise<boolean> {
  const done = await db
    .update(labRuns)
    .set({ pendingAnswer: answer, updatedAt: new Date() })
    .where(
      and(
        eq(labRuns.id, runId),
        eq(labRuns.orgId, orgId),
        eq(labRuns.state, 'awaiting-human'),
        sql`${labRuns.pendingAnswer} IS NULL`,
      ),
    )
    .returning({ id: labRuns.id });
  return done.length > 0;
}

/** Leg boundary for STANDING missions: clear the lease, keep state
 * 'running', fenced — the run is immediately adoptable by the next leg.
 * Distinct from a transition: nothing about the run's meaning changed. */
export async function releaseLabRunLease(
  db: PotionDb,
  input: { runId: string; orgId: string; fence: number },
): Promise<void> {
  const done = await db
    .update(labRuns)
    .set({ claimExpiresAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(labRuns.id, input.runId),
        eq(labRuns.orgId, input.orgId),
        eq(labRuns.invocationSeq, input.fence),
        eq(labRuns.state, 'running'),
      ),
    )
    .returning({ id: labRuns.id });
  if (done.length === 0) throw new LabFenceError(input.runId, 'release lease');
}

export async function getLabRun(db: PotionDb, runId: string, orgId: string): Promise<LabRunRow | null> {
  const rows = await db
    .select()
    .from(labRuns)
    .where(and(eq(labRuns.id, runId), eq(labRuns.orgId, orgId)));
  return rows[0] ?? null;
}

export async function listLabSteps(
  db: PotionDb,
  runId: string,
  orgId: string,
): Promise<LabRunStepRow[]> {
  return db
    .select()
    .from(labRunSteps)
    .where(and(eq(labRunSteps.runId, runId), eq(labRunSteps.orgId, orgId)))
    .orderBy(labRunSteps.seq);
}

/** Step 10 daily-cap rollup: every step payload the org wrote since
 * `since` (grant-scope attributed-spend metering across runs). kind +
 * payload only — the meter functions in @potion/lab-mcp consume this
 * shape directly. */
export async function listLabStepPayloadsForOrgSince(
  db: PotionDb,
  orgId: string,
  since: Date,
): Promise<Array<{ kind: string; payload: unknown }>> {
  return db
    .select({ kind: labRunSteps.kind, payload: labRunSteps.payload })
    .from(labRunSteps)
    .where(and(eq(labRunSteps.orgId, orgId), gte(labRunSteps.createdAt, since)));
}

/** The whole memory of one (org, harness). There is deliberately NO
 * cross-harness read function to misuse. */
export async function getLabMemory(
  db: PotionDb,
  orgId: string,
  harnessHash: string,
): Promise<Record<string, unknown>> {
  const rows = await db
    .select({ key: labHarnessMemory.key, value: labHarnessMemory.value })
    .from(labHarnessMemory)
    .where(and(eq(labHarnessMemory.orgId, orgId), eq(labHarnessMemory.harnessHash, harnessHash)));
  const out: Record<string, unknown> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

/** Memory rows WITH updatedAt — the Step 8 view surface (key, value, when). */
export async function listLabMemoryEntries(
  db: PotionDb,
  orgId: string,
  harnessHash: string,
): Promise<Array<{ key: string; value: unknown; updatedAt: Date }>> {
  return db
    .select({ key: labHarnessMemory.key, value: labHarnessMemory.value, updatedAt: labHarnessMemory.updatedAt })
    .from(labHarnessMemory)
    .where(and(eq(labHarnessMemory.orgId, orgId), eq(labHarnessMemory.harnessHash, harnessHash)))
    .orderBy(labHarnessMemory.key);
}

/** Step 8 memory edit: upsert one entry. In-flight legs are unaffected
 * mid-leg (they snapshot memoryReads at leg start); the NEXT leg reads the
 * store as edited. */
export async function setLabMemoryKey(
  db: PotionDb,
  orgId: string,
  harnessHash: string,
  key: string,
  value: unknown,
): Promise<void> {
  await db
    .insert(labHarnessMemory)
    .values({ orgId, harnessHash, key, value })
    .onConflictDoUpdate({
      target: [labHarnessMemory.orgId, labHarnessMemory.harnessHash, labHarnessMemory.key],
      set: { value, updatedAt: new Date() },
    });
}

/** Step 8 memory delete: PERMANENT and immediate — no tombstone (stated
 * semantics). Returns whether a row existed (route 404s on false). */
export async function deleteLabMemoryKey(
  db: PotionDb,
  orgId: string,
  harnessHash: string,
  key: string,
): Promise<boolean> {
  const gone = await db
    .delete(labHarnessMemory)
    .where(
      and(
        eq(labHarnessMemory.orgId, orgId),
        eq(labHarnessMemory.harnessHash, harnessHash),
        eq(labHarnessMemory.key, key),
      ),
    )
    .returning({ key: labHarnessMemory.key });
  return gone.length > 0;
}

/** Step 9 additive read: the harness's recent life — which run the form
 * page animates, and run-history density at mid zoom. Org-scoped like
 * every lab read; newest first. */
export async function listLabRunsForHarness(
  db: PotionDb,
  orgId: string,
  harnessHash: string,
  limit = 20,
): Promise<Array<{ id: string; state: LabRunState; stateReason: string | null; createdAt: Date; updatedAt: Date }>> {
  return db
    .select({
      id: labRuns.id,
      state: labRuns.state,
      stateReason: labRuns.stateReason,
      createdAt: labRuns.createdAt,
      updatedAt: labRuns.updatedAt,
    })
    .from(labRuns)
    // X4: helpers live under their parent's trace, not in the harness's
    // run list — the family card on the parent page shows them.
    .where(and(eq(labRuns.orgId, orgId), eq(labRuns.harnessHash, harnessHash), isNull(labRuns.parentRunId)))
    .orderBy(desc(labRuns.createdAt))
    .limit(limit);
}

/**
 * EVERY WORKER OF THIS ORG THAT IS WAITING ON A PERSON (2026-09-05).
 *
 * A parked run sends one email and then goes quiet forever. On production
 * one has been waiting since 2026-08-31 — its owner missed the mail, and
 * nothing anywhere in the product says a worker wants them. This is the
 * read behind the standing signal: cheap (indexed on state), org-scoped,
 * and one row per waiting worker, oldest first, because the one that has
 * waited longest is the one most likely to have been forgotten.
 *
 * Helpers are excluded for the same reason they are excluded from a
 * harness's run list: a helper's question belongs to its parent's trace.
 */
export async function listWaitingLabRuns(
  db: PotionDb,
  orgId: string,
  limit = 50,
): Promise<Array<{ id: string; harnessHash: string; harnessName: string; question: string | null; since: Date }>> {
  const rows = await db
    .select({
      id: labRuns.id,
      harnessHash: labRuns.harnessHash,
      harnessName: labRuns.harnessName,
      question: labRuns.pendingQuestion,
      since: labRuns.updatedAt,
    })
    .from(labRuns)
    .where(
      and(
        eq(labRuns.orgId, orgId),
        eq(labRuns.state, 'awaiting-human'),
        isNull(labRuns.parentRunId),
        // A shadow run is a rehearsal nobody is asked to answer.
        ne(labRuns.shadow, true),
      ),
    )
    .orderBy(asc(labRuns.updatedAt))
    .limit(limit);
  return rows;
}

/** How long a parked run waits before it asks a second time. A day: long
 * enough that a person who saw the first mail and is thinking about it is
 * not nagged, short enough that a missed one does not cost a week. */
export const PARKED_REMINDER_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * PLATFORM-WIDE: parked runs old enough to deserve a second ask, that have
 * never had one. Deliberately NOT org-scoped — this is a sweep, and the
 * whole point is the org that is not looking.
 *
 * The `reminded_at IS NULL` half is what keeps this from becoming a nag:
 * a run is asked about exactly twice, ever. Beyond that the standing
 * signal on the roster is the reminder, and it costs nobody an inbox.
 */
export async function listParkedRunsDue(
  db: PotionDb,
  now: Date = new Date(),
  limit = 100,
): Promise<Array<{ id: string; orgId: string; harnessName: string; question: string | null; since: Date }>> {
  return db
    .select({
      id: labRuns.id,
      orgId: labRuns.orgId,
      harnessName: labRuns.harnessName,
      question: labRuns.pendingQuestion,
      since: labRuns.updatedAt,
    })
    .from(labRuns)
    .where(
      and(
        eq(labRuns.state, 'awaiting-human'),
        isNull(labRuns.remindedAt),
        isNull(labRuns.parentRunId),
        ne(labRuns.shadow, true),
        lt(labRuns.updatedAt, new Date(now.getTime() - PARKED_REMINDER_AFTER_MS)),
      ),
    )
    .orderBy(asc(labRuns.updatedAt))
    .limit(limit);
}

/** Stamp the second ask. Idempotent by the NULL guard: a concurrent sweep
 * cannot produce a third mail. Returns whether THIS call did the stamping,
 * so the caller only mails when it won. */
export async function markParkedRunReminded(
  db: PotionDb,
  runId: string,
  at: Date = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(labRuns)
    .set({ remindedAt: at })
    .where(and(eq(labRuns.id, runId), isNull(labRuns.remindedAt)))
    .returning({ id: labRuns.id });
  return rows.length === 1;
}

/** X3: attach the advisory judgment to a run (post-terminal, idempotent —
 * last write wins; the judge never blocks a run). */
export async function setLabRunJudge(
  db: PotionDb,
  runId: string,
  orgId: string,
  judge: unknown,
): Promise<void> {
  await db
    .update(labRuns)
    .set({ judge })
    .where(and(eq(labRuns.id, runId), eq(labRuns.orgId, orgId)));
}

/** P-4: the weekly digest's dedup — read/advance one org's last window. */
export async function getLabDigestKey(db: PotionDb, orgId: string): Promise<string | null> {
  const rows = await db.select().from(labDigests).where(eq(labDigests.orgId, orgId)).limit(1);
  return rows[0]?.lastWindowKey ?? null;
}

export async function setLabDigestKey(db: PotionDb, orgId: string, key: string): Promise<void> {
  await db
    .insert(labDigests)
    .values({ orgId, lastWindowKey: key })
    .onConflictDoUpdate({ target: [labDigests.orgId], set: { lastWindowKey: key, updatedAt: sql`now()` } });
}

/** Digest + feed reads: an org's recent runs, newest first, capped. */
export async function listRecentLabRuns(
  db: PotionDb,
  orgId: string,
  opts: { since?: Date; limit?: number } = {},
): Promise<Array<{ id: string; harnessHash: string; harnessName: string; state: string; createdAt: Date; judge: unknown }>> {
  // X4: the feed and the digest count ROOT runs only — a fan-out is one
  // check, not five.
  const conds = [eq(labRuns.orgId, orgId), isNull(labRuns.parentRunId)];
  if (opts.since !== undefined) conds.push(gte(labRuns.createdAt, opts.since));
  return db
    .select({
      id: labRuns.id,
      harnessHash: labRuns.harnessHash,
      harnessName: labRuns.harnessName,
      state: labRuns.state,
      createdAt: labRuns.createdAt,
      judge: labRuns.judge,
    })
    .from(labRuns)
    .where(and(...conds))
    .orderBy(desc(labRuns.createdAt))
    .limit(opts.limit ?? 50);
}

/** P-4: orgs with any lab run since the window opened — the digest roster. */
export async function listOrgIdsWithLabRunsSince(db: PotionDb, since: Date): Promise<string[]> {
  const rows = await db
    .selectDistinct({ orgId: labRuns.orgId })
    .from(labRuns)
    .where(gte(labRuns.createdAt, since));
  return rows.map((r) => r.orgId);
}

/** W3 — the latest COMPLETED, non-shadow run of a harness: the shadow
 * rehearsal's stub source and the comparison baseline. */
export async function latestCompletedLabRun(
  db: PotionDb,
  orgId: string,
  harnessHash: string,
): Promise<LabRunRow | null> {
  const rows = await db
    .select()
    .from(labRuns)
    .where(
      and(
        eq(labRuns.orgId, orgId),
        eq(labRuns.harnessHash, harnessHash),
        eq(labRuns.state, 'completed'),
        eq(labRuns.shadow, false),
      ),
    )
    .orderBy(desc(labRuns.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/** W3 — the candidate's latest shadow rehearsal. */
export async function latestShadowLabRun(
  db: PotionDb,
  orgId: string,
  harnessHash: string,
): Promise<LabRunRow | null> {
  const rows = await db
    .select()
    .from(labRuns)
    .where(and(eq(labRuns.orgId, orgId), eq(labRuns.harnessHash, harnessHash), eq(labRuns.shadow, true)))
    .orderBy(desc(labRuns.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/** THE REAPER (2026-09-01) — durable execution's re-adoption half. A
 * server restart mid-leg kills the worker process; the run row stays
 * 'running'/'pending' with an expired (or never-set) claim, and NOTHING
 * re-enqueued it — found live: a flagship trial frozen at step 7 through
 * two deploys. Returns runs whose claim expired past the grace (or which
 * never got claimed within it), oldest first, capped. The re-enqueued job
 * is harmless against a live claim: claimLabRun refuses and the job exits. */
export async function listOrphanedLabRuns(
  db: PotionDb,
  now: Date,
  graceMs: number,
  cap = 20,
): Promise<Array<{ id: string; orgId: string; state: string }>> {
  const cutoff = new Date(now.getTime() - graceMs);
  return db
    .select({ id: labRuns.id, orgId: labRuns.orgId, state: labRuns.state })
    .from(labRuns)
    .where(
      and(
        sql`${labRuns.state} IN ('pending', 'running')`,
        sql`(${labRuns.claimExpiresAt} IS NULL OR ${labRuns.claimExpiresAt} < ${cutoff})`,
        sql`${labRuns.updatedAt} < ${cutoff}`,
      ),
    )
    .orderBy(labRuns.updatedAt)
    .limit(cap);
}
