// Unit tests for scripts/m1b-sweep.ts — preflight math + graceful-stop logic.
// Mock only, zero network, zero DB (runEval is replaced by an injected fake;
// the estimator math is checked against the harness's own projectRunCostUsd).
//
//   pnpm exec vitest run scripts
import { describe, expect, it } from 'vitest';
import type { EvalItem, PriceTable, StrategyConfig } from '@potion/core';
import {
  ANSWER_OUTPUT_TOKENS, projectRunCostUsd } from '@potion/harness';
import {
  fitsBudget,
  parseArgs,
  projectSuiteCostUsd,
  projectSweepCostUsd,
  requiredLiveEnvVars,
  runSweepLoop,
  type RunEvalFn,
} from './m1b-sweep.js';

// ---- fixtures ---------------------------------------------------------------

const PRICES: PriceTable = {
  version: 'test-v1',
  updatedAt: '2026-08-04',
  entries: [
    { alias: 'm-cheap', provider: 'mock', model: 'm-cheap-v1', inputPer1M: 1.0, outputPer1M: 2.0 },
    { alias: 'm-dear', provider: 'mock', model: 'm-dear-v1', inputPer1M: 10.0, outputPer1M: 20.0 },
    { alias: 'or-mini', provider: 'openrouter', model: 'openai/x-mini', inputPer1M: 0.4, outputPer1M: 1.6 },
    { alias: 'an-judge', provider: 'anthropic', model: 'anthropic/x-judge', inputPer1M: 3.0, outputPer1M: 15.0 },
  ],
};

function item(id: string, contentChars: number, cluster = 'suite-a'): EvalItem {
  return {
    id,
    clusterId: cluster,
    prompt: [{ role: 'user', content: 'a'.repeat(contentChars) }],
    scoring: { kind: 'exact' },
  };
}

const SINGLE_CHEAP: StrategyConfig = { type: 'single', model: 'm-cheap' };

/** Canned runEval: reports spendUsd = the harness preflight projection would
 * be the caller's; here we let each test fix the spend it wants to simulate. */
function fakeRunEval(spendBySuite: Record<string, number>): {
  fn: RunEvalFn;
  calls: Array<{ suiteIds: string[]; budgetCapUsd: number }>;
} {
  const calls: Array<{ suiteIds: string[]; budgetCapUsd: number }> = [];
  const fn: RunEvalFn = async (opts) => {
    calls.push({ suiteIds: opts.suiteIds, budgetCapUsd: opts.budgetCapUsd });
    const suiteId = opts.suiteIds[0]!;
    return {
      runId: `fake-${suiteId}`,
      aggregates: [],
      spendUsd: spendBySuite[suiteId] ?? 0,
      judgeSpendUsd: 0,
      projectedSpendUsd: 0,
      executed: 0,
      cacheHits: 0,
      skipped: [],
      // The stub had drifted out of RunSummary's shape — these three were
      // added to the type and never here. A double that does not match the
      // real signature is a test that proves something about a shape nobody
      // ships; it went unnoticed because scripts/ was outside the typecheck.
      executedSpendUsd: 0,
      abandonedSpendUsd: 0,
      failedStrategies: [],
      results: [],
      simulated: false,
      providerMode: 'mock',
    };
  };
  return { fn, calls };
}

// ---- args -------------------------------------------------------------------

describe('parseArgs', () => {
  it('defaults to cap 15, live mode', () => {
    expect(parseArgs([])).toEqual({ cap: 15, dryRun: false, resume: false });
  });
  it('parses --cap and --dry-run (and the pnpm "--" separator)', () => {
    expect(parseArgs(['--', '--cap', '0.001', '--dry-run'])).toEqual({ cap: 0.001, dryRun: true, resume: false });
  });
  it('rejects bad caps and unknown flags', () => {
    expect(() => parseArgs(['--cap', '-3'])).toThrow(/--cap/);
    expect(() => parseArgs(['--cap', 'abc'])).toThrow(/--cap/);
    expect(() => parseArgs(['--cap'])).toThrow(/missing value/);
    expect(() => parseArgs(['--live-fast-and-loose'])).toThrow(/unknown flag/);
  });
});

// ---- preflight math ---------------------------------------------------------

describe('preflight projection math', () => {
  it('matches the harness estimator exactly, per suite and in total', () => {
    const suiteA = [item('a1', 400, 'suite-a'), item('a2', 40, 'suite-a')];
    const suiteB = [item('b1', 1000, 'suite-b')];
    const strategies = [SINGLE_CHEAP, { type: 'single', model: 'm-dear' } as StrategyConfig];

    const perA = projectSuiteCostUsd(strategies, suiteA, PRICES);
    const perB = projectSuiteCostUsd(strategies, suiteB, PRICES);
    expect(perA).toBeCloseTo(projectRunCostUsd(strategies, suiteA, PRICES), 12);
    expect(perB).toBeCloseTo(projectRunCostUsd(strategies, suiteB, PRICES), 12);
    expect(projectSweepCostUsd(strategies, [suiteA, suiteB], PRICES)).toBeCloseTo(perA + perB, 12);
  });

  it('hand-checks the estimator: ceil(chars/4) in, ENFORCED output ceiling out, per-1M pricing', () => {
    // promptChars = 'user'(4) + 1 + 400 = 405 → inputTokens = ceil(405/4) = 102.
    // single m-cheap: (102·$1 + ANSWER_OUTPUT_TOKENS·$2) / 1e6 — the output
    // side is the provider-enforced max_tokens ceiling, not a typical-answer
    // guess (M1b estimator fix: projections must dominate actuals).
    expect(projectSuiteCostUsd([SINGLE_CHEAP], [item('x', 400)], PRICES)).toBeCloseTo(
      (102 * 1.0 + ANSWER_OUTPUT_TOKENS * 2.0) / 1_000_000,
      12,
    );
    // a configured per-suite ceiling raises the bound accordingly
    expect(projectSuiteCostUsd([SINGLE_CHEAP], [item('x', 400)], PRICES, 2048)).toBeCloseTo(
      (102 * 1.0 + 2048 * 2.0) / 1_000_000,
      12,
    );
  });

  it('refusal decision: projection > cap does not fit; == cap fits', () => {
    const projected = projectSuiteCostUsd([SINGLE_CHEAP], [item('x', 400)], PRICES);
    expect(projected).toBeGreaterThan(0);
    expect(fitsBudget(projected, projected)).toBe(true); // exact fit is legal
    expect(fitsBudget(projected, projected * 0.999)).toBe(false); // meaningfully short → refuse
    expect(fitsBudget(projected, 0)).toBe(false); // zero budget never fits real work
  });
});

