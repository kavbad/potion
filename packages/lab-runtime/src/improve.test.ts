// W3 — the improve engine laws (2026-09-01). Corrections are defect
// reports; a generation never changes — learning reproduces; every
// proposal carries noticed/change/why and countable evidence.
import { describe, expect, it } from 'vitest';
import type { HarnessSpec } from '@potion/lab-spec';
import { harnessSpecHash } from '@potion/lab-spec';
import {
  buildDescendantSpec,
  buildShadowStub,
  deriveImprovements,
  inheritGrantPlan,
  recordedActOutputs,
  type ImproveStep,
} from './improve.js';
import type { StepPayload } from './checkpoint.js';

const SPEC: HarnessSpec = {
  specVersion: 1, name: 'improve harness',
  brain: { policy: { type: 'min_cost', qualityFloor: 0 } },
  mission: { kind: 'task', goal: 'open the app and do the task', doneDefinition: 'done' },
  superpowers: [], memory: { enabled: false }, rules: ['be terse'],
  fuel: { maxUsdPerRun: 1, hardStop: true }, checkIns: [],
};

const T = new Date('2026-08-31T00:00:00Z');
function step(runId: string, payload: Partial<StepPayload> & { kind: StepPayload['kind'] }): ImproveStep {
  return { runId, payload: payload as StepPayload, createdAt: T };
}
const ask = (runId: string, q: string) => step(runId, { kind: 'check-in', checkInTrigger: 'worker-question', checkInQuestion: q });
const answer = (runId: string, a: string) => step(runId, { kind: 'model', checkInAnswer: a });
const pore = (runId: string, cls: string) => step(runId, { kind: 'check-in', checkInTrigger: 'before-external-action', checkInAction: { toolName: cls, argsHash: 'h', arguments: '{}' } });

describe('detector 1 — the recurring worker question', () => {
  it('the same question across 2 runs proposes folding the operator’s answer in; one run does not', () => {
    const twice = deriveImprovements(SPEC, [
      ask('r1', 'What URL should I open?'), answer('r1', 'https://board.example'),
      ask('r2', 'What URL should I open today?'), answer('r2', 'https://board.example'),
    ]);
    expect(twice).toHaveLength(1);
    expect(twice[0]!.mutation.type).toBe('instruction');
    expect(twice[0]!.mutation.noticed).toContain('2 separate runs');
    expect(String(twice[0]!.mutation.change.appendRule)).toContain('https://board.example');
    const once = deriveImprovements(SPEC, [ask('r1', 'What URL should I open?'), answer('r1', 'x')]);
    expect(once).toHaveLength(0);
  });

  it('an unanswered recurring question proposes nothing — no answer to fold in', () => {
    expect(deriveImprovements(SPEC, [ask('r1', 'Which board?'), ask('r2', 'Which board?')])).toHaveLength(0);
  });
});

describe('detector 2 — the always-refused class', () => {
  it('2 refusals + 0 approvals proposes ask-forever; any approval cancels it; an existing pin dedupes', () => {
    const refused = deriveImprovements(SPEC, [
      pore('r1', 'send_email'), answer('r1', 'no, never email them'),
      pore('r2', 'send_email'), answer('r2', 'no'),
    ]);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.mutation.type).toBe('constitution');
    expect(refused[0]!.mutation.change).toEqual({ action: 'send_email', maxAuthority: 'ask-forever' });

    const mixed = deriveImprovements(SPEC, [
      pore('r1', 'send_email'), answer('r1', 'no'),
      pore('r2', 'send_email'), answer('r2', 'no'),
      pore('r3', 'send_email'), answer('r3', 'yes, this one is fine'),
    ]);
    expect(mixed).toHaveLength(0);

    const pinned = deriveImprovements(
      { ...SPEC, constitution: [{ action: 'send_email', maxAuthority: 'ask-forever' }] },
      [pore('r1', 'send_email'), answer('r1', 'no'), pore('r2', 'send_email'), answer('r2', 'no')],
    );
    expect(pinned).toHaveLength(0);
  });
});

