// M3 #23 composite harness/pareto compat (SPEC §12.6): a composite strategy
// flows through runEval like any other strategy — preflight estimate,
// execution, scoring, persistence, aggregation — and the resulting
// StrategyAggregate is consumed by computeFrontier. PGlite in-memory, mock
// provider, zero services.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { strategyHash, type EvalItem, type StrategyConfig } from '@potion/core';
import { createDb, type DbHandle } from '@potion/db';
import { computeFrontier } from '@potion/pareto';
import { evalTaskById } from '@potion/providers';
import { estimateCalls, estimateItemCostUsd } from './estimate.js';
import { runEval, strategyModels, type RunDeps } from './runner.js';

const PRICES_PATH = fileURLToPath(new URL('../../../prices.json', import.meta.url));

const COMPOSITE: StrategyConfig = {
  type: 'composite',
  startModel: 'mock-cheap',
  upgradeModel: 'mock-frontier',
  upgradeIf: { confidenceBelow: 0.6 },
};

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

const suiteDir = mkdtempSync(`${tmpdir()}/potion-harness-composite-`);
writeFileSync(
  `${suiteDir}/extraction.jsonl`,
  [suiteItem('ex-01'), suiteItem('ex-02')].map((i) => JSON.stringify(i)).join('\n') + '\n',
);

describe('composite strategy through the harness (M3 #23)', () => {
  let handle: DbHandle;
  beforeAll(async () => {
    handle = await createDb('pglite://');
  });
  afterAll(async () => {
    await handle.close();
  });

  const deps = (): RunDeps => ({ db: handle, suitesDir: suiteDir, pricesPath: PRICES_PATH });

  it('estimateCalls + strategyModels cover the composite shape (worst case)', () => {
    const calls = estimateCalls(COMPOSITE, 100);
    // worst case: start + self-report probe + upgrade
    expect(calls.map((c) => c.model)).toEqual(['mock-cheap', 'mock-cheap', 'mock-frontier']);
    expect(strategyModels(COMPOSITE)).toEqual(['mock-cheap', 'mock-frontier']);
    expect(estimateItemCostUsd(COMPOSITE, suiteItem('ex-01'), /* prices */ {
      version: 't', updatedAt: 't',
      entries: [
        { alias: 'mock-cheap', provider: 'mock', model: 'mock-cheap-v1', inputPer1M: 0, outputPer1M: 0 },
        { alias: 'mock-frontier', provider: 'mock', model: 'mock-frontier-v1', inputPer1M: 0, outputPer1M: 0 },
      ],
    })).toBe(0);
  });

  it('runEval executes a composite strategy over a 2-item suite; pareto consumes the aggregate', async () => {
    const summary = await runEval(
      { suiteIds: ['extraction'], strategies: [COMPOSITE], budgetCapUsd: 25 },
      deps(),
    );
    const sh = strategyHash(COMPOSITE);

    expect(summary.executed).toBe(2);
    expect(summary.results).toHaveLength(2);
    for (const r of summary.results) {
      expect(r.strategyHash).toBe(sh);
      expect(r.strategyConfig).toEqual(COMPOSITE);
      expect(r.usage.outputTokens).toBeGreaterThan(0);
      expect(r.scorer).toBe('field-match');
      // modelVersions covers both composite models.
      expect(Object.keys(r.modelVersions)).toEqual(
        expect.arrayContaining(['mock-cheap', 'mock-frontier']),
      );
    }

    expect(summary.aggregates).toHaveLength(1);
    const agg = summary.aggregates[0]!;
    expect(agg.strategyHash).toBe(sh);
    expect(agg.strategyConfig).toEqual(COMPOSITE);
    expect(agg.n).toBe(2);
    expect(agg.clusterId).toBe('extraction');

    // Pareto consumes the composite EvalResult aggregate like any other point.
    const frontier = computeFrontier(summary.aggregates);
    expect(frontier).toHaveLength(1);
    expect(frontier[0]!.strategyHash).toBe(sh);
    expect(frontier[0]!.strategyConfig).toEqual(COMPOSITE);
    expect(frontier[0]!.quality).toBe(agg.qualityMean);
  });
});
