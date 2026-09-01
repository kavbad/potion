// W2 — evidence honesty (2026-08-31). Approval ≠ correctness. The laws:
//   · the AUTONOMOUS stream is evidence: a gate-allowed execution that
//     errored is a machine-observed failure; a clean one buys NOTHING
//     (a 200 proves the API worked, not that the action was right);
//   · reports (outcomes, reversals, incidents, audit verdicts) map into
//     the same vocabulary — incidents are high-stakes, the veto path;
//   · a reversal report on an autonomous class TIGHTENS at the next pass;
//   · the demonstrated-situation view materializes from positive evidence
//     and the gateway holds autonomous actions outside it.
import { describe, expect, it } from 'vitest';
import {
  acceptGraduation,
  createDb,
  createLabRun,
  ensureActionGrant,
  insertEvidenceReport,
  listActionGrants,
  migrate,
  seedIsolationOrgs,
  ORG_A,
} from '@potion/db';
import { harnessSpecHash, type HarnessSpec } from '@potion/lab-spec';
import {
  demonstratedSituations,
  evidenceFromReports,
  extractPoreEvidence,
  mergeEvidence,
  type EvidenceStep,
} from './evidence.js';
import { decideAction, situationSignature } from './gateway.js';
import { runGraduationPass } from './apply-graduation.js';
import type { StepPayload } from './checkpoint.js';

const T0 = new Date('2026-08-30T00:00:00Z');
const later = (m: number) => new Date(T0.getTime() + m * 60_000);

function gateStep(minute: number, over: Partial<NonNullable<StepPayload['gate']>> = {}, toolOutput: unknown = { ok: true }): EvidenceStep {
  return {
    createdAt: later(minute),
    payload: {
      kind: 'tool',
      toolName: 'send_email',
      toolOutput,
      gate: {
        actionClass: 'send_email', ceiling: 'earnable', grantState: 'autonomous',
        auditRate: 0.05, decision: 'allow', audit: false, sample: 0.5,
        situation: 'send_email(body,to)',
        ...over,
      },
    } as StepPayload,
  };
}

describe('the autonomous stream', () => {
  it('an errored gate-allowed execution is exec-failed evidence; a clean one buys nothing', () => {
    const byClass = extractPoreEvidence([
      gateStep(1, {}, { sent: true }),
      gateStep(2, {}, { error: 'SMTP 550 rejected' }),
      gateStep(3, {}, { sent: true }),
    ]);
    const ev = byClass.get('send_email') ?? [];
    expect(ev).toHaveLength(1);
    expect(ev[0]!.outcome).toBe('exec-failed');
    expect(ev[0]!.situationSignature).toBe('send_email(body,to)');
  });
});

describe('reports map into the vocabulary', () => {
  it('outcome-ok/audit-clean buy trust; reversal/audit-flagged fail; incident is high-stakes', () => {
    const m = evidenceFromReports([
      { actionClass: 'a', kind: 'outcome-ok', createdAt: T0 },
      { actionClass: 'a', kind: 'audit-clean', createdAt: T0 },
      { actionClass: 'a', kind: 'reversal', createdAt: T0 },
      { actionClass: 'a', kind: 'audit-flagged', createdAt: T0 },
      { actionClass: 'a', kind: 'incident', createdAt: T0 },
    ]);
    const ev = m.get('a')!;
    expect(ev.map((e) => e.outcome)).toEqual(['validated', 'validated', 'reversed', 'reversed', 'reversed']);
    expect(ev[1]!.fromAudit).toBe(true);
    expect(ev[3]!.fromAudit).toBe(true);
    expect(ev[4]!.highStakes, 'an incident vetoes regardless of rate').toBe(true);
  });

  it('mergeEvidence keeps one time-ordered stream per class', () => {
    const merged = mergeEvidence(
      new Map([['a', [{ at: later(10), outcome: 'approved' as const, highStakes: false }]]]),
      new Map([['a', [{ at: later(5), outcome: 'validated' as const, highStakes: false }]]]),
    );
    expect(merged.get('a')!.map((e) => e.outcome)).toEqual(['validated', 'approved']);
  });
});