describe('the descendant', () => {
  it('an instruction mutation appends the rule; the parent is untouched; the hash moves', () => {
    const child = buildDescendantSpec(SPEC, {
      type: 'instruction', summary: 's', noticed: 'n', why: 'w',
      change: { appendRule: 'Standing answer: use https://board.example' },
    });
    expect(child.rules).toHaveLength(2);
    expect(SPEC.rules).toHaveLength(1);
    expect(harnessSpecHash(child)).not.toBe(harnessSpecHash(SPEC));
  });
  it('a constitution mutation replaces the entry for that class only', () => {
    const parent = { ...SPEC, constitution: [{ action: 'a', maxAuthority: 'earnable' as const }, { action: 'b', maxAuthority: 'earnable' as const }] };
    const child = buildDescendantSpec(parent, {
      type: 'constitution', summary: 's', noticed: 'n', why: 'w',
      change: { action: 'b', maxAuthority: 'ask-forever' },
    });
    expect(child.constitution).toContainEqual({ action: 'a', maxAuthority: 'earnable' });
    expect(child.constitution).toContainEqual({ action: 'b', maxAuthority: 'ask-forever' });
  });
});

describe('selective trust inheritance v1 — spec-section granularity', () => {
  const grants = [
    { actionClass: 'browser_open', state: 'autonomous', riskTier: 'reversible-read' },
    { actionClass: 'browser_act', state: 'autonomous', riskTier: 'reversible-act' },
    { actionClass: 'github_pr', state: 'supervised', riskTier: 'reversible-act' },
  ];
  it('an instruction mutation re-proves act classes and preserves read classes', () => {
    const plan = inheritGrantPlan({ type: 'instruction', summary: '', noticed: '', why: '', change: {} }, grants);
    expect(plan.find((p) => p.actionClass === 'browser_open')!.preserve).toBe(true);
    expect(plan.find((p) => p.actionClass === 'browser_act')!.preserve).toBe(false);
  });
  it('a constitution mutation preserves everything except the changed class', () => {
    const plan = inheritGrantPlan({ type: 'constitution', summary: '', noticed: '', why: '', change: { action: 'browser_act', maxAuthority: 'ask-forever' } }, grants);
    expect(plan.find((p) => p.actionClass === 'browser_act')!.preserve).toBe(false);
    expect(plan.find((p) => p.actionClass === 'browser_open')!.preserve).toBe(true);
    expect(plan.find((p) => p.actionClass === 'github_pr')!.preserve).toBe(true);
  });
});

describe('the shadow rehearsal', () => {
  it('acts replay the parent’s recorded outputs in order, then a typed note — never an invention', async () => {
    const outputs = recordedActOutputs([
      { kind: 'tool', payload: { toolName: 'send_email', toolOutput: { sent: 1 } } },
      { kind: 'tool', payload: { toolName: 'send_email', toolOutput: { sent: 2 } } },
      { kind: 'model', payload: {} },
    ]);
    const stub = buildShadowStub({ name: 'send_email', description: 'd', parameters: {} }, outputs.get('send_email')!);
    expect(stub.external).toBe(false);
    expect(await stub.run({})).toEqual({ sent: 1 });
    expect(await stub.run({})).toEqual({ sent: 2 });
    const dry = (await stub.run({})) as { shadowStub?: boolean; note?: string };
    expect(dry.shadowStub).toBe(true);
    expect(dry.note).toContain('no recorded output');
  });
});

describe('detector 1 — slot-law questions cluster by their placeholders, not their phrasing', () => {
  it('two differently-worded asks naming the same [SLOTS] form one cluster', () => {
    const out = deriveImprovements(SPEC, [
      ask('r1', 'The mission briefing has empty placeholders: [PASTE THE APP URL HERE] and [DESCRIBE THE TASK HERE]. Can you provide them?'),
      answer('r1', 'https://withpotion.com — report the headline'),
      ask('r2', "I'm ready to begin, but the mission description contains placeholders: [PASTE THE APP URL HERE] — the URL, and [DESCRIBE THE TASK HERE]."),
      answer('r2', 'https://withpotion.com — report the headline'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.mutation.noticed).toContain('2 separate runs');
  });
});
