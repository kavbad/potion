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
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { PotionDb } from '../db.js';
import {
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
}

export async function createLabRun(db: PotionDb, input: CreateLabRunInput): Promise<void> {
  await db.insert(labRuns).values({
    id: input.id,
    orgId: input.orgId,
    harnessHash: input.harnessHash,
    harnessName: input.harnessName,
    spec: input.spec,
    state: 'pending',
  });
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
    .where(and(eq(labRuns.orgId, orgId), eq(labRuns.harnessHash, harnessHash)))
    .orderBy(desc(labRuns.createdAt))
    .limit(limit);
}