describe('demonstrated situations', () => {
  it('positive evidence contributes its signature; failures never widen the region', () => {
    const sigs = demonstratedSituations([
      { at: T0, outcome: 'approved', highStakes: false, situationSignature: 'act(kind,ref):click' },
      { at: T0, outcome: 'validated', highStakes: false, situationSignature: 'act(kind,ref):click' },
      { at: T0, outcome: 'rejected', highStakes: false, situationSignature: 'act(kind,ref,text):type' },
      { at: T0, outcome: 'exec-failed', highStakes: false, situationSignature: 'act(kind,ref):press' },
    ]);
    expect(sigs).toEqual(['act(kind,ref):click']);
  });

  it('the gateway holds an autonomous action outside the demonstrated region', () => {
    const base = { actionClass: 'browser_act', ceiling: 'earnable' as const, grantState: 'autonomous' as const, auditRate: 0.05 };
    const known = ['browser_act(kind,ref):click'];
    expect(decideAction({ ...base, situation: 'browser_act(kind,ref):click', knownSituations: known }, 0.9).decision).toBe('allow');
    expect(decideAction({ ...base, situation: 'browser_act(kind,ref,text):type', knownSituations: known }, 0.9).decision).toBe('hold');
    // No demonstrated set yet → no boundary to enforce.
    expect(decideAction({ ...base, situation: 'browser_act(kind,ref,text):type' }, 0.9).decision).toBe('allow');
  });

  it('situationSignature: sorted keys + the small kind discriminator', () => {
    expect(situationSignature('browser_act', { ref: 'p1', kind: 'click' })).toBe('browser_act(kind,ref):click');
    expect(situationSignature('browser_act', { kind: 'type', text: 'x', ref: 'p2' })).toBe('browser_act(kind,ref,text):type');
    expect(situationSignature('github_pr', { repo: 'a/b', branch: 'x', title: 't', paths: [] })).toBe('github_pr(branch,paths,repo,title)');
  });
});

describe('the pass: reports tighten, situations materialize', () => {
  const spec: HarnessSpec = {
    specVersion: 1, name: 'w2 pass harness',
    brain: { policy: { type: 'min_cost', qualityFloor: 0 } },
    mission: { kind: 'task', goal: 'x', doneDefinition: 'x' },
    superpowers: [], memory: { enabled: false }, rules: [],
    fuel: { maxUsdPerRun: 1, hardStop: true }, checkIns: [],
  };

  it('a reversal report on an autonomous class tightens at the very next pass', async () => {
    const h = await createDb();
    await migrate(h.db);
    await seedIsolationOrgs(h.db);
    const hash = harnessSpecHash(spec);
    await createLabRun(h.db, { id: 'run-w2', orgId: ORG_A, harnessHash: hash, harnessName: spec.name, spec });
    const g = await ensureActionGrant(h.db, { orgId: ORG_A, harnessHash: hash, actionClass: 'send_email', riskTier: 'reversible-act' });
    await acceptGraduation(h.db, g.id, {});
    await insertEvidenceReport(h.db, {
      orgId: ORG_A, harnessHash: hash, runId: 'run-w2', actionClass: 'send_email',
      kind: 'reversal', detail: 'customer replied: wrong recipient — recalled', reportedBy: 'test',
    });
    const result = await runGraduationPass({ db: h.db, orgId: ORG_A, harnessHash: hash, classify: () => 'act' });
    expect(result.tightened.some((t) => t.actionClass === 'send_email')).toBe(true);
    const after = (await listActionGrants(h.db, ORG_A, hash)).find((x) => x.actionClass === 'send_email')!;
    expect(after.state).toBe('supervised');
    expect(after.stateReason).toContain('reversed');
    await h.close();
  }, 60_000);
});

describe('W2 correction — uncertainty alone never revokes a human grant', () => {
  const now = new Date('2026-08-31T12:00:00Z');
  it('a freshly-accepted grant with one clean approval HOLDS autonomous (lower bound 0.147 is ignorance, not indictment)', async () => {
    const { graduationDecision } = await import('./graduation.js');
    const d = graduationDecision({
      tier: 'reversible-act', state: 'autonomous', now,
      evidence: [{ at: new Date(now.getTime() - 3_600_000), outcome: 'approved', highStakes: false }],
    });
    expect(d.kind, 'no failure in window → the human grant stands').toBe('hold');
  });
  it('the same thin window WITH a failure still tightens — failures indict', async () => {
    const { graduationDecision } = await import('./graduation.js');
    const d = graduationDecision({
      tier: 'reversible-act', state: 'autonomous', now,
      evidence: [
        { at: new Date(now.getTime() - 3_600_000), outcome: 'approved', highStakes: false },
        { at: new Date(now.getTime() - 1_800_000), outcome: 'exec-failed', highStakes: false },
      ],
    });
    expect(d.kind).toBe('tighten');
  });
});

describe('W2 correction — known evidence never re-indicts', () => {
  const now = new Date('2026-08-31T12:00:00Z');
  const hourAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
  it('a reversal the grantor already saw does not revoke a re-grant; a NEW one does', async () => {
    const { graduationDecision } = await import('./graduation.js');
    const before = graduationDecision({
      tier: 'reversible-act', state: 'autonomous', now, grantedAt: hourAgo(1),
      evidence: [
        { at: hourAgo(5), outcome: 'approved', highStakes: false },
        { at: hourAgo(3), outcome: 'reversed', highStakes: false }, // predates the grant
      ],
    });
    expect(before.kind, 'the grantor read the ledger — known evidence stands').toBe('hold');
    const after = graduationDecision({
      tier: 'reversible-act', state: 'autonomous', now, grantedAt: hourAgo(1),
      evidence: [
        { at: hourAgo(5), outcome: 'approved', highStakes: false },
        { at: hourAgo(0.5), outcome: 'reversed', highStakes: false }, // NEW signal
      ],
    });
    expect(after.kind).toBe('tighten');
    if (after.kind === 'tighten') expect(after.why).toContain('reversed');
  });
});
