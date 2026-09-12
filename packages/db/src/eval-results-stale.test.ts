// A retired cell is a MISS, and a fresh answer replaces it (2026-09-11).
// Before this the staleness flag was decorative: the runner's resume lookup
// never read it, so a flagged row was still a hit — which is exactly what
// made provider drift invisible to content-addressed evidence.
import { describe, expect, it } from 'vitest';
import type { EvalResult } from '@potion/core';
import { createDb, migrate } from './index.js';
import { getEvalResultByCacheKey, getLiveEvalResultByCacheKey, insertEvalResult, retireEvalResultsByStrategyHash, upsertEvalResult } from './repos/eval-results.js';

function cell(over: Partial<EvalResult> = {}): EvalResult {
  return {
    runId: 'run-1', itemId: 'item-1', clusterId: 'classification', strategyHash: 'hash-A',
    strategyConfig: { type: 'single', model: 'mock-cheap' }, quality: 0.9, scorer: 'exact',
    usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }, latencyMs: { total: 1 }, modelVersions: {},
    pricesVersion: 'v', providerMode: 'mock', cacheKey: 'ck-1', createdAt: new Date().toISOString(),
    ...over,
  } as EvalResult;
}

describe('eval cell invalidation', () => {
  it('retiring a strategy hides its cells from the live lookup, and an upsert replaces the retired row', async () => {
    const h = await createDb();
    await migrate(h.db);
    await insertEvalResult(h.db, cell());
    await insertEvalResult(h.db, cell({ cacheKey: 'ck-2', itemId: 'item-2', strategyHash: 'hash-B' }));
    expect(await getLiveEvalResultByCacheKey(h.db, 'ck-1')).not.toBeNull();

    expect(await retireEvalResultsByStrategyHash(h.db, 'hash-A')).toBe(1);
    expect(await getLiveEvalResultByCacheKey(h.db, 'ck-1'), 'a retired cell is a miss').toBeNull();
    expect(await getEvalResultByCacheKey(h.db, 'ck-1'), 'the row itself is kept for audit').not.toBeNull();
    expect(await getLiveEvalResultByCacheKey(h.db, 'ck-2'), 'other strategies untouched').not.toBeNull();
    expect(await retireEvalResultsByStrategyHash(h.db, 'hash-A'), 'idempotent').toBe(0);

    await upsertEvalResult(h.db, cell({ quality: 0.7, runId: 'run-2' }));
    const fresh = await getLiveEvalResultByCacheKey(h.db, 'ck-1');
    expect(fresh?.quality).toBe(0.7);
    expect(fresh?.runId).toBe('run-2');
    await h.close();
  });
});
