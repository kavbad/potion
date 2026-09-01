// W1 — the Action Gateway laws (2026-08-31). The claim this phase makes
// real: ONE truth about what a worker may do. A native worker's EARNED
// grant now means something — and every decision is recorded with the
// snapshot it followed from, so replay re-derives it (A1). Step 12's
// consumption law is untouched: one-shot approvals still authorize only
// the exact call a human read; the gateway consults STANDING grants,
// fresh at act time.
import { describe, expect, it } from 'vitest';
import {
  acceptGraduation,
  answerLabRun,
  createDb,
  createLabRun,
  ensureActionGrant,
  getLabRun,
  listLabSteps,
  migrate,
  seedIsolationOrgs,
  tightenGrant,
  ORG_A,
  type DbHandle,
} from '@potion/db';
import { harnessSpecHash, type HarnessSpec } from '@potion/lab-spec';
import { decideAction } from './gateway.js';
import { runLeg, type LabTool } from './loop.js';
import { replayRun, type RecordedStep, type RecordedTerminal } from './replay.js';
import type { ServingClient, ServingRequest, ServingResult } from './serving-client.js';

function spec(over: Partial<HarnessSpec> = {}): HarnessSpec {
  return {
    specVersion: 1,
    name: 'gateway test harness',
    brain: { policy: { type: 'min_cost', qualityFloor: 0 } },
    mission: { kind: 'task', goal: 'do the thing', doneDefinition: 'done' },
    superpowers: [],
    memory: { enabled: false },
    rules: [],
    fuel: { maxUsdPerRun: 1, hardStop: true },
    checkIns: [{ trigger: 'before-external-action' }],
    ...over,
  };
}

function scripted(results: ServingResult[]): ServingClient {
  const queue = [...results];
  return {
    complete: async (_req: ServingRequest) => {
      const next = queue.shift();
      if (!next) throw new Error('scripted client exhausted');
      return next;
    },
    emitSpans: async () => true,
  } as unknown as ServingClient;
}

function ok(over: Partial<Extract<ServingResult, { kind: 'ok' }>> = {}): ServingResult {
  return {
    kind: 'ok',
    completionId: `chatcmpl-${Math.random().toString(36).slice(2, 10)}`,
    text: 'done.',
    toolCalls: [],
    finishReason: 'stop',
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    frontierTrace: 'cluster=code-gen;strategy=test;frontier=v1;policy=min_cost;fallback=0;provenance=mock',
    ...over,
  };
}

const ORG = ORG_A;

async function freshRun(s: HarnessSpec): Promise<{ h: DbHandle; hash: string }> {
  const h = await createDb();
  await migrate(h.db);
  await seedIsolationOrgs(h.db);
  const hash = harnessSpecHash(s);
  await createLabRun(h.db, { id: 'run-gate', orgId: ORG, harnessHash: hash, harnessName: s.name, spec: s });
  return { h, hash };
}

function emailCall(id = 'e1'): { id: string; type: 'function'; function: { name: string; arguments: string } } {
  return { id, type: 'function', function: { name: 'send_email', arguments: '{"to":"ops@example.com"}' } };
}

function emailTool(sent: { n: number }): LabTool {
  return {
    name: 'send_email', description: 'send an email', parameters: { type: 'object' },
    external: true,
    run: async () => { sent.n += 1; return { sent: true }; },
  };
}

async function grantAutonomy(h: DbHandle, hash: string, actionClass: string): Promise<string> {
  const g = await ensureActionGrant(h.db, { orgId: ORG, harnessHash: hash, actionClass, riskTier: 'reversible-act' });
  await acceptGraduation(h.db, g.id, {});
  return g.id;
}

async function recordOf(h: DbHandle): Promise<{ steps: RecordedStep[]; terminal: RecordedTerminal }> {
  const rows = await listLabSteps(h.db, 'run-gate', ORG);
  const run = (await getLabRun(h.db, 'run-gate', ORG))!;
  return {
    steps: rows.map((r) => ({ seq: r.seq, kind: r.kind, payload: r.payload })) as RecordedStep[],
    terminal: { state: run.state } as RecordedTerminal,
  };
}

