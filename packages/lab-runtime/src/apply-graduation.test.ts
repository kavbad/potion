// L-G2 end-to-end: supervision traffic in PGlite → evidence → decisions →
// the asymmetry applied for real. Steps are inserted directly (the fencing
// discipline is loop.test.ts's subject, not this one's).
import { beforeAll, describe, expect, it } from 'vitest';
import {
  acceptGraduation,
  createDb,
  createLabRun,
  GRANT_AUDIT_RATE_FLOOR,
  labRunSteps,
  listActionGrants,
  migrate,
  seedIsolationOrgs,
  ORG_A,
  type DbHandle,
} from '@potion/db';
import { AUDIT_RATE_FLOOR } from './graduation.js';
import { runGraduationPass } from './apply-graduation.js';

const HASH = 'hash-lg2-test';
let h: DbHandle;
let seq = 0;

async function insertStep(payload: Record<string, unknown>, at: Date) {
  seq += 1;
  await h.db.insert(labRunSteps).values({
    runId: 'run-lg2', orgId: ORG_A, seq, kind: (payload.kind as 'model' | 'tool' | 'check-in'), payload, createdAt: at,
  });
}

const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);

async function pore(toolName: string, argsHash: string, answer: string, at: Date) {
  await insertStep({ kind: 'check-in', checkInTrigger: 'before-external-action', checkInAction: { toolName, argsHash, arguments: '{}' }, clockMs: 0, rngSample: 0 }, at);
  await insertStep({ kind: 'model', checkInAnswer: answer, clockMs: 0, rngSample: 0 }, at);
}

const classify = (cls: string): 'read' | 'act' | undefined =>
  cls.includes('lookup') ? 'read' : cls.includes('send') || cls.includes('wire') ? 'act' : undefined;

beforeAll(async () => {
  h = await createDb();
  await migrate(h.db);
  await seedIsolationOrgs(h.db);
  await createLabRun(h.db, { id: 'run-lg2', orgId: ORG_A, harnessHash: HASH, harnessName: 'lg2', spec: {} });
  // 30 clean approvals on a read tool — clears reversible-read (minN 25).
  for (let i = 0; i < 30; i++) await pore('crm:lookup', `l${i}`, 'yes', daysAgo(10));
  // A thin, imperfect record on an act tool — nowhere near its bar.
  await pore('email:send', 'e1', 'yes', daysAgo(8));
  await pore('email:send', 'e2', 'no — wrong recipient', daysAgo(8));
  // A perfect record on a class the spec marks never-graduates.
  for (let i = 0; i < 40; i++) await pore('payments:wire', `w${i}`, 'yes', daysAgo(6));
}, 60_000);

describe('runGraduationPass', () => {
  it('creates supervised grants, proposes only the earned class, grants nothing', async () => {
    const r = await runGraduationPass({
      db: h.db, orgId: ORG_A, harnessHash: HASH, classify,
      tierOverrides: { 'payments:wire': 'never-graduates' },
    });
    expect(r.proposals.map((p) => p.actionClass)).toEqual(['crm:lookup']);
    expect(r.tightened).toEqual([]);
    const wire = r.evaluated.find((e) => e.actionClass === 'payments:wire')!;
    expect(wire.decision).toBe('never');
    const grants = await listActionGrants(h.db, ORG_A, HASH);
    expect(grants.every((g) => g.state === 'supervised')).toBe(true); // proposals grant NOTHING
  });

  it('acceptGraduation is the only loosening path, and the audit floor holds', async () => {
    const r = await runGraduationPass({ db: h.db, orgId: ORG_A, harnessHash: HASH, classify, tierOverrides: { 'payments:wire': 'never-graduates' } });
    const granted = await acceptGraduation(h.db, r.proposals[0]!.grantId, { auditRate: 0 });
    expect(granted.state).toBe('autonomous');
    expect(granted.auditRate).toBe(GRANT_AUDIT_RATE_FLOOR); // 0 was requested; the floor won
  });

  it('never-graduates refuses even the human-accept path', async () => {
    const grants = await listActionGrants(h.db, ORG_A, HASH);
    const wire = grants.find((g) => g.actionClass === 'payments:wire')!;
    await expect(acceptGraduation(h.db, wire.id)).rejects.toThrow(/never graduates/);
  });

  it('a fresh rejection burst re-supervises the autonomous class automatically', async () => {
    await pore('crm:lookup', 'bad1', 'no', daysAgo(1));
    await pore('crm:lookup', 'bad2', 'no', daysAgo(0));
    const r = await runGraduationPass({ db: h.db, orgId: ORG_A, harnessHash: HASH, classify, tierOverrides: { 'payments:wire': 'never-graduates' } });
    expect(r.tightened.map((t) => t.actionClass)).toEqual(['crm:lookup']);
    const grants = await listActionGrants(h.db, ORG_A, HASH);
    const crm = grants.find((g) => g.actionClass === 'crm:lookup')!;
    expect(crm.state).toBe('supervised');
    expect(crm.auditRate).toBe(1);
    expect(crm.revokedAt).not.toBeNull();
  });
});

describe('cross-package invariants', () => {
  it('the db-side audit floor never diverges from the evaluator’s', () => {
    expect(GRANT_AUDIT_RATE_FLOOR).toBe(AUDIT_RATE_FLOOR);
  });
});
