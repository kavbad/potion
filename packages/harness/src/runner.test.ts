// Runner tests (SPEC §5): execution + scoring + persistence, content-addressed
// cache hit/resume, budget-cap refusal, aggregate wiring. PGlite in-memory,
// zero services.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { roundCost, type EvalItem, type ScoringMethod } from '@potion/core';
import { createDb, getEvalResultByCacheKey, type DbHandle } from '@potion/db';
import { createMockProvider, evalTaskById, hashString } from '@potion/providers';
import { BudgetCapError, estimateItemCostUsd } from './estimate.js';
import { SimulatedSuiteError, cacheKeyOf, runEval, type RunDeps } from './runner.js';
import { buildJudgeScoreMessages } from './scorers.js';
import { loadPrices } from '@potion/providers';
import { strategyHash } from '@potion/core';

const PRICES_PATH = fileURLToPath(new URL('../../../prices.json', import.meta.url));
const prices = loadPrices(PRICES_PATH).table;

// Two-item extraction suite built from the mock corpus (deterministic answers).
function suiteItem(id: string): EvalItem {
  const task = evalTaskById(id)!;
  return {
    id: task.id,
    clusterId: 'extraction',
    prompt: [{ role: 'user', content: `EVAL: ${task.id}\n${task.task}\n\nRespond with ONLY the JSON object.` }],
    reference: JSON.parse(task.reference) as unknown,
    scoring: { kind: 'field-match', schema: task.schema ?? {} },
  };
}

const suiteDir = mkdtempSync(`${tmpdir()}/potion-harness-suites-`);
writeFileSync(
  `${suiteDir}/extraction.jsonl`,
  [suiteItem('ex-01'), suiteItem('ex-02')].map((i) => JSON.stringify(i)).join('\n') + '\n',
);

// M1a quarantine: a simulated/ subdir suite exercises the provenance gate.
mkdirSync(`${suiteDir}/simulated`);
writeFileSync(
  `${suiteDir}/simulated/code-gen.jsonl`,
  '// provenance: SIMULATED — test fixture\n' +
    [suiteItem('ex-01')].map((i) => JSON.stringify({ ...i, clusterId: 'code-gen' })).join('\n') + '\n',
);

// M1b: a two-item llm-judge prose suite + a PRICED price table (mock transport,
// non-zero prices) so judge-call spend is hand-computable.
function judgeItem(id: string): EvalItem {
  const task = evalTaskById(id)!;
  return {
    id: task.id,
    clusterId: 'creative',
    prompt: [{ role: 'user', content: `EVAL: ${task.id}\n${task.task}` }],
    reference: task.reference,
    scoring: {
      kind: 'llm-judge',
      rubric: 'Score the answer for correctness against the task.',
      judgeModel: 'm-judge',
      scale: [0, 4],
    },
  };
}
writeFileSync(
  `${suiteDir}/creative.jsonl`,
  [judgeItem('pr-01'), judgeItem('pr-02')].map((i) => JSON.stringify(i)).join('\n') + '\n',
);
const PRICED_PRICES_PATH = `${suiteDir}/priced-prices.json`;
writeFileSync(
  PRICED_PRICES_PATH,
  JSON.stringify({
    version: 'test-judge-v1',
    updatedAt: '2026-08-04',
    entries: [
      { alias: 'm-cheap-answer', provider: 'mock', model: 'm-cheap-answer-v1', inputPer1M: 2.0, outputPer1M: 10.0 },
      { alias: 'm-judge', provider: 'mock', model: 'm-judge-v1', inputPer1M: 3.0, outputPer1M: 15.0 },
    ],
  }),
);