describe('decideAction — the pure decision order', () => {
  const base = { actionClass: 'x', ceiling: 'earnable' as const, grantState: 'none' as const, auditRate: 1 };
  it('barred beats everything; blocked beats ask-forever; ceiling beats a mistaken autonomous row', () => {
    expect(decideAction({ ...base, ceiling: 'barred', grantState: 'autonomous' }, 0.5).decision).toBe('block');
    expect(decideAction({ ...base, grantState: 'blocked' }, 0.5).decision).toBe('block');
    expect(decideAction({ ...base, ceiling: 'ask-forever', grantState: 'autonomous' }, 0.5).decision).toBe('hold');
  });
  it('autonomous allows with the audit roll on the recorded sample, floored at 5%', () => {
    const low = decideAction({ ...base, grantState: 'autonomous', auditRate: 0 }, 0.04);
    expect(low).toEqual({ decision: 'allow', audit: true }); // 0.04 < floor 0.05
    const high = decideAction({ ...base, grantState: 'autonomous', auditRate: 0 }, 0.9);
    expect(high).toEqual({ decision: 'allow', audit: false });
    expect(decideAction({ ...base, grantState: 'autonomous', auditRate: 0.5 }, 0.4)).toEqual({ decision: 'allow', audit: true });
  });
  it('supervised and none hold — born supervised', () => {
    expect(decideAction({ ...base, grantState: 'supervised' }, 0.5).decision).toBe('hold');
    expect(decideAction(base, 0.5).decision).toBe('hold');
  });
});

describe('THE HEADLINE — a native worker with an earned grant acts alone', () => {
  it('accepted grant → the external tool runs WITHOUT parking; the tool step carries the gate justification; replay re-derives it', async () => {
    const s = spec();
    const { h, hash } = await freshRun(s);
    await grantAutonomy(h, hash, 'send_email');
    const sent = { n: 0 };
    const leg = await runLeg({
      db: h.db,
      client: scripted([
        ok({ text: '', finishReason: 'tool_calls', toolCalls: [emailCall()] }),
        ok({ text: 'sent the email; done.' }),
        ok({ text: 'Wrap-up: sent after earned autonomy; done.' }),
      ]),
      runId: 'run-gate', orgId: ORG, spec: s, harnessHash: hash, tools: [emailTool(sent)],
    });
    expect(leg.status, 'no park — the grant is honored').toBe('completed');
    expect(sent.n).toBe(1);
    const steps = await listLabSteps(h.db, 'run-gate', ORG);
    expect(steps.some((x) => x.kind === 'check-in'), 'no check-in fired').toBe(false);
    const toolStep = steps.find((x) => x.kind === 'tool')!;
    const gate = (toolStep.payload as { gate?: { decision: string; grantState: string; audit?: boolean; sample: number } }).gate;
    expect(gate).toBeDefined();
    expect(gate!.decision).toBe('allow');
    expect(gate!.grantState).toBe('autonomous');
    expect(typeof gate!.audit).toBe('boolean');
    const rec = await recordOf(h);
    const res = replayRun(s, rec.steps, rec.terminal);
    expect(res.ok, JSON.stringify(!res.ok ? res.divergences : [])).toBe(true);
    await h.close();
  }, 60_000);

  it('a TAMPERED gate decision is a replay divergence — the record carries WHY', async () => {
    const s = spec();
    const { h, hash } = await freshRun(s);
    await grantAutonomy(h, hash, 'send_email');
    const sent = { n: 0 };
    await runLeg({
      db: h.db,
      client: scripted([
        ok({ text: '', finishReason: 'tool_calls', toolCalls: [emailCall()] }),
        ok({ text: 'sent. done.' }),
        ok({ text: 'Wrap-up: done.' }),
      ]),
      runId: 'run-gate', orgId: ORG, spec: s, harnessHash: hash, tools: [emailTool(sent)],
    });
    const rec = await recordOf(h);
    // Tamper: claim the allow came from a SUPERVISED grant.
    const toolStep = rec.steps.find((x) => x.kind === 'tool')!;
    (toolStep.payload as { gate: { grantState: string } }).gate.grantState = 'supervised';
    const res = replayRun(s, rec.steps, rec.terminal);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.divergences.some((d) => d.field === 'gate')).toBe(true);
    await h.close();
  }, 60_000);
});

