// Migration 0002 (provenance + staleness columns) tests: PGlite, zero
// services. Asserts the DEFAULT 'unknown' (absence is explicit — a row can
// never default into fake 'live' evidence), the check constraint, the stale
// default, and repo round-trips.
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { EvalResult, Frontier } from '@potion/core';
import {
  createDb,
  evalResults,
  frontierPoints,
  getEvalResultByCacheKey,
  insertEvalResult,
  insertFrontier,
  migrate,
  type DbHandle,
} from './index.js';

const EVAL_RESULT: EvalResult = {
  runId: 'run-1',
  itemId: 'item-1',
  clusterId: 'code-gen',
  strategyHash: 'abc123',
  strategyConfig: { type: 'single', model: 'mock-cheap' },
  quality: 0.9,
  scorer: 'exact',
  usage: { inputTokens: 10, outputTokens: 20, costUsd: 0, latencyMs: 300 },
  latencyMs: { p50: 300, p95: 320, mean: 305 },
  modelVersions: { 'mock-cheap': 'mock-cheap-v1#mock-v1' },
  pricesVersion: '2026-08-04',
  cacheKey: 'prov-cache-key-1',
  createdAt: '2026-08-04T00:00:01.000Z',
};

async function migratedDb(): Promise<DbHandle> {
  const handle = await createDb();
  await migrate(handle.db);
  return handle;
}

describe('migration 0002 — provenance + staleness columns', () => {
  it("eval_results.provider_mode defaults to 'unknown' and stale to false", async () => {
    const handle = await migratedDb();
    try {
      await insertEvalResult(handle.db, EVAL_RESULT); // no providerMode set
      const rows = await handle.db
        .select({ providerMode: evalResults.providerMode, stale: evalResults.stale })
        .from(evalResults);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.providerMode).toBe('unknown');
      expect(rows[0]!.stale).toBe(false);
      // ...and reads back as ABSENCE on the core object (never 'live').
      const back = await getEvalResultByCacheKey(handle.db, EVAL_RESULT.cacheKey);
      expect(back!.providerMode).toBeUndefined();
    } finally {
      await handle.close();
    }
  });

  it('round-trips a recorded providerMode', async () => {
    const handle = await migratedDb();
    try {
      await insertEvalResult(handle.db, { ...EVAL_RESULT, providerMode: 'mock' });
      const back = await getEvalResultByCacheKey(handle.db, EVAL_RESULT.cacheKey);
      expect(back!.providerMode).toBe('mock');
    } finally {
      await handle.close();
    }
  });

  it('check constraint rejects non mock|live|unknown values', async () => {
    const handle = await migratedDb();
    try {
      // drizzle-orm 0.45 wraps driver errors ("Failed query: …", the postgres
      // message moves to `cause`) — assert the constraint fires by walking the
      // cause chain instead of matching the wrapper message.
      const err = await handle.db
        .execute(
          sql`INSERT INTO eval_results (cache_key, run_id, item_id, cluster_id, strategy_hash, strategy_config, quality, scorer, usage, latency_ms, model_versions, prices_version, provider_mode, created_at)
              VALUES ('ck-bad', 'r', 'i', 'c', 'h', '{}', 0.5, 'exact', '{}', '{}', '{}', 'v1', 'bogus', 'now')`,
        )
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err).not.toBeNull();
      const chain: string[] = [];
      for (let cur: unknown = err; cur instanceof Error; cur = (cur as { cause?: unknown }).cause) {
        chain.push(cur.message);
      }
      expect(chain.join(' | ')).toMatch(/check|violates/i);
    } finally {
      await handle.close();
    }
  });

  it('frontier_points persist provider_mode per point (default unknown)', async () => {
    const handle = await migratedDb();
    try {
      const frontier: Frontier = {
        id: 'fr-prov-1',
        clusterId: 'code-gen',
        version: 1,
        parentId: null,
        trigger: 'manual',
        points: [
          {
            clusterId: 'code-gen',
            strategyHash: 'h-live',
            strategyConfig: { type: 'single', model: 'sonnet-class' },
            quality: 0.9,
            costPer1K: 1,
            latencyP95: 900,
            providerMode: 'live',
          },
          {
            clusterId: 'code-gen',
            strategyHash: 'h-unlabeled',
            strategyConfig: { type: 'single', model: 'mock-cheap' },
            quality: 0.5,
            costPer1K: 0.1,
            latencyP95: 300,
          },
        ],
        pricesVersion: '2026-08-04',
        createdAt: '2026-08-04T00:00:00.000Z',
      };
      await insertFrontier(handle.db, frontier);
      const rows = await handle.db
        .select({ strategyHash: frontierPoints.strategyHash, providerMode: frontierPoints.providerMode })
        .from(frontierPoints);
      const byHash = new Map(rows.map((r) => [r.strategyHash, r.providerMode]));
      expect(byHash.get('h-live')).toBe('live');
      expect(byHash.get('h-unlabeled')).toBe('unknown');
    } finally {
      await handle.close();
    }
  });

  it('migrate is idempotent with 0002 applied twice', async () => {
    const handle = await migratedDb();
    try {
      const applied = await migrate(handle.db); // second run: no error
      expect(applied).toContain('0002_provenance.sql');
    } finally {
      await handle.close();
    }
  });
});
