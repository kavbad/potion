// Staleness engine tests (ROADMAP M1a item 6): PGlite, zero services.
// Insert eval results with MIXED versions → markStale flags exactly the rows
// whose prices/judge/model versions drifted; stalenessReport is a dry run.
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EvalResult } from '@potion/core';
import { createDb, evalResults, insertEvalResult, migrate, type DbHandle } from '@potion/db';
import { markStale, stalenessReport } from './staleness.js';

function result(cacheKey: string, over: Partial<EvalResult> = {}): EvalResult {
  return {
    runId: 'run-stale',
    itemId: cacheKey,
    clusterId: 'code-gen',
    strategyHash: 'sh-1',
    strategyConfig: { type: 'single', model: 'mock-mid' },
    quality: 0.8,
    scorer: 'exact',
    usage: { inputTokens: 10, outputTokens: 10, costUsd: 0, latencyMs: 100 },
    latencyMs: { p50: 100, p95: 100, mean: 100 },
    modelVersions: { 'mock-mid': 'mid-v2' },
    pricesVersion: 'v2',
    cacheKey,
    createdAt: '2026-08-04T00:00:00.000Z',
    ...over,
  };
}

async function staleFlags(handle: DbHandle): Promise<Map<string, boolean>> {
  const rows = await handle.db
    .select({ cacheKey: evalResults.cacheKey, stale: evalResults.stale })
    .from(evalResults);
  return new Map(rows.map((r) => [r.cacheKey, r.stale]));
}

describe('staleness engine (markStale / stalenessReport)', () => {
  let handle: DbHandle;
  beforeAll(async () => {
    handle = await createDb('pglite://');
    await migrate(handle.db);
    // mixed-version fixture: one row per drift cause + two fresh rows
    await insertEvalResult(handle.db, result('ck-prices', { pricesVersion: 'v1-old' }));
    await insertEvalResult(handle.db, result('ck-judge', { scorer: 'llm-judge:judge-v1' }));
    await insertEvalResult(
      handle.db,
      result('ck-model', { modelVersions: { 'mock-mid': 'mid-v1' } }),
    );
    await insertEvalResult(handle.db, result('ck-fresh'));
    await insertEvalResult(
      handle.db,
      result('ck-fresh-noalias', { modelVersions: { 'mock-cheap': 'cheap-v1' } }),
    );
  });
  afterAll(async () => {
    await handle.close();
  });

  const CURRENT = {
    pricesVersion: 'v2',
    judgeModel: 'judge-v2',
    modelVersions: { 'mock-mid': 'mid-v2' },
  };

  it('stalenessReport counts would-be stale rows by cause (dry run)', async () => {
    const report = await stalenessReport(handle.db, CURRENT);
    expect(report.scanned).toBe(5);
    expect(report.alreadyStale).toBe(0);
    expect(report.byCause).toEqual({ pricesVersion: 1, judgeModel: 1, modelVersions: 1 });
    expect(report.newlyFlagged).toBe(3);
    // dry run: nothing was modified
    const flags = await staleFlags(handle);
    expect([...flags.values()].every((s) => s === false)).toBe(true);
  });

  it('rows that never used an alias are not flagged by the model cause', async () => {
    const report = await stalenessReport(handle.db, { modelVersions: { 'mock-cheap': 'cheap-v2' } });
    expect(report.byCause.modelVersions).toBe(1); // ck-fresh-noalias only
    expect(report.newlyFlagged).toBe(1);
  });

  it('a judge cause never flags deterministic scorers', async () => {
    const report = await stalenessReport(handle.db, { judgeModel: 'judge-v2' });
    expect(report.byCause.judgeModel).toBe(1); // only ck-judge (scorer llm-judge:judge-v1)
  });

  it('markStale flags exactly the drifted rows, idempotently', async () => {
    const counts = await markStale(handle.db, CURRENT);
    expect(counts.newlyFlagged).toBe(3);
    const flags = await staleFlags(handle);
    expect(flags.get('ck-prices')).toBe(true);
    expect(flags.get('ck-judge')).toBe(true);
    expect(flags.get('ck-model')).toBe(true);
    expect(flags.get('ck-fresh')).toBe(false);
    expect(flags.get('ck-fresh-noalias')).toBe(false);

    // second run: nothing new to flag
    const again = await markStale(handle.db, CURRENT);
    expect(again.newlyFlagged).toBe(0);
    expect(again.alreadyStale).toBe(3);
  });

  it('markStale with no current values flags nothing', async () => {
    const counts = await markStale(handle.db, {});
    expect(counts.newlyFlagged).toBe(0);
  });

  it('stale column is directly queryable for downstream exclusion', async () => {
    const staleRows = await handle.db
      .select({ cacheKey: evalResults.cacheKey })
      .from(evalResults)
      .where(eq(evalResults.stale, true));
    expect(staleRows.map((r) => r.cacheKey).sort()).toEqual(['ck-judge', 'ck-model', 'ck-prices']);
  });
});
