// Recompute integration test: PGlite + memory queue + mock provider,
// end-to-end (SPEC §6 / Gate 4). Zero network, zero services.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { strategyHash, type EvalItem, type PriceEntry } from '@potion/core';
import { createDb, migrate, type DbHandle } from '@potion/db';
import { runEval } from '@potion/harness';
import { evalTaskById, loadPrices } from '@potion/providers';
import { createQueue } from '@potion/queue';
import { computeFrontier } from './dominance.js';
import { loadCurrentFrontier, saveFrontier } from './persistence.js';
import {
  mergePriceEntry,
  planRecompute,
  RECOMPUTE_PLAN_CAP,
  runRecompute,
} from './recompute.js';

const PRICES_PATH = fileURLToPath(new URL('../../../prices.json', import.meta.url));
const prices = loadPrices(PRICES_PATH).table;

const NEW_MODEL: PriceEntry = {
  alias: 'mock-new-x',
  provider: 'mock',
  model: 'mock-mid',
  inputPer1M: 0.8,
  outputPer1M: 4.0,
};

// Two-item code-gen suite built from the mock corpus (deterministic answers).
function suiteItem(id: string): EvalItem {
  const task = evalTaskById(id)!;
  return {
    id: task.id,
    clusterId: 'code-gen',
    prompt: [
      {
        role: 'user',
        content: `EVAL: ${task.id}\n${task.task}\n\nRespond with ONLY the JavaScript function source, no markdown fences, no explanation.`,
      },
    ],
    reference: task.reference,
    scoring: { kind: 'code-exec', language: 'javascript', tests: task.tests ?? '' },
  };
}

