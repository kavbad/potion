// G2.2 incident-SLA repo primitives: the incident row as durable lifecycle
// ledger (verify attempts, throttle stamps), once-only escalation CAS
// (starved verification + recovery-unconfirmed), kind-checked evidence
// resolution, and the open-incident readers the sweep passes build on.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendIncidentVerifyAttempt,
  createDb,
  createOrg,
  getIncidentByIdForOrg,
  insertIncident,
  insertIncidentRow,
  listOpenAdvisories,
  markAdvisoryEscalated,
  markRecoveryUnconfirmed,
  migrate,
  openContractualIncidentForTuple,
  resolveIncident,
  resolveIncidentWithEvidence,
  stampIncidentDetail,
  VERIFY_ATTEMPTS_KEPT,
  type DbHandle,
} from './index.js';

const ORG = 'org_sla';
const OTHER = 'org_sla_other';

let handle: DbHandle;
const db = () => handle.db;

function tupleDetail(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { policyId: 'pol-s', clusterId: 'agent-x', fromStrategy: 'sha-serving', ...over };
}

async function advisory(over: Record<string, unknown> = {}): Promise<string> {
  return insertIncident(db(), { orgId: ORG, kind: 'advisory', detail: tupleDetail(over) });
}

beforeEach(async () => {
  handle = await createDb();
  await migrate(handle.db);
  await createOrg(db(), { id: ORG, name: 'SLA' });
  await createOrg(db(), { id: OTHER, name: 'Other' });
});

afterEach(async () => {
  await handle.close();
});

describe('insertIncidentRow', () => {
  it('returns the full row incl. the db createdAt (the SLA clock source)', async () => {
    const row = await insertIncidentRow(db(), { orgId: ORG, kind: 'advisory', detail: tupleDetail() });
    expect(row.id).toBeTruthy();
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.resolvedAt).toBeNull();
  });
});

describe('appendIncidentVerifyAttempt (the durable ledger)', () => {
  it('appends, stamps lastVerifyAttemptAt, caps the ledger, refuses resolved rows', async () => {
    const id = await advisory();
    const first = await appendIncidentVerifyAttempt(db(), ORG, id, {
      at: '2026-08-08T00:00:00.000Z',
      outcome: 'budget-refused',
      detail: 'hard-stop budget would be exceeded — no spend occurred',
    });
    expect(first).not.toBeNull();
    const d1 = first!.detail as Record<string, unknown>;
    expect(d1.verifyAttempts).toHaveLength(1);
    expect(d1.lastVerifyAttemptAt).toBe('2026-08-08T00:00:00.000Z');
    // Cap: oldest dropped past VERIFY_ATTEMPTS_KEPT.
    for (let i = 0; i < VERIFY_ATTEMPTS_KEPT + 5; i++) {
      await appendIncidentVerifyAttempt(db(), ORG, id, {
        at: `2026-08-08T00:${String(i + 1).padStart(2, '0')}:00.000Z`,
        outcome: 'no-suite',
        detail: null,
      });
    }
    const row = await getIncidentByIdForOrg(db(), ORG, id);
    const attempts = (row!.detail as Record<string, unknown>).verifyAttempts as unknown[];
    expect(attempts).toHaveLength(VERIFY_ATTEMPTS_KEPT);
    // The original tuple keys survive the merges.
    expect((row!.detail as Record<string, unknown>).policyId).toBe('pol-s');
    // Resolved rows refuse.
    await resolveIncident(db(), ORG, id);
    expect(
      await appendIncidentVerifyAttempt(db(), ORG, id, { at: 'x', outcome: 'y', detail: null }),
    ).toBeNull();
    // Cross-org refuses.
    const id2 = await advisory();
    expect(
      await appendIncidentVerifyAttempt(db(), OTHER, id2, { at: 'x', outcome: 'y', detail: null }),
    ).toBeNull();
  });
});

describe('stampIncidentDetail', () => {
  it('merges the patch into open rows only', async () => {
    const id = await advisory();
    const stamped = await stampIncidentDetail(db(), ORG, id, { verifyEnqueuedAt: 't1' });
    expect((stamped!.detail as Record<string, unknown>).verifyEnqueuedAt).toBe('t1');
    expect((stamped!.detail as Record<string, unknown>).policyId).toBe('pol-s');
    await resolveIncident(db(), ORG, id);
    expect(await stampIncidentDetail(db(), ORG, id, { verifyEnqueuedAt: 't2' })).toBeNull();
  });
});