describe('runEval', () => {
  let handle: DbHandle;
  beforeAll(async () => {
    handle = await createDb('pglite://');
  });
  afterAll(async () => {
    await handle.close();
  });

  const deps = (): RunDeps => ({ db: handle, suitesDir: suiteDir, pricesPath: PRICES_PATH });

  it('executes strategy × item, scores, persists, aggregates', async () => {
    const summary = await runEval(
      { suiteIds: ['extraction'], strategies: [{ type: 'single', model: 'mock-frontier' }], budgetCapUsd: 25 },
      deps(),
    );
    expect(summary.executed).toBe(2);
    expect(summary.cacheHits).toBe(0);
    expect(summary.spendUsd).toBe(0); // mock price entries are $0
    expect(summary.projectedSpendUsd).toBe(0);
    expect(summary.aggregates).toHaveLength(1);
    const agg = summary.aggregates[0]!;
    expect(agg.n).toBe(2);
    expect(agg.clusterId).toBe('extraction');
    expect(agg.qualityMean).toBeGreaterThan(0);
    expect(agg.latencyP50).toBe(1800); // frontier latency profile
    // persisted with the SPEC cacheKey shape
    const sh = strategyHash({ type: 'single', model: 'mock-frontier' });
    const key = cacheKeyOf(sh, suiteItem('ex-01'), suiteItem('ex-01').scoring, prices);
    const row = await getEvalResultByCacheKey(handle.db, key);
    expect(row).not.toBeNull();
    expect(row!.runId).toBe(summary.runId);
    expect(row!.scorer).toBe('field-match');
  });

  it('resume skips cache hits and reproduces identical aggregates', async () => {
    const strategies = [{ type: 'single', model: 'mock-mid' } as const];
    const first = await runEval(
      { suiteIds: ['extraction'], strategies, budgetCapUsd: 25 },
      deps(),
    );
    expect(first.executed).toBe(2);
    const second = await runEval(
      { suiteIds: ['extraction'], strategies, budgetCapUsd: 25, resume: true },
      deps(),
    );
    expect(second.cacheHits).toBe(2);
    expect(second.executed).toBe(0);
    expect(second.aggregates[0]!.qualityMean).toBe(first.aggregates[0]!.qualityMean);
    expect(second.aggregates[0]!.latencyP50).toBe(first.aggregates[0]!.latencyP50);
  });

  it('is deterministic: a fresh db reproduces identical qualities', async () => {
    const fresh = await createDb('pglite://');
    try {
      const strategies = [{ type: 'single', model: 'mock-cheap' } as const];
      const a = await runEval(
        { suiteIds: ['extraction'], strategies, budgetCapUsd: 25 },
        { db: fresh, suitesDir: suiteDir, pricesPath: PRICES_PATH },
      );
      const b = await runEval(
        { suiteIds: ['extraction'], strategies, budgetCapUsd: 25 },
        { db: handle, suitesDir: suiteDir, pricesPath: PRICES_PATH },
      );
      expect(a.results.map((r) => r.quality)).toEqual(b.results.map((r) => r.quality));
    } finally {
      await fresh.close();
    }
  });

  it('REFUSES to start when the projection exceeds the cap (tiny cap)', async () => {
    // frontier-class is $15/$75 per 1M; two items × ~27 in + 80 out tokens
    // projects ≈ $0.0128 — way over a $0.0001 cap. Nothing executes.
    await expect(
      runEval(
        {
          suiteIds: ['extraction'],
          strategies: [{ type: 'single', model: 'frontier-class' }],
          budgetCapUsd: 0.0001,
        },
        deps(),
      ),
    ).rejects.toThrowError(BudgetCapError);
    await expect(
      runEval(
        {
          suiteIds: ['extraction'],
          strategies: [{ type: 'single', model: 'frontier-class' }],
          budgetCapUsd: 0.0001,
        },
        deps(),
      ),
    ).rejects.toThrowError(/budget cap refusal: projected spend .* exceeds budget cap/);
  });

  it('REFUSES simulated suites without simulatedOk; runs + marks them with it', async () => {
    // Without the opt-in: provenance refusal naming the mock-corpus coupling.
    await expect(
      runEval(
        { suiteIds: ['code-gen'], strategies: [{ type: 'single', model: 'mock-mid' }], budgetCapUsd: 25 },
        deps(),
      ),
    ).rejects.toThrowError(SimulatedSuiteError);
    await expect(
      runEval(
        { suiteIds: ['code-gen'], strategies: [{ type: 'single', model: 'mock-mid' }], budgetCapUsd: 25 },
        deps(),
      ),
    ).rejects.toThrowError(/simulated suite refusal:.*suites\/simulated\/.*mock eval corpus/s);
    // With the opt-in: runs normally and carries the simulated marker.
    const summary = await runEval(
      {
        suiteIds: ['code-gen'],
        strategies: [{ type: 'single', model: 'mock-mid' }],
        budgetCapUsd: 25,
        simulatedOk: true,
      },
      deps(),
    );
    expect(summary.simulated).toBe(true);
    expect(summary.executed).toBe(1);
    // …while authored (non-simulated) suites are never marked.
    const authored = await runEval(
      { suiteIds: ['extraction'], strategies: [{ type: 'single', model: 'mock-mid' }], budgetCapUsd: 25 },
      deps(),
    );
    expect(authored.simulated).toBe(false);
  });

  it('counts judge scoring cost in usage/spend/aggregates — hand-computed totals (M1b)', async () => {
    const pricedPrices = loadPrices(PRICED_PRICES_PATH).table;
    const strategy = { type: 'single', model: 'm-cheap-answer' } as const;
    const summary = await runEval(
      { suiteIds: ['creative'], strategies: [strategy], budgetCapUsd: 25 },
      { db: handle, suitesDir: suiteDir, pricesPath: PRICED_PRICES_PATH },
    );
    expect(summary.executed).toBe(2);

    // Reconstruct the exact calls the runner made (mock world is
    // deterministic: same messages + same seed formula ⇒ same response).
    const mock = createMockProvider(pricedPrices);
    let expectedSpend = 0;
    let expectedJudgeSpend = 0;
    for (const id of ['pr-01', 'pr-02']) {
      const item = judgeItem(id);
      const scoring = item.scoring as Extract<ScoringMethod, { kind: 'llm-judge' }>;
      const strat = await mock.complete({ model: 'm-cheap-answer', messages: item.prompt });
      const judge = await mock.complete({
        model: 'm-judge',
        messages: buildJudgeScoreMessages(item, strat.text, scoring),
        params: { seed: hashString(`m-judge|${item.id}|${strat.text}`) },
      });
      // Hand math: strategy $2/$10 per 1M, judge $3/$15 per 1M (both legs are
      // roundCost'd at the source — strategies/single.ts and scorers.ts).
      const stratCost = roundCost((strat.usage.inputTokens * 2 + strat.usage.outputTokens * 10) / 1e6);
      const judgeCost = roundCost((judge.usage.inputTokens * 3 + judge.usage.outputTokens * 15) / 1e6);
      const r = summary.results.find((x) => x.itemId === id)!;
      expect(r.scorer).toBe('llm-judge:m-judge');
      // usage = strategy + judge, tokens and cost summed…
      expect(r.usage.inputTokens).toBe(strat.usage.inputTokens + judge.usage.inputTokens);
      expect(r.usage.outputTokens).toBe(strat.usage.outputTokens + judge.usage.outputTokens);
      expect(r.usage.costUsd).toBeCloseTo(stratCost + judgeCost, 12);
      // …but latencyMs stays STRATEGY-ONLY (cheap profile 300ms, judge is 900ms).
      expect(r.usage.latencyMs).toBe(300);
      expect(r.latencyMs.p50).toBe(300);
      expectedSpend += stratCost + judgeCost;
      expectedJudgeSpend += judgeCost;
    }
    expect(expectedJudgeSpend).toBeGreaterThan(0);
    // RunSummary.spendUsd and judgeSpendUsd match the hand-computed totals…
    expect(summary.spendUsd).toBeCloseTo(expectedSpend, 12);
    expect(summary.judgeSpendUsd).toBeCloseTo(expectedJudgeSpend, 12);
    // …the aggregate costPer1K includes judge cost (mean per-item cost × 1000)…
    expect(summary.aggregates[0]!.costPer1K).toBeCloseTo((expectedSpend / 2) * 1000, 9);
    // …and the preflight projection counts the judge call too (strategy-only
    // projection would be smaller by exactly the judge estimate).
    const expectedProjection = ['pr-01', 'pr-02'].reduce(
      (a, id) => a + estimateItemCostUsd(strategy, judgeItem(id), pricedPrices),
      0,
    );
    expect(summary.projectedSpendUsd).toBeCloseTo(expectedProjection, 12);

    // Cache key is UNCHANGED (no scorerUsage component): resume replays the
    // stored rows — and their judge-inclusive usage survives the cache round-trip.
    const second = await runEval(
      { suiteIds: ['creative'], strategies: [strategy], budgetCapUsd: 25, resume: true },
      { db: handle, suitesDir: suiteDir, pricesPath: PRICED_PRICES_PATH },
    );
    expect(second.cacheHits).toBe(2);
    expect(second.executed).toBe(0);
    expect(second.spendUsd).toBeCloseTo(expectedSpend, 12);
  });

  it('composite strategies produce intermediate latency profiles', async () => {
    const summary = await runEval(
      {
        suiteIds: ['extraction'],
        strategies: [
          {
            type: 'cascade',
            stages: [
              { model: 'mock-cheap', escalateIf: { confidenceBelow: 0.7 } },
              { model: 'mock-frontier' },
            ],
            confidenceMethod: 'self-report-calibrated',
          },
        ],
        budgetCapUsd: 25,
      },
      deps(),
    );
    const agg = summary.aggregates[0]!;
    // cheap stage + probe = 600ms accepted; escalation adds 1800ms → p95 above p50
    expect(agg.latencyP50).toBeGreaterThanOrEqual(600);
    expect(agg.latencyP95).toBeGreaterThanOrEqual(agg.latencyP50);
  });
});