describe('act-time freshness — a tighten bites the very next action', () => {
  it('tightened between two calls: the first runs alone, the second parks', async () => {
    const s = spec();
    const { h, hash } = await freshRun(s);
    const grantId = await grantAutonomy(h, hash, 'send_email');
    const sent = { n: 0 };
    const tool: LabTool = {
      name: 'send_email', description: 'send an email', parameters: { type: 'object' },
      external: true,
      run: async () => {
        sent.n += 1;
        // The world changes MID-RUN: evidence arrived, the grant tightened.
        await tightenGrant(h.db, grantId, 'reversal detected on a sampled audit');
        return { sent: true };
      },
    };
    const leg = await runLeg({
      db: h.db,
      client: scripted([
        ok({ text: '', finishReason: 'tool_calls', toolCalls: [emailCall('e1')] }),
        ok({ text: '', finishReason: 'tool_calls', toolCalls: [emailCall('e2')] }),
      ]),
      runId: 'run-gate', orgId: ORG, spec: s, harnessHash: hash, tools: [tool],
    });
    expect(sent.n, 'first call ran under the grant').toBe(1);
    expect(leg.status, 'second call parks — the tighten bit immediately').toBe('awaiting-human');
    await h.close();
  }, 60_000);
});

describe('W2 — distribution membership at the loop', () => {
  it('an autonomous action OUTSIDE the demonstrated region parks with the OOD explanation; inside runs alone; the record replays clean', async () => {
    const s = spec();
    const { h, hash } = await freshRun(s);
    const grantId = await grantAutonomy(h, hash, 'send_email');
    const { setGrantSituations } = await import('@potion/db');
    // The pass has materialized: this class earned its trust on {to} sends.
    await setGrantSituations(h.db, grantId, ['send_email(to)']);
    const sent = { n: 0 };
    // Same class, DIFFERENT shape: {to, attachment} — outside the region.
    const oddCall = { id: 'e9', type: 'function' as const, function: { name: 'send_email', arguments: '{"to":"ops@example.com","attachment":"report.pdf"}' } };
    const leg = await runLeg({
      db: h.db,
      client: scripted([ok({ text: '', finishReason: 'tool_calls', toolCalls: [oddCall] })]),
      runId: 'run-gate', orgId: ORG, spec: s, harnessHash: hash, tools: [emailTool(sent)],
    });
    expect(leg.status).toBe('awaiting-human');
    if (leg.status === 'awaiting-human') {
      expect(leg.question).toContain('outside what this worker earned autonomy on');
    }
    expect(sent.n).toBe(0);

    // The demonstrated shape still runs alone.
    await answerLabRun(h.db, 'run-gate', ORG, 'yes');
    const leg2 = await runLeg({
      db: h.db,
      client: scripted([
        ok({ text: '', finishReason: 'tool_calls', toolCalls: [emailCall('e2')] }),
        ok({ text: 'sent. done.' }),
        ok({ text: 'Wrap-up: done.' }),
      ]),
      runId: 'run-gate', orgId: ORG, spec: s, harnessHash: hash, tools: [emailTool(sent)],
    });
    expect(leg2.status).toBe('completed');
    const steps = await listLabSteps(h.db, 'run-gate', ORG);
    const gated = steps.filter((x) => x.kind === 'tool' && (x.payload as { gate?: { decision?: string } }).gate?.decision === 'allow');
    expect(gated).toHaveLength(1);
    const gp = (gated[0]!.payload as { gate: { situation?: string; knownSituations?: string[] } }).gate;
    expect(gp.situation).toBe('send_email(to)');
    expect(gp.knownSituations).toEqual(['send_email(to)']);
    const rec = await recordOf(h);
    const res = replayRun(s, rec.steps, rec.terminal);
    expect(res.ok, JSON.stringify(!res.ok ? res.divergences : [])).toBe(true);
    await h.close();
  }, 60_000);
});

