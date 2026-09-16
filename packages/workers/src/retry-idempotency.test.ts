// F10 — job-retry idempotency.
//
// THIS TEST WAS IMPOSSIBLE BEFORE THIS ITEM. Production retries every job 3×
// (SPEC §12.2) but MemoryQueue — every hermetic test — executed a throwing
// handler exactly once, so no test could observe a handler running twice.
// The double-spend was not merely untested; it was inexpressible. MemoryQueue
// now takes {attempts}, so the harness can finally state the failure.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  claimJobExecution,
  completeJobExecution,
  createDb,
  createOrg,
  getJobExecution,
  migrate,
  type DbHandle,
} from '@potion/db';
import { seedFromString } from '@potion/core';
import { MemoryQueue } from '@potion/queue';
import { JOB_FAILURE_ALERT_AT, withDeliveryGuard } from './suite-verify-job.js';
import type { JobContext } from './handler-shared.js';
import { JobRedeliveryRefusedError } from './handlers.js';

const REPO_PRICES = fileURLToPath(new URL('../../../prices.json', import.meta.url));
let root: string;
let pricesPath: string;
let db: DbHandle;

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'potion-f10-'));
  pricesPath = path.join(root, 'prices.json');
  copyFileSync(REPO_PRICES, pricesPath);
  db = await createDb();
  await migrate(db.db);
  await createOrg(db.db, { id: 'org_f10', name: 'F10' });
});

