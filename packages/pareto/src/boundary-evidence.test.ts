// A boundary cluster's evidence is every cell measured on ITS ITEMS, whichever
// suite paid for the cell. The platform sweep aggregates from eval_results by
// cluster_id, and a cell reused from a parent suite is stored under the parent
// — so both boundary frontiers published on 2026-09-08 saw only their fresh
// cells (luna n=50 of 64; ling n=40 of 90) and no slices at all.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EvalResult } from '@potion/core';
import { strategyHash } from '@potion/core';
import { createDb, insertEvalResult, migrate, type DbHandle } from '@potion/db';
import { aggregatesFromEvalResults } from './recompute.js';

const STRAT = { type: 'single', model: 'mock-mid' } as const;
const SH = strategyHash(STRAT);
const row = (itemId: string, clusterId: string, quality: number): EvalResult => ({
  runId: 'run-b', itemId, clusterId, strategyHash: SH, strategyConfig: STRAT, quality, scorer: 'exact',
  usage: { inputTokens: 10, outputTokens: 10, costUsd: 0.001, latencyMs: 100 }, latencyMs: { p50: 100, p95: 100, mean: 100 },
  modelVersions: {}, pricesVersion: 'v2', providerMode: 'live', instrument: 'default', cacheKey: `k-${clusterId}-${itemId}`, createdAt: '2026-09-08T00:00:00.000Z',
});
const ITEMS = [
  { id: 'p1-a', slice: 'p1' }, { id: 'p1-b', slice: 'p1' },      // measured under parent p1
  { id: 'p2-a', slice: 'p2' }, { id: 'p2-b', slice: 'p2' },      // one under parent p2, one fresh under the boundary
];

describe('a boundary frontier aggregates the cells on its items across its parents', () => {
  let handle: DbHandle;
  beforeAll(async () => {
    handle = await createDb('pglite://'); await migrate(handle.db);
    await insertEvalResult(handle.db, row('p1-a', 'p1', 1));
    await insertEvalResult(handle.db, row('p1-b', 'p1', 1));
    await insertEvalResult(handle.db, row('p2-a', 'p2', 0));
    await insertEvalResult(handle.db, row('p2-b', 'p1+p2', 1));      // fresh cell, stored under the boundary
    await insertEvalResult(handle.db, row('unrelated', 'p1', 0));    // a p1 item NOT in the union — must not leak in
  });
  afterAll(async () => { await handle.close(); });

  it('without items: only the rows stored under the boundary id (the defect, kept as the default for every other caller)', async () => {
    const [agg] = await aggregatesFromEvalResults(handle.db, 'p1+p2', [STRAT], 'v2', { providerMode: 'live' });
    expect(agg?.n).toBe(1);
  });

  it('with the suite items: every cell on those items, deduped, weakest slice as the quality, slices in evidence', async () => {
    const [agg] = await aggregatesFromEvalResults(handle.db, 'p1+p2', [STRAT], 'v2', { providerMode: 'live', items: ITEMS });
    expect(agg).toBeDefined();
    expect(agg!.clusterId).toBe('p1+p2');
    expect(agg!.n).toBe(4);                           // 2 from p1, 1 from p2, 1 fresh — not 'unrelated'
    expect(agg!.qualityMean).toBeCloseTo(0.5, 6);     // weakest slice p2 = (0 + 1)/2, not the union mean 0.75
    expect(agg!.evidence?.slices).toMatchObject({ p1: { n: 2, quality: 1 }, p2: { n: 2, quality: 0.5 } });
  });
});