describe('escalation CAS (once-only, race-safe)', () => {
  it('markAdvisoryEscalated: first call wins, second returns null; resolved/wrong-kind refuse', async () => {
    const id = await advisory();
    const stamp = { at: '2026-08-08T01:00:00.000Z', verifySlaMin: 240, ageMin: 300, verifyAttempts: 4 };
    const won = await markAdvisoryEscalated(db(), ORG, id, stamp);
    expect(won).not.toBeNull();
    expect((won!.detail as Record<string, unknown>).escalation).toMatchObject({ ageMin: 300 });
    // Second call loses — the winner is the sole emitter.
    expect(await markAdvisoryEscalated(db(), ORG, id, stamp)).toBeNull();
    // The stamp coexists with the original detail.
    const row = await getIncidentByIdForOrg(db(), ORG, id);
    expect((row!.detail as Record<string, unknown>).policyId).toBe('pol-s');
    // Wrong kind refuses.
    const rb = await insertIncident(db(), { orgId: ORG, kind: 'rollback', detail: tupleDetail() });
    expect(await markAdvisoryEscalated(db(), ORG, rb, stamp)).toBeNull();
    // Resolved refuses.
    const id2 = await advisory();
    await resolveIncident(db(), ORG, id2);
    expect(await markAdvisoryEscalated(db(), ORG, id2, stamp)).toBeNull();
  });

  it('markRecoveryUnconfirmed stamps rollback rows once', async () => {
    const rb = await insertIncident(db(), { orgId: ORG, kind: 'rollback', detail: tupleDetail() });
    const stamp = { at: '2026-08-08T02:00:00.000Z', consecutiveNonConfident: 3, floor: 0.9 };
    expect(await markRecoveryUnconfirmed(db(), ORG, rb, stamp)).not.toBeNull();
    expect(await markRecoveryUnconfirmed(db(), ORG, rb, stamp)).toBeNull();
  });
});

describe('resolveIncidentWithEvidence', () => {
  it('kind-checked, only-if-open, merge preserves the accumulated ledger', async () => {
    const id = await advisory();
    await appendIncidentVerifyAttempt(db(), ORG, id, { at: 't1', outcome: 'budget-refused', detail: null });
    await markAdvisoryEscalated(db(), ORG, id, { at: 't2', verifySlaMin: 240, ageMin: 500, verifyAttempts: 1 });
    // Wrong kind refuses (the row stays open).
    expect(await resolveIncidentWithEvidence(db(), ORG, id, 'rollback', { verdict: 'x' })).toBeNull();
    const resolved = await resolveIncidentWithEvidence(db(), ORG, id, 'advisory', {
      verdict: 'all-clear',
      providerMode: 'mock',
    });
    expect(resolved!.resolvedAt).not.toBeNull();
    const d = resolved!.detail as Record<string, unknown>;
    // The ledger and escalation stamp SURVIVE resolution (merge pin).
    expect(d.verifyAttempts).toHaveLength(1);
    expect(d.escalation).toBeTruthy();
    expect((d.resolution as Record<string, unknown>).verdict).toBe('all-clear');
    // Already resolved → null.
    expect(await resolveIncidentWithEvidence(db(), ORG, id, 'advisory', { verdict: 'y' })).toBeNull();
  });
});

describe('open-incident readers', () => {
  it('listOpenAdvisories: oldest first, org-scoped, resolved excluded', async () => {
    const a = await advisory({ n: 1 });
    const b = await advisory({ n: 2 });
    const c = await advisory({ n: 3 });
    await resolveIncident(db(), ORG, b);
    await insertIncident(db(), { orgId: OTHER, kind: 'advisory', detail: tupleDetail() });
    await insertIncident(db(), { orgId: ORG, kind: 'rollback', detail: tupleDetail() });
    const mine = await listOpenAdvisories(db(), ORG);
    expect(mine.map((r) => r.id)).toEqual([a, c]); // oldest first, b resolved
    const all = await listOpenAdvisories(db());
    expect(all).toHaveLength(3); // + the other org's
  });

  it('openContractualIncidentForTuple: contractual kinds only, open only, tuple-keyed', async () => {
    await advisory(); // advisory on the tuple must not match
    const scope = { orgId: ORG, policyId: 'pol-s', clusterId: 'agent-x', fromStrategy: 'sha-serving' };
    expect(await openContractualIncidentForTuple(db(), scope)).toBeNull();
    const rb = await insertIncident(db(), { orgId: ORG, kind: 'rollback', detail: tupleDetail() });
    expect((await openContractualIncidentForTuple(db(), scope))?.id).toBe(rb);
    expect(
      await openContractualIncidentForTuple(db(), { ...scope, fromStrategy: 'sha-other' }),
    ).toBeNull();
    await resolveIncident(db(), ORG, rb);
    expect(await openContractualIncidentForTuple(db(), scope)).toBeNull();
  });
});
