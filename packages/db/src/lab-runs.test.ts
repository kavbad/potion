// Lab run store (Step 3, 0035): claim/lease/fence semantics, cross-org
// non-readability, and cascade erasure — the review-outcome additions proven
// at the table layer, in the same commit as the tables.
import { describe, expect, it } from 'vitest';
import {
  answerLabRun,
  appendLabStep,
  claimLabRun,
  createDb,
  createLabRun,
  deleteOrgCascade,
  getLabMemory,
  getLabRun,
  killLabRun,
  LabFenceError,
  listLabSteps,
  migrate,
  transitionLabRun,
  type DbHandle,
} from './index.js';
import { seedIsolationOrgs, ORG_A, ORG_B } from './test-fixtures/orgs.js';

const HASH = 'a'.repeat(64);
const LEASE = 60_000;

async function setup(): Promise<DbHandle> {
  const h = await createDb();
  await migrate(h.db);
  await seedIsolationOrgs(h.db);
  await createLabRun(h.db, {
    id: 'run-1',
    orgId: ORG_A,
    harnessHash: HASH,
    harnessName: 'test harness',
    spec: { specVersion: 1, name: 'test harness' },
  });
  return h;
}

function claimArgs(over: Partial<Parameters<typeof claimLabRun>[1]> = {}) {
  return { runId: 'run-1', orgId: ORG_A, expectedHarnessHash: HASH, leaseMs: LEASE, ...over };
}

describe('claim / lease / fence (review addition 1)', () => {
  it('exactly one of two concurrent claims wins; the loser gets a typed refusal', async () => {
    const h = await setup();
    const first = await claimLabRun(h.db, claimArgs());
    expect(first.ok).toBe(true);
    const second = await claimLabRun(h.db, claimArgs());
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('claim-held');
    await h.close();
  });

  it('an EXPIRED lease is reclaimable, and the zombie winner is fenced out', async () => {
    const h = await setup();
    const t0 = new Date('2026-08-11T00:00:00Z');
    const zombie = await claimLabRun(h.db, claimArgs({ leaseMs: 1_000, now: t0 }));
    expect(zombie.ok).toBe(true);
    if (!zombie.ok) return;

    // Lease expires; a new invocation reclaims (fence bumps).
    const t1 = new Date(t0.getTime() + 5_000);
    const reclaimer = await claimLabRun(h.db, claimArgs({ now: t1 }));
    expect(reclaimer.ok).toBe(true);
    if (!reclaimer.ok) return;
    expect(reclaimer.fence).toBe(zombie.fence + 1);

    // The zombie wakes up and tries to write step 1 — REJECTED, not merged.
    await expect(
      appendLabStep(h.db, {
        runId: 'run-1',
        orgId: ORG_A,
        fence: zombie.fence,
        seq: 1,
        kind: 'model',
        payload: { from: 'zombie' },
        harnessHash: HASH,
        leaseMs: LEASE,
      }),
    ).rejects.toThrow(LabFenceError);

    // The reclaimer writes the same seq cleanly.
    await appendLabStep(h.db, {
      runId: 'run-1',
      orgId: ORG_A,
      fence: reclaimer.fence,
      seq: 1,
      kind: 'model',
      payload: { from: 'reclaimer' },
      harnessHash: HASH,
      leaseMs: LEASE,
    });
    const steps = await listLabSteps(h.db, 'run-1', ORG_A);
    expect(steps).toHaveLength(1);
    expect((steps[0]!.payload as { from: string }).from).toBe('reclaimer');
    await h.close();
  });

  it('appends are ordered: a gap or repeat rejects without writing', async () => {
    const h = await setup();
    const c = await claimLabRun(h.db, claimArgs());
    if (!c.ok) throw new Error('claim failed');
    const base = { runId: 'run-1', orgId: ORG_A, fence: c.fence, kind: 'model' as const, payload: {}, harnessHash: HASH, leaseMs: LEASE };
    await appendLabStep(h.db, { ...base, seq: 1 });
    await expect(appendLabStep(h.db, { ...base, seq: 3 })).rejects.toThrow(LabFenceError);
    await expect(appendLabStep(h.db, { ...base, seq: 1 })).rejects.toThrow(LabFenceError);
    expect(await listLabSteps(h.db, 'run-1', ORG_A)).toHaveLength(1);
    await h.close();
  });

  it('an OPERATOR KILL from outside fences the running invocation on its next write', async () => {
    const h = await setup();
    const c = await claimLabRun(h.db, claimArgs());
    if (!c.ok) throw new Error('claim failed');
    expect(await killLabRun(h.db, 'run-1', ORG_A)).toBe(true);
    await expect(
      appendLabStep(h.db, {
        runId: 'run-1', orgId: ORG_A, fence: c.fence, seq: 1, kind: 'model',
        payload: {}, harnessHash: HASH, leaseMs: LEASE,
      }),
    ).rejects.toThrow(LabFenceError);
    expect((await getLabRun(h.db, 'run-1', ORG_A))!.state).toBe('killed-operator');
    await h.close();
  });

  it('terminal means terminal: a killed run refuses claims with the fork remedy', async () => {
    const h = await setup();
    await killLabRun(h.db, 'run-1', ORG_A);
    const c = await claimLabRun(h.db, claimArgs());
    expect(!c.ok && c.reason).toBe('terminal');
    if (!c.ok) expect(c.detail).toContain('fork');
    await h.close();
  });

  it('spec drift refuses the resume (F7 applied to runs)', async () => {
    const h = await setup();
    const c = await claimLabRun(h.db, claimArgs({ expectedHarnessHash: 'b'.repeat(64) }));
    expect(!c.ok && c.reason).toBe('spec-drift');
    await h.close();
  });

  it('awaiting-human: claim refused until the answer lands, then consumed on transition', async () => {
    const h = await setup();
    const c = await claimLabRun(h.db, claimArgs());
    if (!c.ok) throw new Error('claim failed');
    await transitionLabRun(h.db, {
      runId: 'run-1', orgId: ORG_A, fence: c.fence,
      to: 'awaiting-human', question: 'Proceed with the external action?',
    });
    const refused = await claimLabRun(h.db, claimArgs());
    expect(!refused.ok && refused.reason).toBe('awaiting-answer');

    expect(await answerLabRun(h.db, 'run-1', ORG_A, 'yes, proceed')).toBe(true);
    // Answering twice is a caller bug, surfaced not absorbed.
    expect(await answerLabRun(h.db, 'run-1', ORG_A, 'again')).toBe(false);

    const resumed = await claimLabRun(h.db, claimArgs());
    expect(resumed.ok).toBe(true);
    if (resumed.ok) expect(resumed.pendingAnswer).toBe('yes, proceed');
    await h.close();
  });
});