function extractionItem(id: string): EvalItem {
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

const suiteDir = mkdtempSync(`${tmpdir()}/potion-pareto-suites-`);
writeFileSync(
  `${suiteDir}/code-gen.jsonl`,
  [suiteItem('cg-01'), suiteItem('cg-02')].map((i) => JSON.stringify(i)).join('\n') + '\n',
);
writeFileSync(
  `${suiteDir}/extraction.jsonl`,
  [extractionItem('ex-01'), extractionItem('ex-02')].map((i) => JSON.stringify(i)).join('\n') + '\n',
);

describe('planRecompute', () => {
  it('plans solo + shortlist, capped at RECOMPUTE_PLAN_CAP', () => {
    const plan = planRecompute(NEW_MODEL, prices);
    expect(plan.length).toBeLessThanOrEqual(RECOMPUTE_PLAN_CAP);
    expect(plan).toHaveLength(5);
    expect(plan[0]).toEqual({ type: 'single', model: 'mock-new-x' });
    // new model as cheap stage
    expect(plan[1]).toMatchObject({
      type: 'cascade',
      stages: [{ model: 'mock-new-x' }, { model: 'frontier-class' }],
    });
    // new model as strong stage
    expect(plan[2]).toMatchObject({
      type: 'cascade',
      stages: [{ model: 'cheap-class' }, { model: 'mock-new-x' }],
    });
    expect(plan[3]).toMatchObject({ type: 'best-of-n', model: 'mock-new-x', n: 3 });
    expect(plan[4]).toMatchObject({
      type: 'draft-verify',
      draftModel: 'mock-new-x',
      verifierModel: 'frontier-class',
    });
  });

  it('mergePriceEntry bumps version and replaces same-alias entries', () => {
    const merged = mergePriceEntry(prices, NEW_MODEL);
    expect(merged.version).toBe(`${prices.version}+mock-new-x`);
    expect(merged.entries.filter((e) => e.alias === 'mock-new-x')).toHaveLength(1);
    expect(merged.entries).toHaveLength(prices.entries.length + 1);
    const again = mergePriceEntry(merged, { ...NEW_MODEL, inputPer1M: 1.1 });
    expect(again.entries.filter((e) => e.alias === 'mock-new-x')).toHaveLength(1);
  });
});

describe('runRecompute (PGlite + memory queue + mock provider)', () => {
  let handle: DbHandle;
  beforeAll(async () => {
    handle = await createDb('pglite://');
    await migrate(handle.db);
  });
  afterAll(async () => {
    await handle.close();
  });

  it('baseline eval → frontier v1 → new-model recompute → v2 + diff', async () => {
    // ---- baseline: two strategies on code-gen → frontier v1 ----
    const baselineStrategies = [
      { type: 'single', model: 'cheap-class' } as const,
      { type: 'single', model: 'frontier-class' } as const,
    ];
    const baseline = await runEval(
      { suiteIds: ['code-gen'], strategies: [...baselineStrategies], budgetCapUsd: 5 },
      { db: handle, suitesDir: suiteDir, pricesPath: PRICES_PATH },
    );
    expect(baseline.aggregates).toHaveLength(2);
    const v1Points = computeFrontier(baseline.aggregates);
    const v1 = await saveFrontier(handle.db, 'code-gen', v1Points, 'manual', prices.version);
    expect(v1.version).toBe(1);

    // ---- new model release → runRecompute ----
    const queue = createQueue('memory');
    const result = await runRecompute({
      db: handle,
      queue,
      newModel: NEW_MODEL,
      clusterIds: ['code-gen'],
      pricesPath: PRICES_PATH,
      suitesDir: suiteDir,
      budgetCapUsd: 5,
    });
    await queue.close();

    // jobs: one eval job (one cluster) + one recompute-frontier job
    expect(result.evalJobIds).toHaveLength(1);
    expect(result.recomputeJobId).toBeTruthy();
    expect(result.plan).toHaveLength(5);
    expect(result.evalSummaries).toHaveLength(1);
    expect(result.evalSummaries[0]!.aggregates).toHaveLength(5);
    expect(result.pricesVersion).toBe(`${prices.version}+mock-new-x`);

    // frontier v2 chained to v1
    expect(result.frontiers).toHaveLength(1);
    const v2 = result.frontiers[0]!;
    expect(v2.version).toBe(2);
    expect(v2.parentId).toBe(v1.id);
    expect(v2.trigger).toBe('new-model');
    expect(v2.pricesVersion).toBe(result.pricesVersion);

    // the new model's solo strategy must appear on the recomputed frontier
    // (cheaper than cheap-class, quality >= cheap-class in the mock corpus;
    // nothing in the pool beats it on all three axes).
    const soloHash = strategyHash({ type: 'single', model: 'mock-new-x' });
    expect(v2.points.some((p) => p.strategyHash === soloHash)).toBe(true);

    // diff vs v1
    expect(result.diffs).toHaveLength(1);
    const diff = result.diffs[0]!;
    expect(diff.fromVersion).toBe(1);
    expect(diff.toVersion).toBe(2);
    expect(diff.appeared.map((p) => p.strategyHash)).toContain(soloHash);
    expect(diff.narrative.length).toBeGreaterThan(0);
    expect(diff.narrative.some((s) => s.includes('is new on the frontier'))).toBe(true);

    // persistence round-trip of v2
    const current = await loadCurrentFrontier(handle.db, 'code-gen');
    expect(current!.id).toBe(v2.id);
    expect(current!.points).toEqual(v2.points);
  }, 60_000);

  it('recompute on a cluster with no prior frontier → diff from v0, all appeared', async () => {
    const queue = createQueue('memory');
    const result = await runRecompute({
      db: handle,
      queue,
      newModel: NEW_MODEL,
      clusterIds: ['extraction'], // fresh cluster: no frontier saved yet
      pricesPath: PRICES_PATH,
      suitesDir: suiteDir,
      budgetCapUsd: 5,
    });
    await queue.close();
    const v1 = result.frontiers[0]!;
    expect(v1.version).toBe(1);
    expect(v1.parentId).toBeNull();
    const diff = result.diffs[0]!;
    expect(diff.fromVersion).toBe(0);
    expect(diff.toVersion).toBe(1);
    expect(diff.vanished).toEqual([]);
    expect(diff.appeared.map((p) => p.strategyHash).sort()).toEqual(
      v1.points.map((p) => p.strategyHash).sort(),
    );
    expect(diff.narrative.every((s) => s.includes('is new on the frontier'))).toBe(true);
  }, 60_000);
});
