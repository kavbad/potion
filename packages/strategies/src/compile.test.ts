// Compile-down equivalence (C2). The claim "single and cascade ARE programs"
// is only worth making if it is MEASURED: each shape and its compiled program
// run against the same scripted providers, and must produce the same answer,
// the same models called, and the same cost.
import { describe, expect, it } from 'vitest';
import type { ChatMessage, PriceTable, StrategyConfig } from '@potion/core';
import { compileGaps, compileToProgram, programCallCount, StrategyConfigSchema } from '@potion/core';
import { createProviders, type CompleteRequest, type Provider } from '@potion/providers';
import { createResolver } from './resolve.js';
import { execute } from './execute.js';
import type { ExecContext } from './types.js';

const ALIASES = ['a', 'b', 'c', 'judge'];
const PRICES: PriceTable = {
  version: 'p', updatedAt: '2026-09-05',
  entries: ALIASES.map((alias) => ({ alias, provider: 'mock' as const, model: `${alias}-v1`, inputPer1M: 1, outputPer1M: 2 })),
};
const MESSAGES: ChatMessage[] = [{ role: 'user', content: 'the task' }];

function scripted(script: Record<string, { text: string; confidence?: number }>) {
  const calls: string[] = [];
  const base = createProviders({ prices: PRICES }).mock;
  const provider: Provider = {
    id: 'mock',
    complete: async (req: CompleteRequest) => {
      calls.push(req.model);
      const r = await base.complete(req);
      const s = script[req.model] ?? { text: `answer from ${req.model}` };
      const { logprobConfidence: _drop, ...rest } = r;
      return { ...rest, text: s.text, ...(s.confidence !== undefined ? { logprobConfidence: s.confidence } : {}) };
    },
  };
  const providers = { ...createProviders({ prices: PRICES }), mock: provider };
  const ctx: ExecContext = { providers, prices: PRICES, resolve: createResolver(providers, PRICES), seed: 1, captureConfidence: true };
  return { ctx, calls };
}

/** Run a config and its compiled program on identical scripted worlds. */
async function bothWays(cfg: StrategyConfig, script: Record<string, { text: string; confidence?: number }>) {
  const compiled = compileToProgram(cfg);
  if (!compiled.ok) throw new Error(`expected ${cfg.type} to compile: ${compiled.refusal.missing}`);
  const program: StrategyConfig = { type: 'program', name: `compiled-${cfg.type}`, body: compiled.body };
  // It must survive the schema, like any other program that could be stored.
  expect(() => StrategyConfigSchema.parse(program)).not.toThrow();
  const native = scripted(script);
  const asProgram = scripted(script);
  const a = await execute(cfg, MESSAGES, native.ctx);
  const b = await execute(program, MESSAGES, asProgram.ctx);
  return { a, b, aCalls: native.calls, bCalls: asProgram.calls, compiled };
}

describe('single compiles exactly', () => {
  it('same answer, same call, same cost', async () => {
    const { a, b, aCalls, bCalls, compiled } = await bothWays(
      { type: 'single', model: 'a' },
      { a: { text: 'the answer' } },
    );
    expect(compiled.ok && compiled.exact).toBe(true);
    expect(b.text).toBe(a.text);
    expect(bCalls).toEqual(aCalls);
    expect(b.usage.costUsd).toBe(a.usage.costUsd);
  });
});