afterEach(async () => {
  await db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('F10: a retry must not re-execute spend or contractual effects', () => {
  it('THE DEFECT, now expressible: a handler that throws AFTER its spend is retried and re-runs', async () => {
    // The pre-fix shape, demonstrated on a stand-in handler that records its
    // executions. Under the OLD MemoryQueue this could not happen at all.
    const q = new MemoryQueue({ attempts: 3 });
    const spends: number[] = [];
    q.registerHandler('spendy', async () => {
      spends.push(spends.length + 1);
      throw new Error('alert enqueue failed AFTER the provider call');
    });
    await q.enqueue('spendy', { orgId: 'org_f10' });
    await q.close();
    // Three deliveries, three spends — this is what production was doing.
    expect(spends).toEqual([1, 2, 3]);
  });

  it('THE FIX: with the delivery guard, only the FIRST delivery does the work', async () => {
    const q = new MemoryQueue({ attempts: 3 });
    const spends: string[] = [];
    // A handler shaped like the real ones: guard, spend, then throw.
    q.registerHandler('guarded', async (payload: { orgId: string }, delivery) => {
      const claim = await claimJobExecution(db.db, {
        jobId: delivery.jobId,
        jobKind: 'suite:certify',
        orgId: payload.orgId,
        attempt: delivery.attempt,
      });
      if (claim.decision === 'already-completed') return claim.result;
      if (claim.decision === 'refuse-incomplete') {
        throw new JobRedeliveryRefusedError(delivery.jobId, 'suite:certify');
      }
      spends.push(`spend-attempt-${delivery.attempt}`);
      throw new Error('alert enqueue failed AFTER the provider call');
    });
    const id = await q.enqueue('guarded', { orgId: 'org_f10' });
    await q.close();

    // THE POINT: three deliveries, ONE spend.
    expect(spends).toEqual(['spend-attempt-1']);
    const status = await q.getJob(id);
    expect(status?.attempts).toBe(3); // it really was delivered three times
    expect(status?.state).toBe('failed');
    // …and the refusal is durable and legible, not a silent skip.
    const row = await getJobExecution(db.db, id);
    expect(row?.completedAt).toBeNull();
    expect(row?.jobKind).toBe('suite:certify');
    expect(row?.orgId).toBe('org_f10');
  });

  it('a COMPLETED job replays its result on redelivery — one logical job, one answer', async () => {
    const q = new MemoryQueue({ attempts: 3 });
    let runs = 0;
    q.registerHandler('done-then-redelivered', async (_p: unknown, delivery) => {
      const claim = await claimJobExecution(db.db, {
        jobId: delivery.jobId,
        jobKind: 'guarantee:suite-verify',
        attempt: delivery.attempt,
      });
      if (claim.decision === 'already-completed') return claim.result;
      runs += 1;
      const result = { verdictId: `v-${runs}`, outcome: 'all-clear' };
      await completeJobExecution(db.db, delivery.jobId, result);
      return result;
    });
    const id = await q.enqueue('done-then-redelivered', {});
    await q.close();
    expect(runs).toBe(1);
    expect((await q.getJob(id))?.result).toEqual({ verdictId: 'v-1', outcome: 'all-clear' });
  });

  it('the job-id-derived seed fits int4 — research_cycles.seed is integer, seedFromString is uint32', () => {
    // Caught by a real failure, not by inspection: swapping Math.random() for
    // seedFromString made research:cycle inserts blow up on overflow. The
    // schema already flags this trap for its OTHER seed column ("seeds are
    // uint32 and would overflow", schema.ts), which is exactly why the range
    // belongs in a test rather than in a comment.
    const INT4_MAX = 2 ** 31 - 1;
    for (const jobId of ['mem-1', 'mem-999999', 'bull-abcdef0123456789', '', 'x'.repeat(256)]) {
      const seed = seedFromString(jobId) % 2 ** 31;
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThanOrEqual(INT4_MAX);
    }
  });

  it('a DELIBERATE re-run (new job id) is never confused with a retry', async () => {
    // The discriminator that matters: suite-verify's own run-twice test pins
    // that two verdicts for one tuple are CORRECT when a human asked twice.
    const q = new MemoryQueue({ attempts: 3 });
    const runs: string[] = [];
    q.registerHandler('verify', async (_p: unknown, delivery) => {
      const claim = await claimJobExecution(db.db, {
        jobId: delivery.jobId,
        jobKind: 'guarantee:suite-verify',
        attempt: delivery.attempt,
      });
      if (claim.decision !== 'proceed') return 'skipped';
      runs.push(delivery.jobId);
      await completeJobExecution(db.db, delivery.jobId, 'ok');
      return 'ok';
    });
    await q.enqueue('verify', {});
    await q.enqueue('verify', {}); // a second DELIBERATE verify
    await q.close();
    expect(runs).toHaveLength(2); // both ran — different job ids
    expect(new Set(runs).size).toBe(2);
  });
});

// THE LEDGER SAYS WHAT HAPPENED (2026-09-16). For two months every
// completion wrote no outcome and every throw wrote nothing at all: the row
// stayed 'claimed, incomplete' and the error lived only in Redis. On
// 2026-09-16 that was 13,961 failed jobs, 199 of the last 200 the same
// TypeError, and nothing anywhere a human looks.
describe('the ledger records outcomes; repeated failure is alerted once', () => {
  function ctxWith(jobId: string, q: MemoryQueue): JobContext {
    return { db: db.db, dbHandle: db, pricesPath: '', delivery: { jobId, attempt: 1 }, queue: q };
  }
  function recordingQueue(): { q: MemoryQueue; alerts: Array<{ orgId: string; event: string; detail?: Record<string, unknown> }> } {
    const q = new MemoryQueue({ attempts: 1 });
    const alerts: Array<{ orgId: string; event: string; detail?: Record<string, unknown> }> = [];
    q.registerHandler('alerts:dispatch', async (payload: { orgId: string; event: string; detail?: Record<string, unknown> }) => { alerts.push(payload); });
    return { q, alerts };
  }

  it("success writes outcome 'ok'", async () => {
    const { q } = recordingQueue();
    const out = await withDeliveryGuard('suite:certify', ctxWith('job-ok-1', q), 'org_ledger', async () => ({ fine: true }));
    expect(out).toEqual({ fine: true });
    const row = await getJobExecution(db.db, 'job-ok-1');
    expect(row?.outcome).toBe('ok');
    expect(row?.completedAt).not.toBeNull();
    await q.close();
  });

  it("a throw writes outcome 'failed' + the error on the row, stays INCOMPLETE (redelivery still refused), and rethrows", async () => {
    const { q } = recordingQueue();
    await expect(
      withDeliveryGuard('suite:certify', ctxWith('job-fail-1', q), 'org_ledger', async () => { throw new TypeError("Cannot read properties of undefined (reading 'policy')"); }),
    ).rejects.toThrow(/reading 'policy'/);
    const row = await getJobExecution(db.db, 'job-fail-1');
    expect(row?.outcome).toBe('failed');
    expect(row?.completedAt, 'incomplete: a retry must still be refused').toBeNull();
    expect((row?.result as { error: { name: string; message: string } }).error).toMatchObject({ name: 'TypeError', message: expect.stringContaining("reading 'policy'") });
    // the redelivery rule is unchanged
    const claim = await claimJobExecution(db.db, { jobId: 'job-fail-1', jobKind: 'suite:certify', orgId: 'org_ledger', attempt: 2 });
    expect(claim.decision).toBe('refuse-incomplete');
    await q.close();
  });

  it(`the ${JOB_FAILURE_ALERT_AT}rd failure of one kind for one org in 24h emits ONE job_failed alert; the 4th is silent`, async () => {
    const { q, alerts } = recordingQueue();
    for (let i = 1; i <= JOB_FAILURE_ALERT_AT + 1; i++) {
      await withDeliveryGuard('learning:period', ctxWith(`job-rep-${i}`, q), 'org_repeat', async () => { throw new Error(`boom ${i}`); }).catch(() => undefined);
    }
    await q.close(); // drains alerts:dispatch
    const mine = alerts.filter((a) => a.event === 'job_failed' && a.orgId === 'org_repeat');
    expect(mine).toHaveLength(1);
    expect(mine[0]!.detail).toMatchObject({ jobKind: 'learning:period', failuresLast24h: JOB_FAILURE_ALERT_AT, lastJobId: `job-rep-${JOB_FAILURE_ALERT_AT}` });
    expect(String(mine[0]!.detail!.narrative)).toContain(`boom ${JOB_FAILURE_ALERT_AT}`);
  });

  it('a platform-scope job (no org) alerts the ops org', async () => {
    const { q, alerts } = recordingQueue();
    for (let i = 1; i <= JOB_FAILURE_ALERT_AT; i++) {
      await withDeliveryGuard('drift:canary', ctxWith(`job-plat-${i}`, q), undefined, async () => { throw new Error('platform boom'); }).catch(() => undefined);
    }
    await q.close();
    const mine = alerts.filter((a) => a.event === 'job_failed' && a.detail?.jobKind === 'drift:canary');
    expect(mine).toHaveLength(1);
    expect(mine[0]!.orgId).toBe('org_platform_ops');
    expect(mine[0]!.detail).toMatchObject({ scope: 'platform' });
  });
});
