// X2 — the ledger's laws: full-state validation, last-valid-wins derivation,
// render stability, and the tool's echo.
import { describe, expect, it } from 'vitest';
import { buildPlanTool, planFromSteps, renderPlanLedger, validatePlan, PLAN_LIMITS } from './plan.js';

const T = (id: string, status = 'pending', over: Record<string, unknown> = {}) => ({ id, title: `task ${id}`, status, ...over });

describe('validatePlan', () => {
  it('accepts a full plan and normalizes verbatim strings', () => {
    const tabbed = 'fetch' + String.fromCharCode(9) + 'the' + String.fromCharCode(10) + 'CSV';
    const v = validatePlan({ tasks: [T('1', 'doing', { title: tabbed, note: ' compute it ' })] });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.tasks[0]!.title).toBe('fetch the CSV');
      expect(v.tasks[0]!.note).toBe('compute it');
    }
  });
  it('refuses: missing tasks, empty, over-cap, dup ids, bad status', () => {
    expect(validatePlan({}).ok).toBe(false);
    expect(validatePlan({ tasks: [] }).ok).toBe(false);
    expect(validatePlan({ tasks: Array.from({ length: PLAN_LIMITS.MAX_TASKS + 1 }, (_x, i) => T(String(i))) }).ok).toBe(false);
    expect(validatePlan({ tasks: [T('a'), T('a')] }).ok).toBe(false);
    expect(validatePlan({ tasks: [T('a', 'later')] }).ok).toBe(false);
  });
});

describe('planFromSteps — last valid wins, invalid ignored', () => {
  const toolStep = (input: unknown) => ({ kind: 'tool', payload: { toolName: 'update_plan', toolInput: input } });
  it('derives the latest valid ledger and skips garbage after it', () => {
    const steps = [
      toolStep({ tasks: [T('1', 'doing')] }),
      { kind: 'model', payload: {} },
      toolStep({ tasks: [T('1', 'done'), T('2', 'doing')] }),
      toolStep({ tasks: 'not-an-array' }), // invalid — must not erase the ledger
    ];
    const plan = planFromSteps(steps);
    expect(plan?.map((t) => `${t.id}:${t.status}`)).toEqual(['1:done', '2:doing']);
  });
  it('parses string-recorded inputs and returns null when no plan exists', () => {
    const derived = planFromSteps([toolStep(JSON.stringify({ tasks: [T('x', 'done')] }))]);
    expect(derived).not.toBeNull();
    expect(planFromSteps([{ kind: 'model', payload: {} }])).toBeNull();
  });
});

describe('the tool + the render', () => {
  it('echoes the normalized ledger; refuses with a reason', async () => {
    const tool = buildPlanTool();
    const good = (await tool.run({ tasks: [T('1', 'done'), T('2', 'blocked', { note: 'no data' })] })) as { ledger: string };
    expect(good.ledger).toBe('[x] 1 · task 1\n[!] 2 · task 2 — no data');
    const bad = (await tool.run({ tasks: [] })) as { error: string };
    expect(bad.error).toContain('at least one');
  });
  it('render marks are stable (the prompt contract)', () => {
    expect(renderPlanLedger([T('a', 'pending') as never, T('b', 'doing') as never])).toBe('[ ] a · task a\n[~] b · task b');
  });
});
