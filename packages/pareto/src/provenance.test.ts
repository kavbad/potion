// Pareto provenance + stale-exclusion tests (ROADMAP M1a items 4/6):
// saveFrontier/loadCurrentFrontier round-trip provider_mode per point;
// aggregatesFromEvalResults excludes stale rows by default (includeStale
// override); aggregateToPoint carries provenance onto frontier points.
// PGlite, zero services.
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EvalResult, FrontierPoint, StrategyAggregate } from '@potion/core';
import { strategyHash } from '@potion/core';
import { createDb, evalResults, insertEvalResult, migrate, type DbHandle } from '@potion/db';
import { markStale } from '@potion/harness';
import { aggregateToPoint, computeFrontier } from './dominance.js';
import { loadCurrentFrontier, saveFrontier } from './persistence.js';
import { aggregatesFromEvalResults } from './recompute.js';

const STRAT_A = { type: 'single', model: 'mock-mid' } as const;
const STRAT_B = { type: 'single', model: 'mock-cheap' } as const;
const SH_A = strategyHash(STRAT_A);
const SH_B = strategyHash(STRAT_B);

function evalRow(cacheKey: string, over: Partial<EvalResult> = {}): EvalResult {
  return {
    runId: 'run-p',
    itemId: cacheKey,
    clusterId: 'code-gen',
    strategyHash: SH_A,
    strategyConfig: { type: 'single', model: 'mock-mid' },
    quality: 0.8,
    scorer: 'exact',
    usage: { inputTokens: 10, outputTokens: 10, costUsd: 0.001, latencyMs: 100 },
    latencyMs: { p50: 100, p95: 100, mean: 100 },
    modelVersions: { 'mock-mid': 'mid-v2' },
    pricesVersion: 'v2',
    providerMode: 'mock',
    cacheKey,
    createdAt: '2026-08-04T00:00:00.000Z',
    ...over,
  };
}

describe('frontier provenance persistence', () => {
  let handle: DbHandle;
  beforeAll(async () => {
    handle = await createDb('pglite://');
    await migrate(handle.db);
  });
  afterAll(async () => {
    await handle.close();
  });

  const points: FrontierPoint[] = [
    {
      clusterId: 'code-gen',
      strategyHash: 'h-mock',
      strategyConfig: { type: 'single', model: 'mock-cheap' },
      quality: 0.6,
      costPer1K: 0.1,
      latencyP95: 300,
      providerMode: 'mock',
    },
    {
      clusterId: 'code-gen',
      strategyHash: 'h-live',
      strategyConfig: { type: 'single', model: 'sonnet-class' },
      quality: 0.9,
      costPer1K: 1,
      latencyP95: 900,
      providerMode: 'live',
    },
  ];

  it('saveFrontier persists provider_mode per point; loadCurrentFrontier returns it', async () => {
    const saved = await saveFrontier(handle.db, 'code-gen', points, 'manual', 'v2');
    const loaded = await loadCurrentFrontier(handle.db, 'code-gen');
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(saved.id);
    const byHash = new Map(loaded!.points.map((p) => [p.strategyHash, p.providerMode]));
    expect(byHash.get('h-mock')).toBe('mock');
    expect(byHash.get('h-live')).toBe('live');
  });

  it('unlabeled points load back with providerMode absent (== unknown)', async () => {
    const unlabeled: FrontierPoint = { ...points[0]!, strategyHash: 'h-unl' };
    delete unlabeled.providerMode;
    const saved = await saveFrontier(handle.db, 'extraction', [unlabeled], 'manual', 'v2');
    const loaded = await loadCurrentFrontier(handle.db, 'extraction');
    expect(loaded!.id).toBe(saved.id);
    expect(loaded!.points[0]!.providerMode).toBeUndefined();
  });
});

describe('aggregateToPoint provenance', () => {
  it('carries aggregate providerMode onto the frontier point', () => {
    const agg: StrategyAggregate = {
      clusterId: 'code-gen',
      strategyHash: 'sh',
      strategyConfig: { type: 'single', model: 'mock-cheap' },
      qualityMean: 0.7,
      qualityCi95: 0,
      n: 3,
      costPer1K: 0.2,
      latencyP50: 300,
      latencyP95: 400,
      pricesVersion: 'v2',
      providerMode: 'mock',
    };
    expect(aggregateToPoint(agg).providerMode).toBe('mock');
    expect(computeFrontier([agg])[0]!.providerMode).toBe('mock');
  });
});

describe('aggregatesFromEvalResults — stale exclusion', () => {
  let handle: DbHandle;
  beforeAll(async () => {
    handle = await createDb('pglite://');
    await migrate(handle.db);
    // strategy sh-a: two FRESH rows; strategy sh-b: two rows that will go stale
    await insertEvalResult(handle.db, evalRow('ck-a1'));
    await insertEvalResult(handle.db, evalRow('ck-a2', { itemId: 'i2' }));
    await insertEvalResult(
      handle.db,
      evalRow('ck-b1', { strategyHash: SH_B, strategyConfig: STRAT_B, pricesVersion: 'v1-old' }),
    );
    await insertEvalResult(
      handle.db,
      evalRow('ck-b2', { strategyHash: SH_B, strategyConfig: STRAT_B, itemId: 'i2', pricesVersion: 'v1-old' }),
    );
    await markStale(handle.db, { pricesVersion: 'v2' }); // flags ck-b1/ck-b2
  });
  afterAll(async () => {
    await handle.close();
  });

  const strategies = [STRAT_A, STRAT_B];

  it('excludes stale rows by default, keeping provenance from fresh rows', async () => {
    // sanity: fixture staleness
    const staleCount = await handle.db
      .select({ cacheKey: evalResults.cacheKey })
      .from(evalResults)
      .where(eq(evalResults.stale, true));
    expect(staleCount.map((r) => r.cacheKey).sort()).toEqual(['ck-b1', 'ck-b2']);

    // NOTE: sh-b rows are stale but ALSO filtered by pricesVersion below; to
    // isolate the stale filter we aggregate without the prices restriction
    // via the same pricesVersion the fresh rows carry.
    const aggs = await aggregatesFromEvalResults(handle.db, 'code-gen', strategies, 'v2');
    expect(aggs).toHaveLength(1);
    expect(aggs[0]!.strategyHash).toBe(SH_A);
    expect(aggs[0]!.n).toBe(2);
    expect(aggs[0]!.providerMode).toBe('mock');
  });

  it('stale rows under the CURRENT prices version are still excluded', async () => {
    // make a stale row that otherwise matches the query
    await insertEvalResult(
      handle.db,
      evalRow('ck-a3-stale', { pricesVersion: 'v2', modelVersions: { 'mock-mid': 'mid-v1' } }),
    );
    await markStale(handle.db, { modelVersions: { 'mock-mid': 'mid-v2' } });

    const def = await aggregatesFromEvalResults(handle.db, 'code-gen', strategies, 'v2');
    expect(def).toHaveLength(1);
    expect(def[0]!.n).toBe(2); // ck-a3-stale excluded

    const incl = await aggregatesFromEvalResults(handle.db, 'code-gen', strategies, 'v2', {
      includeStale: true,
    });
    expect(incl).toHaveLength(1);
    expect(incl[0]!.n).toBe(3); // --include-stale override brings it back
  });
});
