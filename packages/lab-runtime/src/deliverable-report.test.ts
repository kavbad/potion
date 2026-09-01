// extractReport — the task run's felt result (2026-08-31). The law, learned
// on the operator's own screen: the WRAP-UP is process narration ("Summary
// of this run: 1. I received…"), never the answer. The report is the
// done-shaped step the completion law accepted — the step BEFORE the
// wrap-up.
import { describe, expect, it } from 'vitest';
import type { HarnessSpec } from '@potion/lab-spec';
import { extractReport } from './deliverable.js';

const TASK: HarnessSpec = {
  specVersion: 1,
  name: 'report extraction harness',
  brain: { policy: { type: 'min_cost', qualityFloor: 0 } },
  mission: { kind: 'task', goal: 'do the thing', doneDefinition: 'done' },
  superpowers: [],
  memory: { enabled: false },
  rules: [],
  fuel: { maxUsdPerRun: 1, hardStop: true },
  checkIns: [],
};

function modelStep(seq: number, text: string, lastRequestMessage?: string) {
  return {
    seq,
    kind: 'model',
    payload: {
      responseText: text,
      toolCalls: [],
      finishReason: 'stop' as const,
      ...(lastRequestMessage !== undefined
        ? { requestPayload: { messages: [{ content: 'earlier' }, { content: lastRequestMessage }] } }
        : {}),
    },
  };
}

describe('the report is the answer, never the wrap-up', () => {
  it('a wrap-up step is skipped; the done-shaped step before it is the report', () => {
    const answer = 'Saturday is the highest-revenue day at $133.40 — 2.2× Monday. Files: by-day.csv, revenue.png.';
    const wrapUp = 'Summary of this run: 1. I received the mission framework instructions. 2. I did the work. Done-definition met.';
    const res = extractReport(TASK, [
      modelStep(1, answer),
      modelStep(2, wrapUp, 'Summarize what you did in this run and state plainly whether the done-definition is met.'),
    ]);
    expect(res).not.toBeNull();
    expect(res!.report).toBe(answer);
    expect(res!.atSeq).toBe(1);
  });

  it('a bare "done." is not a report', () => {
    expect(extractReport(TASK, [modelStep(1, 'done.')])).toBeNull();
  });

  it('FALLBACK (runs 4638e4a1 + b91e9566): when NO qualifying stop precedes it, the wrap-up narration IS the report — a null here silently skips the judge', () => {
    const wrapUp = 'In this run I attempted the analysis but the script failed on the Amount column; no deliverables were produced.';
    const res = extractReport(TASK, [
      modelStep(1, ''), // the degenerate zero-token stop
      modelStep(2, wrapUp, 'Summarize what you did in this run and state plainly whether the done-definition is met.'),
    ]);
    expect(res).not.toBeNull();
    expect(res!.report).toBe(wrapUp);
    expect(res!.atSeq).toBe(2);
  });

  it('contract runs and standing missions extract nothing here', () => {
    const standing: HarnessSpec = { ...TASK, mission: { kind: 'standing', goal: 'watch the thing' } };
    expect(extractReport(standing, [modelStep(1, 'a long enough answer to pass the forty character bar easily')])).toBeNull();
  });
});