// ---- graceful stop ----------------------------------------------------------

describe('runSweepLoop budget governance', () => {
  const strategies = [SINGLE_CHEAP];
  // One 400-char item per suite → per-suite projection p = $0.000262.
  const suites = ['s1', 's2', 's3'] as const;
  const itemsBySuite = suites.map((s) => [item(`${s}-1`, 400, s)]);
  const perSuite = projectSuiteCostUsd(strategies, itemsBySuite[0]!, PRICES);

  it('runs every suite when the cap covers all projections', async () => {
    const { fn, calls } = fakeRunEval({ s1: perSuite, s2: perSuite, s3: perSuite });
    const running: number[] = [];
    const out = await runSweepLoop({
      suiteIds: suites,
      itemsBySuite,
      strategies,
      prices: PRICES,
      capUsd: 3 * perSuite,
      provider: 'mock',
      runEvalFn: fn,
      onSuiteDone: (_o, spend) => running.push(spend),
    });
    expect(out.stoppedEarly).toBe(false);
    expect(out.stopReason).toBeNull();
    expect(out.outcomes.map((o) => o.suiteId)).toEqual([...suites]);
    expect(out.totalSpendUsd).toBeCloseTo(3 * perSuite, 12);
    expect(calls).toHaveLength(3);
    expect(running).toHaveLength(3); // running spend reported after each suite
  });

  it('stops gracefully when the next suite would not fit the remaining budget', async () => {
    const { fn, calls } = fakeRunEval({ s1: perSuite, s2: perSuite, s3: perSuite });
    const cap = 2 * perSuite; // s1 + s2 fit exactly; s3 does not
    const out = await runSweepLoop({
      suiteIds: suites,
      itemsBySuite,
      strategies,
      prices: PRICES,
      capUsd: cap,
      provider: 'mock',
      runEvalFn: fn,
    });
    expect(out.outcomes.map((o) => o.suiteId)).toEqual(['s1', 's2']);
    expect(out.stoppedEarly).toBe(true);
    expect(out.stopReason).toMatch(/suite 's3'/);
    expect(out.stopReason).toMatch(/stopping gracefully/);
    expect(calls).toHaveLength(2); // s3 was NEVER executed
    expect(out.totalSpendUsd).toBeCloseTo(2 * perSuite, 12);
    expect(out.totalSpendUsd).toBeLessThanOrEqual(cap);
  });

  it('passes budgetCapUsd = remaining budget to each runEval (second enforcement layer)', async () => {
    const { fn, calls } = fakeRunEval({ s1: 0.0001, s2: 0.0001 });
    const cap = 1.0;
    await runSweepLoop({
      suiteIds: ['s1', 's2'],
      itemsBySuite: [itemsBySuite[0]!, itemsBySuite[1]!],
      strategies,
      prices: PRICES,
      capUsd: cap,
      provider: 'mock',
      runEvalFn: fn,
    });
    expect(calls[0]!.budgetCapUsd).toBeCloseTo(cap, 12);
    expect(calls[1]!.budgetCapUsd).toBeCloseTo(cap - 0.0001, 12);
  });

  it('stops BEFORE the first suite when even suite #1 does not fit (cap 0.001 demo shape)', async () => {
    const { fn, calls } = fakeRunEval({});
    const out = await runSweepLoop({
      suiteIds: suites,
      itemsBySuite,
      strategies,
      prices: PRICES,
      capUsd: 0.0001, // < per-suite projection $0.000262
      provider: 'mock',
      runEvalFn: fn,
    });
    expect(calls).toHaveLength(0); // zero executions
    expect(out.stoppedEarly).toBe(true);
    expect(out.stopReason).toMatch(/suite 's1'/);
    expect(out.totalSpendUsd).toBe(0);
  });
});

// ---- live key requirements ---------------------------------------------------

describe('requiredLiveEnvVars', () => {
  it('requires the strategy provider key AND llm-judge scorer provider keys', () => {
    const strategies: StrategyConfig[] = [{ type: 'single', model: 'or-mini' }];
    const judged: EvalItem = {
      id: 'j1',
      clusterId: 'c',
      prompt: [{ role: 'user', content: 'q' }],
      scoring: { kind: 'llm-judge', rubric: 'r', judgeModel: 'an-judge', scale: [0, 10] },
    };
    expect(requiredLiveEnvVars(strategies, [[judged]], PRICES)).toEqual([
      'ANTHROPIC_API_KEY',
      'OPENROUTER_API_KEY',
    ]);
  });

  it('requires nothing for an all-mock world (dry-run path never calls this, but stays sane)', () => {
    expect(requiredLiveEnvVars([SINGLE_CHEAP], [[item('x', 10)]], PRICES)).toEqual([]);
  });
});
