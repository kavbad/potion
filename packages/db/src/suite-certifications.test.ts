// Suite-certification lifecycle tests (post-capstone item 3, migration
// 0031). PGlite, zero services. Covers: the demote-then-insert supersede
// transaction (partial unique never violated), failed/refused rows as
// permanent history, the gating predicate's version-invalidation contract,
// and the non-agent-cluster exemption.
import { describe, expect, it } from 'vitest';
import {
  activeCertificationForSuite,
  certificationStateForCluster,
  createDb,
  insertSuiteCertificationTx,
  listSuiteCertifications,
  migrate,
  upsertDerivedSuite,
  type DbHandle,
  type NewSuiteCertification,
} from './index.js';
import { seedIsolationOrgs, ORG_A, ORG_B } from './test-fixtures/orgs.js';

const ORG = ORG_A;
const CLUSTER = 'agent-abc123-def456';
const SUITE = `${CLUSTER}-replays-v2`;

async function migratedDb(): Promise<DbHandle> {
  const h = await createDb();
  await migrate(h.db);
  await seedIsolationOrgs(h.db);
  return h;
}

function certRow(over: Partial<NewSuiteCertification> = {}): NewSuiteCertification {
  return {
    orgId: ORG,
    clusterId: CLUSTER,
    suiteId: SUITE,
    suiteVersion: '1.0.0',
    incumbentHash: 'h-incumbent',
    providerMode: 'mock',
    status: 'certified',
    evidence: { selfRetentionMean: 0.95, floor: 0.9, items: 6, executed: 6 },
    ...over,
  };
}

async function seedSuite(h: DbHandle, version = '1.0.0'): Promise<void> {
  // upsertDerivedSuite CREATES at 1.0.0 (no bump on creation); each later
  // items-added round bumps the patch.
  await upsertDerivedSuite(h.db, {
    suiteId: SUITE,
    clusterId: CLUSTER,
    orgId: ORG,
    manifest: { suiteId: SUITE },
    items: [
      {
        id: `${SUITE}-item-1`,
        clusterId: CLUSTER,
        prompt: [{ role: 'user', content: 'x' }],
        reference: 'y',
        scoring: { kind: 'llm-judge', rubric: 'r', judgeModel: 'mock-judge', scale: [0, 1] },
      },
    ],
    itemCap: 10,
  });
  if (version !== '1.0.0') {
    // Additional bumps: add items until the requested patch version.
    const [, , patch] = version.split('.').map(Number);
    for (let i = 2; i <= (patch ?? 0) + 1; i++) {
      await upsertDerivedSuite(h.db, {
        suiteId: SUITE,
        clusterId: CLUSTER,
        orgId: ORG,
        manifest: { suiteId: SUITE },
        items: [
          {
            id: `${SUITE}-item-${i}`,
            clusterId: CLUSTER,
            prompt: [{ role: 'user', content: `x${i}` }],
            reference: 'y',
            scoring: { kind: 'llm-judge', rubric: 'r', judgeModel: 'mock-judge', scale: [0, 1] },
          },
        ],
        itemCap: 10,
      });
    }
  }
}

describe('suite_certifications lifecycle', () => {
  it('a new MEASUREMENT supersedes the prior pass in either direction; refusals demote nothing', async () => {
    const h = await migratedDb();
    const first = await insertSuiteCertificationTx(h.db, certRow());
    // A fresh FAILED measurement REVOKES the stale certification — a
    // certified badge surviving failed re-measurement would be dishonest.
    const failed = await insertSuiteCertificationTx(
      h.db,
      certRow({ status: 'failed', statusReason: 'self-retention 0.42 below floor 0.9' }),
    );
    let byId = new Map((await listSuiteCertifications(h.db, ORG)).map((r) => [r.id, r]));
    expect(byId.get(first)!.status).toBe('superseded');
    expect(byId.get(first)!.statusReason).toContain(`superseded by ${failed}`);
    expect(await activeCertificationForSuite(h.db, SUITE, ORG)).toBeNull();
    // A REFUSAL is the absence of a measurement — it demotes nothing.
    const second = await insertSuiteCertificationTx(h.db, certRow());
    await insertSuiteCertificationTx(
      h.db,
      certRow({
        status: 'failed',
        statusReason: 'refused-budget: no spend occurred',
        evidence: { refused: true, kind: 'budget-refused' },
      }),
    );
    byId = new Map((await listSuiteCertifications(h.db, ORG)).map((r) => [r.id, r]));
    expect(byId.get(second)!.status).toBe('certified'); // survived the refusal
    expect(byId.get(failed)!.status).toBe('failed'); // history untouched
    // The partial unique holds: exactly one active row, and the read is total.
    const active = await activeCertificationForSuite(h.db, SUITE, ORG);
    expect(active!.id).toBe(second);
    await h.close();
  });

  it('refused rows (evidence.refused) are failed-status history with the refusal recorded', async () => {
    const h = await migratedDb();
    await insertSuiteCertificationTx(
      h.db,
      certRow({
        status: 'failed',
        statusReason: 'refused-budget: hard-stop cap would be exceeded — no spend occurred',
        evidence: { refused: true, kind: 'budget-refused' },
        incumbentHash: null,
      }),
    );
    const rows = await listSuiteCertifications(h.db, ORG);
    expect(rows[0]!.status).toBe('failed');
    expect(rows[0]!.statusReason).toContain('refused-budget');
    expect(rows[0]!.evidence).toMatchObject({ refused: true });
    expect(await activeCertificationForSuite(h.db, SUITE, ORG)).toBeNull();
    await h.close();
  });
});