describe('cascade compiles to nested confidence gates', () => {
  const CASCADE: StrategyConfig = {
    type: 'cascade',
    stages: [
      { model: 'a', escalateIf: { confidenceBelow: 0.8 } },
      { model: 'b', escalateIf: { confidenceBelow: 0.8 } },
      { model: 'c' },
    ],
    confidenceMethod: 'logprob',
  };

  it('accepts at the first stage when confident: same answer, same one call', async () => {
    const { a, b, aCalls, bCalls } = await bothWays(CASCADE, {
      a: { text: 'confident answer', confidence: 0.95 },
      b: { text: 'from b', confidence: 0.95 },
      c: { text: 'from c' },
    });
    expect(b.text).toBe(a.text);
    expect(aCalls).toEqual(['a']);
    expect(bCalls).toEqual(['a']); // the memo: the checked node IS the branch
    expect(b.usage.costUsd).toBe(a.usage.costUsd);
  });

  it('escalates through every stage when unconfident: same answer, same models', async () => {
    const { a, b, aCalls, bCalls } = await bothWays(CASCADE, {
      a: { text: 'weak a', confidence: 0.1 },
      b: { text: 'weak b', confidence: 0.2 },
      c: { text: 'the last word' },
    });
    expect(a.text).toBe('the last word');
    expect(b.text).toBe(a.text);
    expect(bCalls).toEqual(aCalls);
  });

  it('stops at the middle stage when it clears the bar', async () => {
    const { a, b, aCalls, bCalls } = await bothWays(CASCADE, {
      a: { text: 'weak a', confidence: 0.1 },
      b: { text: 'good b', confidence: 0.9 },
      c: { text: 'unused' },
    });
    expect(b.text).toBe(a.text);
    expect(bCalls).toEqual(aCalls);
    expect(bCalls).not.toContain('c');
  });

  it('a stage with no threshold ends the cascade, and the compile says so', () => {
    const r = compileToProgram({
      type: 'cascade',
      stages: [{ model: 'a' }, { model: 'b' }],
      confidenceMethod: 'logprob',
    });
    expect(r.ok && r.body).toEqual({ op: 'call', model: 'a' }); // b is unreachable
  });

  it('THE DIVERGENCE, asserted rather than hidden: no logprob ⇒ cascade probes, program escalates', async () => {
    // Confidence absent from every answer. runCascade falls back to a
    // self-report probe (an extra call to the same model); the program has no
    // probe instruction, so its confidence check is false and it escalates.
    const { a, b, aCalls, bCalls, compiled } = await bothWays(CASCADE, {
      a: { text: 'a answer' },
      b: { text: 'b answer' },
      c: { text: 'c answer' },
    });
    expect(compiled.ok && compiled.exact).toBe(false);
    expect(compiled.ok && compiled.note).toContain('no logprob confidence');
    expect(aCalls.filter((m) => m === 'a').length).toBe(2); // answer + self-report probe
    expect(bCalls.filter((m) => m === 'a').length).toBe(1); // no probe instruction
    expect(b.text).toBe(a.text); // both still end at 'c'
  });
});

describe('ensemble judge-pick compiles, now that the IR uses the repo judge', () => {
  it('same winner, same models called', async () => {
    const { a, b, aCalls, bCalls } = await bothWays(
      { type: 'ensemble', models: ['a', 'b'], fusion: { method: 'judge-pick', judge: { model: 'judge' } } },
      { a: { text: 'from a' }, b: { text: 'from b' }, judge: { text: 'PICK: 1' } },
    );
    expect(a.text).toBe('from b');
    expect(b.text).toBe(a.text);
    expect(bCalls.sort()).toEqual(aCalls.sort());
  });

  it('a judge rubric has nowhere to go, and the compile refuses to pretend otherwise', () => {
    const r = compileToProgram({
      type: 'ensemble',
      models: ['a', 'b'],
      fusion: { method: 'judge-pick', judge: { model: 'judge', rubric: 'prefer brevity' } },
    });
    expect(r.ok && r.exact).toBe(false);
    expect(r.ok && r.note).toContain('rubric is dropped');
  });
});

describe('the refusals are the C4 work list', () => {
  it('names the missing instruction for every shape that does not compile', () => {
    const gaps = compileGaps([
      { type: 'best-of-n', model: 'a', n: 3, judge: { model: 'judge' } },
      { type: 'draft-verify', draftModel: 'a', verifierModel: 'b' },
      { type: 'composite', startModel: 'a', upgradeModel: 'b', upgradeIf: { confidenceBelow: 0.6 } },
      { type: 'decompose', decomposerModel: 'a', routing: { default: 'b' } },
      { type: 'ensemble', models: ['a', 'b'], fusion: { method: 'exec-pick' } },
      { type: 'cascade', stages: [{ model: 'a', escalateIf: { confidenceBelow: 0.5 } }, { model: 'b' }], confidenceMethod: 'self-report-calibrated' },
    ]);
    expect(gaps.map((g) => g.type).sort()).toEqual(
      ['best-of-n', 'cascade', 'composite', 'decompose', 'draft-verify', 'ensemble'],
    );
    expect(gaps.find((g) => g.type === 'best-of-n')!.missing).toContain('sampling');
    expect(gaps.find((g) => g.type === 'cascade')!.missing).toContain('probe');
  });

  it("best-of-n's refusal is real: the memo collapses n identical draws to one call", () => {
    // Written as a program by hand, best-of-3 over one model is not best-of-3.
    const naive = { op: 'pick' as const, of: [
      { op: 'call' as const, model: 'a' }, { op: 'call' as const, model: 'a' }, { op: 'call' as const, model: 'a' },
    ], by: { kind: 'judge' as const, model: 'judge' } };
    expect(programCallCount(naive)).toBe(2); // one draw + the judge, not four
  });
});
