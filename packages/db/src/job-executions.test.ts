// Job-delivery dedupe (F10). PGlite, zero services.
import { describe, expect, it } from 'vitest';
import {
  claimJobExecution,
  completeJobExecution,
  createDb,
  getJobExecution,
  migrate,
  type DbHandle,
} from './index.js';

async function db(): Promise<DbHandle> {
  const h = await createDb();
  await migrate(h.db);
  return h;
}

describe('job execution ledger (F10)', () => {
  it('exactly ONE delivery per job id gets to proceed', async () => {
    const h = await db();
    const first = await claimJobExecution(h.db, { jobId: 'j1', jobKind: 'suite:certify', attempt: 1 });
    expect(first.decision).toBe('proceed');
    // The retry — same job id, attempt 2.
    const second = await claimJobExecution(h.db, { jobId: 'j1', jobKind: 'suite:certify', attempt: 2 });
    expect(second.decision).toBe('refuse-incomplete');
    await h.close();
  });

  it('a COMPLETED job replays its recorded result instead of re-running', async () => {
    const h = await db();
    expect((await claimJobExecution(h.db, { jobId: 'j2', jobKind: 'guarantee:suite-verify', attempt: 1 })).decision).toBe('proceed');
    await completeJobExecution(h.db, 'j2', { verdictId: 'v-1', outcome: 'all-clear' }, 'all-clear');
    const again = await claimJobExecution(h.db, { jobId: 'j2', jobKind: 'guarantee:suite-verify', attempt: 2 });
    expect(again.decision).toBe('already-completed');
    if (again.decision === 'already-completed') {
      expect(again.result).toEqual({ verdictId: 'v-1', outcome: 'all-clear' });
      expect(again.outcome).toBe('all-clear');
    }
    await h.close();
  });

  it('an INCOMPLETE claim refuses — a crashed attempt is never silently resumed', async () => {
    // Deliberate: a time-based takeover would reintroduce the double-spend
    // (two workers can each believe the other is dead). Recovery is a
    // deliberate re-enqueue, which mints a NEW job id.
    const h = await db();
    await claimJobExecution(h.db, { jobId: 'j3', jobKind: 'frontier:live-sweep', orgId: 'org_x', attempt: 1 });
    const redelivery = await claimJobExecution(h.db, { jobId: 'j3', jobKind: 'frontier:live-sweep', orgId: 'org_x', attempt: 2 });
    expect(redelivery.decision).toBe('refuse-incomplete');
    const row = await getJobExecution(h.db, 'j3');
    expect(row?.completedAt).toBeNull();
    expect(row?.attempt).toBe(1); // the CLAIM records the winning attempt
    await h.close();
  });

  it('different job ids are independent — a deliberate re-run is not a retry', async () => {
    // The discriminator that matters: two verdicts for one tuple are correct
    // when a human asked twice; they are a double-spend when the queue
    // redelivered once.
    const h = await db();
    expect((await claimJobExecution(h.db, { jobId: 'run-a', jobKind: 'guarantee:suite-verify', attempt: 1 })).decision).toBe('proceed');
    expect((await claimJobExecution(h.db, { jobId: 'run-b', jobKind: 'guarantee:suite-verify', attempt: 1 })).decision).toBe('proceed');
    await h.close();
  });
});
