// THE REAPER laws (2026-09-01): a stranded run is re-adopted; a live one
// is left alone; the re-enqueue is idempotent against a held claim.
import { describe, expect, it } from 'vitest';
import { claimLabRun, createDb, createLabRun, listOrphanedLabRuns, migrate, seedIsolationOrgs, transitionLabRun, ORG_A } from '@potion/db';
import { harnessSpecHash, type HarnessSpec } from '@potion/lab-spec';
import { reapTick } from '../src/lab-scheduler.js';

const SPEC: HarnessSpec = {
  specVersion: 1, name: 'reap harness',
  brain: { policy: { type: 'min_cost', qualityFloor: 0 } },
  mission: { kind: 'task', goal: 'x', doneDefinition: 'x' },
  superpowers: [], memory: { enabled: false }, rules: [],
  fuel: { maxUsdPerRun: 1, hardStop: true }, checkIns: [],
};

describe('the reaper', () => {
  it('re-adopts a stranded running run; leaves a freshly-claimed one alone', async () => {
    const h = await createDb();
    await migrate(h.db);
    await seedIsolationOrgs(h.db);
    const hash = harnessSpecHash(SPEC);

    // Stranded: claimed long ago (lease 1ms → instantly expired), running.
    await createLabRun(h.db, { id: 'run-stranded', orgId: ORG_A, harnessHash: hash, harnessName: SPEC.name, spec: SPEC });
    const claim = await claimLabRun(h.db, { runId: 'run-stranded', orgId: ORG_A, expectedHarnessHash: hash, leaseMs: 1 });
    expect(claim.ok).toBe(true);
    // Live: claimed with a healthy lease.
    await createLabRun(h.db, { id: 'run-live', orgId: ORG_A, harnessHash: hash, harnessName: SPEC.name, spec: SPEC });
    await claimLabRun(h.db, { runId: 'run-live', orgId: ORG_A, expectedHarnessHash: hash, leaseMs: 600_000 });

    const future = new Date(Date.now() + 5 * 60_000);
    const orphans = await listOrphanedLabRuns(h.db, future, 2 * 60_000);
    const ids = orphans.map((o) => o.id);
    expect(ids).toContain('run-stranded');
    expect(ids).not.toContain('run-live');

    const enqueued: string[] = [];
    await reapTick(
      { db: h, queue: { enqueue: async (_t: string, p: { runId: string }) => { enqueued.push(p.runId); return 'job-1'; } } as never },
      future,
    );
    expect(enqueued).toContain('run-stranded');
    expect(enqueued).not.toContain('run-live');
    await h.close();
  }, 60_000);

  it('terminal runs are never reaped', async () => {
    const h = await createDb();
    await migrate(h.db);
    await seedIsolationOrgs(h.db);
    const hash = harnessSpecHash(SPEC);
    await createLabRun(h.db, { id: 'run-done', orgId: ORG_A, harnessHash: hash, harnessName: SPEC.name, spec: SPEC });
    const c = await claimLabRun(h.db, { runId: 'run-done', orgId: ORG_A, expectedHarnessHash: hash, leaseMs: 1 });
    if (c.ok) await transitionLabRun(h.db, { runId: 'run-done', orgId: ORG_A, fence: c.fence, to: 'completed' });
    const orphans = await listOrphanedLabRuns(h.db, new Date(Date.now() + 5 * 60_000), 2 * 60_000);
    expect(orphans.map((o) => o.id)).not.toContain('run-done');
    await h.close();
  }, 60_000);
});
