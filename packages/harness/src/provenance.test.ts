// Runner provenance tests (ROADMAP M1a item 4): runEval determines the
// provider mode from the provider set and stamps it on every EvalResult and
// every StrategyAggregate; an explicit override exists for tests.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EvalItem } from '@potion/core';
import { createDb, getEvalResultByCacheKey, type DbHandle } from '@potion/db';
import { createMockProvider, evalTaskById, loadPrices } from '@potion/providers';
import { createRunProviders, detectProviderMode, runEval, type RunDeps } from './runner.js';

const PRICES_PATH = fileURLToPath(new URL('../../../prices.json', import.meta.url));
const prices = loadPrices(PRICES_PATH).table;

function suiteItem(id: string): EvalItem {
  const task = evalTaskById(id)!;
  return {
    id: task.id,
    clusterId: 'extraction',
    prompt: [
      { role: 'user', content: `EVAL: ${task.id}\n${task.task}\n\nRespond with ONLY the JSON object.` },
    ],
    reference: JSON.parse(task.reference) as unknown,
    scoring: { kind: 'field-match', schema: task.schema ?? {} },
  };
}

const suiteDir = mkdtempSync(`${tmpdir()}/potion-harness-prov-suites-`);
writeFileSync(
  `${suiteDir}/extraction.jsonl`,
  [suiteItem('ex-03')].map((i) => JSON.stringify(i)).join('\n') + '\n',
);

describe('detectProviderMode', () => {
  it('mock world (same mock instance behind every id) → mock', () => {
    expect(detectProviderMode(createRunProviders('mock', prices))).toBe('mock');
  });
  it('live factory (distinct lazy transports) → live', () => {
    expect(detectProviderMode(createRunProviders('live', prices))).toBe('live');
  });
  it('a hand-built set with any distinct non-mock provider → live', () => {
    const mock = createMockProvider(prices);
    const set = { anthropic: mock, openai: mock, google: mock, openrouter: mock, mock };
    expect(detectProviderMode(set)).toBe('mock');
    const mixed = { ...set, openai: { id: 'openai' as const, complete: mock.complete } };
    expect(detectProviderMode(mixed)).toBe('live');
  });
});

describe('runEval provenance stamping', () => {
  let handle: DbHandle;
  beforeAll(async () => {
    handle = await createDb('pglite://');
  });
  afterAll(async () => {
    await handle.close();
  });
  const deps = (): RunDeps => ({ db: handle, suitesDir: suiteDir, pricesPath: PRICES_PATH });

  it("mock providers → 'mock' on every EvalResult, aggregate and the summary", async () => {
    const summary = await runEval(
      { suiteIds: ['extraction'], strategies: [{ type: 'single', model: 'mock-cheap' }], budgetCapUsd: 25 },
      deps(),
    );
    expect(summary.providerMode).toBe('mock');
    expect(summary.results.every((r) => r.providerMode === 'mock')).toBe(true);
    expect(summary.aggregates.every((a) => a.providerMode === 'mock')).toBe(true);
    // persisted rows carry it too
    const row = await getEvalResultByCacheKey(handle.db, summary.results[0]!.cacheKey);
    expect(row!.providerMode).toBe('mock');
  });

  it('providerModeOverride wins over detection (tests)', async () => {
    const summary = await runEval(
      {
        suiteIds: ['extraction'],
        strategies: [{ type: 'single', model: 'mock-mid' }],
        budgetCapUsd: 25,
        providerModeOverride: 'live',
      },
      deps(),
    );
    expect(summary.providerMode).toBe('live');
    expect(summary.results.every((r) => r.providerMode === 'live')).toBe(true);
    expect(summary.aggregates.every((a) => a.providerMode === 'live')).toBe(true);
  });
});
