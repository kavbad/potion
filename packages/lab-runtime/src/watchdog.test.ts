// P5 — the watchdog's laws at the runtime layer:
//   · the shape law rides the system prompt ONLY for shape'd specs
//     (reporter and pre-P5 prompts stay byte-identical — replay law);
//   · the judge's rubric gains the precision/false-alarm criteria only for
//     watchdogs, and quiet coverage is named a GOOD result.
import { describe, expect, it } from 'vitest';
import type { HarnessSpec } from '@potion/lab-spec';
import { systemPrompt } from './loop.js';
import { compileRubric } from './judge.js';

function standing(over: Partial<HarnessSpec> = {}): HarnessSpec {
  return {
    specVersion: 1,
    name: 'watchdog test harness',
    brain: { policy: { type: 'min_cost', qualityFloor: 0 } },
    mission: { kind: 'standing', goal: 'watch the pricing page', shape: 'watchdog' },
    superpowers: [],
    memory: { enabled: true },
    rules: [],
    fuel: { maxUsdPerRun: 1, hardStop: true },
    checkIns: [],
    contract: { type: 'brief' },
    ...over,
  };
}

describe('the watchdog prompt law', () => {
  it('a watchdog spec carries the law; evidence and honest silence both named', () => {
    const p = systemPrompt(standing(), {}, []);
    expect(p).toContain('You are a WATCHDOG');
    expect(p).toContain('Fire only when the condition truly holds');
    expect(p).toContain('the quiet report IS the deliverable');
  });
  it('a reporter (shape-less) standing spec stays byte-identical to pre-P5', () => {
    const p = systemPrompt(standing({ mission: { kind: 'standing', goal: 'watch the pricing page' } }), {}, []);
    expect(p).not.toContain('WATCHDOG');
  });
});

describe('the watchdog rubric', () => {
  it('gains precision + false-alarm criteria; quiet-with-coverage is a good result', () => {
    const rubric = compileRubric(standing());
    expect(rubric.some((c) => c.includes('fires ONLY on a true condition'))).toBe(true);
    expect(rubric.some((c) => c.includes('a quiet check that states its coverage is a GOOD result'))).toBe(true);
  });
  it('a reporter rubric carries neither', () => {
    const rubric = compileRubric(standing({ mission: { kind: 'standing', goal: 'g' } }));
    expect(rubric.some((c) => c.includes('true condition'))).toBe(false);
  });
});
