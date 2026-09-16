// Job-delivery dedupe (F10, migration 0032).
//
// Production retries every job 3× (SPEC §12.2) and BullMQ's stalled-job
// reaper redelivers after a worker crash regardless of the attempt limit.
// Handlers were not idempotent, so a throw AFTER the spend re-ran the whole
// handler: fresh provider money, a fresh runId, and a second pass through
// contractual branches whose preconditions had already been mutated.
//
// The dedupe key is the JOB ID, not the evidence: two verdicts for one tuple
// are correct when a human asked for two verifies (suite-verify's own
// run-twice test pins that), so a retry and a deliberate re-run are
// indistinguishable at the data layer. Only the delivery tells them apart.
//
// Follows budget_events (0011): claim with ON CONFLICT DO NOTHING and act
// only if you won the insert.
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { PotionDb } from '../db.js';
import { jobExecutions, type JobExecutionRow } from '../schema.js';

/** What a delivery is allowed to do. */
export type JobClaim =
  /** First delivery — run the handler. */
  | { decision: 'proceed' }
  /** A prior delivery completed — replay its recorded result, run nothing. */
  | { decision: 'already-completed'; result: unknown; outcome: string | null; row: JobExecutionRow }
  /**
   * A prior delivery CLAIMED this job and never completed (crash / stall
   * redelivery). Re-running would spend against an attempt whose spend we
   * cannot account for, so the handler refuses. Any doubt means no spend.
   */
  | { decision: 'refuse-incomplete'; row: JobExecutionRow };

/**
 * Claim a job delivery. Exactly one caller per job id ever gets 'proceed'.
 *
 * `allowResumeAfterMs` is deliberately NOT provided: a time-based takeover
 * would reintroduce the double-spend it exists to prevent (two workers can
 * both believe the other is dead). Recovery from an incomplete claim is a
 * DELIBERATE act — re-enqueue, which mints a new job id.
 */
export async function claimJobExecution(
  db: PotionDb,
  input: { jobId: string; jobKind: string; orgId?: string | undefined; attempt: number },
): Promise<JobClaim> {
  const inserted = await db
    .insert(jobExecutions)
    .values({
      jobId: input.jobId,
      jobKind: input.jobKind,
      orgId: input.orgId ?? null,
      attempt: input.attempt,
    })
    .onConflictDoNothing({ target: jobExecutions.jobId })
    .returning({ jobId: jobExecutions.jobId });
  if (inserted.length > 0) return { decision: 'proceed' };

  const rows = await db.select().from(jobExecutions).where(eq(jobExecutions.jobId, input.jobId));
  const row = rows[0]!;
  if (row.completedAt !== null) {
    return {
      decision: 'already-completed',
      result: row.result,
      outcome: row.outcome,
      row,
    };
  }
  return { decision: 'refuse-incomplete', row };
}

/** Record a delivery's completion. The result is replayed verbatim to any
 * later redelivery of the same job id, so one logical job has one answer. */
export async function completeJobExecution(
  db: PotionDb,
  jobId: string,
  result: unknown,
  // 'ok' BY DEFAULT (2026-09-16). Every completion for the ledger's first
  // two months wrote no outcome at all, so "did this job succeed?" had no
  // answer anywhere a human looks — 13,961 failures sat in Redis alone.
  outcome: string = 'ok',
): Promise<void> {
  await db
    .update(jobExecutions)
    .set({
      completedAt: new Date(),
      result: result ?? null,
      outcome,
    })
    .where(eq(jobExecutions.jobId, jobId));
}

/**
 * Record a delivery's FAILURE (2026-09-16). The row stays INCOMPLETE —
 * completedAt null — so a redelivery is still refused (no double spend);
 * what changes is that the failure is now legible: outcome 'failed' and
 * the error on the row, where before it survived only as BullMQ's
 * failedReason in Redis.
 */
export async function failJobExecution(
  db: PotionDb,
  jobId: string,
  error: { name: string; message: string; stack?: string | undefined },
): Promise<void> {
  await db
    .update(jobExecutions)
    .set({
      outcome: 'failed',
      result: { error: { name: error.name, message: error.message.slice(0, 2000), ...(error.stack ? { stack: error.stack.slice(0, 4000) } : {}), at: new Date().toISOString() } },
    })
    .where(eq(jobExecutions.jobId, jobId));
}

/** Failures of one job kind for one org (null = platform scope) since `since`. */
export async function countRecentJobFailures(
  db: PotionDb,
  input: { jobKind: string; orgId: string | null; since: Date },
): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(jobExecutions)
    .where(
      and(
        eq(jobExecutions.jobKind, input.jobKind),
        input.orgId === null ? isNull(jobExecutions.orgId) : eq(jobExecutions.orgId, input.orgId),
        eq(jobExecutions.outcome, 'failed'),
        gt(jobExecutions.claimedAt, input.since),
      ),
    );
  return Number(rows[0]?.n ?? 0);
}

export async function getJobExecution(
  db: PotionDb,
  jobId: string,
): Promise<JobExecutionRow | null> {
  const rows = await db.select().from(jobExecutions).where(eq(jobExecutions.jobId, jobId));
  return rows[0] ?? null;
}
