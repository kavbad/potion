// L-G2 extraction tests: pore traffic → evaluator vocabulary. The mapping
// rules are the contract — especially the edit upgrade (the "no, change
// this first" label) and the silences (unanswered questions, budget pores).
import { describe, expect, it } from 'vitest';
import type { StepPayload } from './checkpoint.js';
import { extractPoreEvidence, tierFor, type EvidenceStep } from './evidence.js';

let t = 0;
const step = (payload: Partial<StepPayload>): EvidenceStep => ({
  payload: { kind: 'tool', clockMs: 0, rngSample: 0, ...payload } as StepPayload,
  createdAt: new Date(1756200000000 + ++t * 1000),
});

const ask = (toolName: string, argsHash: string): EvidenceStep =>
  step({ kind: 'check-in', checkInTrigger: 'before-external-action', checkInAction: { toolName, argsHash, arguments: '{}' } });
const answer = (text: string): EvidenceStep => step({ kind: 'model', checkInAnswer: text });

describe('extractPoreEvidence', () => {
  it('approve and reject map to their labels, keyed by the fingerprinted tool', () => {
    const out = extractPoreEvidence([
      ask('github:create_issue', 'h1'), answer('yes'),
      ask('github:create_issue', 'h2'), answer('no, that title is wrong'),
      ask('slack:send', 'h3'), answer('approved'),
    ]);
    expect(out.get('github:create_issue')!.map((e) => e.outcome)).toEqual(['approved', 'rejected']);
    expect(out.get('slack:send')!.map((e) => e.outcome)).toEqual(['approved']);
  });

  it('a rejection followed by an approved DIFFERENT version of the same tool upgrades to edited', () => {
    const out = extractPoreEvidence([
      ask('email:send', 'h-original'), answer('no — change the number first'),
      ask('email:send', 'h-revised'), answer('yes'),
    ]);
    expect(out.get('email:send')!.map((e) => e.outcome)).toEqual(['edited', 'approved']);
  });

  it('an approved retry with the SAME fingerprint does not launder the rejection into an edit', () => {
    const out = extractPoreEvidence([
      ask('email:send', 'h-same'), answer('no'),
      ask('email:send', 'h-same'), answer('yes'),
    ]);
    expect(out.get('email:send')!.map((e) => e.outcome)).toEqual(['rejected', 'approved']);
  });

  it('unanswered questions and budget pores produce NO evidence', () => {
    const out = extractPoreEvidence([
      step({ kind: 'check-in', checkInTrigger: 'on-budget-fraction', checkInQuestion: 'keep going?' }),
      answer('yes'), // answers the budget pore — not an action label
      ask('github:create_issue', 'h9'), // run died before an answer
    ]);
    expect(out.size).toBe(0);
  });
});

describe('tierFor — fail closed on unknown consequence', () => {
  it('read → reversible-read, act → reversible-act, unknown → irreversible-act', () => {
    expect(tierFor('crm:lookup', 'read')).toBe('reversible-read');
    expect(tierFor('crm:update', 'act')).toBe('reversible-act');
    expect(tierFor('mystery:tool', undefined)).toBe('irreversible-act');
  });
  it('spec overrides win (the spec sets the leash at birth)', () => {
    expect(tierFor('payments:wire', 'act', { 'payments:wire': 'never-graduates' })).toBe('never-graduates');
  });
});
