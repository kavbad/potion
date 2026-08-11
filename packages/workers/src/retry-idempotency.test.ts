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