describe('cross-org non-readability (review addition 3)', () => {
  it('runs, steps, and memory are invisible to the other org', async () => {
    const h = await setup();
    const c = await claimLabRun(h.db, claimArgs());
    if (!c.ok) throw new Error('claim failed');
    await appendLabStep(h.db, {
      runId: 'run-1', orgId: ORG_A, fence: c.fence, seq: 1, kind: 'model',
      payload: { secretish: 'org-a step content' }, harnessHash: HASH,
      memoryWrites: { learned: 'org-a memory' }, leaseMs: LEASE,
    });

    expect(await getLabRun(h.db, 'run-1', ORG_B)).toBeNull();
    expect(await listLabSteps(h.db, 'run-1', ORG_B)).toEqual([]);
    expect(await getLabMemory(h.db, ORG_B, HASH)).toEqual({});
    // …and org B cannot kill or answer org A's run.
    expect(await killLabRun(h.db, 'run-1', ORG_B)).toBe(false);
    expect(await answerLabRun(h.db, 'run-1', ORG_B, 'hijack')).toBe(false);
    // Same-harness memory is also invisible ACROSS ORGS by key structure.
    expect(await getLabMemory(h.db, ORG_A, HASH)).toEqual({ learned: 'org-a memory' });
    await h.close();
  });
});

describe('deletion cascade (the ruling: coverage proven at birth)', () => {
  it('deleteOrgCascade erases runs, steps, and memory, and reports counts', async () => {
    const h = await setup();
    const c = await claimLabRun(h.db, claimArgs());
    if (!c.ok) throw new Error('claim failed');
    await appendLabStep(h.db, {
      runId: 'run-1', orgId: ORG_A, fence: c.fence, seq: 1, kind: 'model',
      payload: {}, harnessHash: HASH, memoryWrites: { k: 'v' }, leaseMs: LEASE,
    });

    const report = await deleteOrgCascade(h.db, ORG_A);
    expect(report.deleted.lab_run_steps).toBe(1);
    expect(report.deleted.lab_runs).toBe(1);
    expect(report.deleted.lab_harness_memory).toBe(1);
    expect(await getLabRun(h.db, 'run-1', ORG_A)).toBeNull();
    await h.close();
  });
});