describe('certificationStateForCluster (the gating predicate)', () => {
  it('non-agent clusters are certified by construction — authored suites are out of scope', async () => {
    const h = await migratedDb();
    expect(await certificationStateForCluster(h.db, 'code-gen', ORG)).toEqual({
      certified: true,
      currentSuiteId: null,
      currentSuiteVersion: null,
    });
    await h.close();
  });

  it('agent cluster without an active certification → not certified, with the named reason', async () => {
    const h = await migratedDb();
    await seedSuite(h);
    const state = await certificationStateForCluster(h.db, CLUSTER, ORG);
    expect(state.certified).toBe(false);
    expect(state.reason).toContain('incumbent self-retention gate not passed');
    await h.close();
  });

  it('certification for the CURRENT suite version certifies; a re-derivation bump INVALIDATES it', async () => {
    const h = await migratedDb();
    await seedSuite(h); // version 1.0.0 (created)
    await insertSuiteCertificationTx(h.db, certRow({ suiteVersion: '1.0.0' }));
    const ok = await certificationStateForCluster(h.db, CLUSTER, ORG);
    expect(ok.certified).toBe(true);
    expect(ok.certification!.suiteVersion).toBe('1.0.0');
    // Re-derivation: a new item bumps the suite to 1.0.1 → invalid by key.
    await seedSuite(h, '1.0.1');
    const stale = await certificationStateForCluster(h.db, CLUSTER, ORG);
    expect(stale.certified).toBe(false);
    expect(stale.reason).toContain('re-derivation invalidates certification');
    await h.close();
  });

  it('another org cannot borrow a certification (org checked on suite AND row)', async () => {
    const h = await migratedDb();
    await seedSuite(h);
    await insertSuiteCertificationTx(h.db, certRow({ suiteVersion: '1.0.0' }));
    const state = await certificationStateForCluster(h.db, CLUSTER, ORG_B);
    expect(state.certified).toBe(false);
    await h.close();
  });

  it('distinguishes NEVER-certified from certified-on-an-EARLIER-generation (F11)', async () => {
    const h = await migratedDb();
    await seedSuite(h); // v2 suite at 1.0.0 (SUITE is the -replays-v2 id)
    // Never certified: the generic reason tells the customer to run the job.
    const never = await certificationStateForCluster(h.db, CLUSTER, ORG);
    expect(never.certified).toBe(false);
    expect(never.reason).toContain('run suite:certify');
    expect(never.currentSuiteId).toBe(SUITE);
    expect(never.currentSuiteVersion).toBe('1.0.0');

    // Certified on the V1 generation, while the cluster now resolves to v2.
    // derivedSuiteIdFor flips the moment v2 has an item — no version bump and
    // no row change — so this used to fall into the SAME generic branch and
    // told the customer to run a job they had already run.
    await insertSuiteCertificationTx(h.db, certRow({ suiteId: `${CLUSTER}-replays-v1`, suiteVersion: '1.0.0' }));
    const stale = await certificationStateForCluster(h.db, CLUSTER, ORG);
    expect(stale.certified).toBe(false);
    expect(stale.reason).toContain('-replays-v1');
    expect(stale.reason).toContain('suite generation changed');
    expect(stale.reason).toContain('re-certify'); // the correct remedy
    expect(stale.certification!.suiteId).toBe(`${CLUSTER}-replays-v1`);
    expect(stale.currentSuiteId).toBe(SUITE);
    await h.close();
  });

  it('carries the CURRENT instrument on every agent-cluster branch', async () => {
    const h = await migratedDb();
    // No derived suite at all: still reports what it resolved to.
    const none = await certificationStateForCluster(h.db, CLUSTER, ORG);
    expect(none.certified).toBe(false);
    expect(none.currentSuiteId).toBe(`${CLUSTER}-replays-v1`); // no v2 items yet
    // Certified and current.
    await seedSuite(h);
    await insertSuiteCertificationTx(h.db, certRow({ suiteVersion: '1.0.0' }));
    const ok = await certificationStateForCluster(h.db, CLUSTER, ORG);
    expect(ok).toMatchObject({ certified: true, currentSuiteId: SUITE, currentSuiteVersion: '1.0.0' });
    await h.close();
  });
});