describe('the constitution', () => {
  it("ask-forever parks even over an 'autonomous' row — the ceiling out-ranks the record", async () => {
    const s = spec({ constitution: [{ action: 'send_email', maxAuthority: 'ask-forever' }] });
    const { h, hash } = await freshRun(s);
    await grantAutonomy(h, hash, 'send_email');
    const sent = { n: 0 };
    const leg = await runLeg({
      db: h.db,
      client: scripted([ok({ text: '', finishReason: 'tool_calls', toolCalls: [emailCall()] })]),
      runId: 'run-gate', orgId: ORG, spec: s, harnessHash: hash, tools: [emailTool(sent)],
    });
    expect(leg.status).toBe('awaiting-human');
    expect(sent.n).toBe(0);
    await h.close();
  }, 60_000);

  it('barred refuses typed, the model continues, and the record replays clean', async () => {
    const s = spec({ constitution: [{ action: 'send_email', maxAuthority: 'barred' }] });
    const { h, hash } = await freshRun(s);
    const sent = { n: 0 };
    const leg = await runLeg({
      db: h.db,
      client: scripted([
        ok({ text: '', finishReason: 'tool_calls', toolCalls: [emailCall()] }),
        ok({ text: 'Understood — email is barred for me; reporting the gap instead. done.' }),
        ok({ text: 'Wrap-up: barred action refused; reported honestly; done.' }),
      ]),
      runId: 'run-gate', orgId: ORG, spec: s, harnessHash: hash, tools: [emailTool(sent)],
    });
    expect(leg.status).toBe('completed');
    expect(sent.n, 'the barred tool must never run').toBe(0);
    const steps = await listLabSteps(h.db, 'run-gate', ORG);
    const toolStep = steps.find((x) => x.kind === 'tool')!;
    const p = toolStep.payload as { gate?: { decision: string }; toolOutput?: { error?: string } };
    expect(p.gate!.decision).toBe('block');
    expect(p.toolOutput!.error).toContain('constitution bars');
    const rec = await recordOf(h);
    const res = replayRun(s, rec.steps, rec.terminal);
    expect(res.ok, JSON.stringify(!res.ok ? res.divergences : [])).toBe(true);
    await h.close();
  }, 60_000);

  it('born supervised is no longer opt-in: an external call parks even when the spec lists NO check-ins', async () => {
    const s = spec({ checkIns: [] });
    const { h, hash } = await freshRun(s);
    const sent = { n: 0 };
    const leg = await runLeg({
      db: h.db,
      client: scripted([ok({ text: '', finishReason: 'tool_calls', toolCalls: [emailCall()] })]),
      runId: 'run-gate', orgId: ORG, spec: s, harnessHash: hash, tools: [emailTool(sent)],
    });
    expect(leg.status).toBe('awaiting-human');
    expect(sent.n).toBe(0);
    // The answer still resumes and executes the approved call — the pore's
    // consumption law is untouched by the gateway.
    await answerLabRun(h.db, 'run-gate', ORG, 'yes, send it');
    const leg2 = await runLeg({
      db: h.db,
      client: scripted([ok({ text: 'sent. done.' }), ok({ text: 'Wrap-up: done.' })]),
      runId: 'run-gate', orgId: ORG, spec: s, harnessHash: hash, tools: [emailTool(sent)],
    });
    expect(leg2.status).toBe('completed');
    expect(sent.n).toBe(1);
    await h.close();
  }, 60_000);
});
