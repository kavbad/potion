import { describe, expect, it } from 'vitest';
import type { EvalResult, Frontier } from '@potion/core';
import {
  clusterExemplars,
  clusters,
  createDb,
  DEFAULT_ORG_ID,
  getEvalResultByCacheKey,
  getLatestFrontier,
  insertEvalResult,
  insertFrontier,
  insertRequestLog,
  listEvalResults,
  listRequestLogs,
  migrate,
  splitStatements,
  type DbHandle,
} from './index.js';

const FRONTIER: Frontier = {
  id: 'fr-code-gen-1',
  clusterId: 'code-gen',
  version: 1,
  parentId: null,
  trigger: 'manual',
  points: [
    {
      clusterId: 'code-gen',
      strategyHash: 'abc123',
      strategyConfig: { type: 'single', model: 'mock-cheap' },
      quality: 0.82,
      costPer1K: 0.05,
      latencyP95: 900,
    },
  ],
  pricesVersion: '2026-08-04',
  createdAt: '2026-08-04T00:00:00.000Z',
};

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
  cacheKey: 'cache-key-1',
  createdAt: '2026-08-04T00:00:01.000Z',
};

async function migratedDb(): Promise<DbHandle> {
  const handle = await createDb(); // PGlite: no url, zero services
  await migrate(handle.db);
  return handle;
}

describe('migrate on PGlite', () => {
  it('applies SQL migration files (idempotent) and reports them', async () => {
    const handle = await createDb();
    try {
      const applied = await migrate(handle.db);
      expect(applied).toContain('0000_init.sql');
      // second run must not throw (CREATE ... IF NOT EXISTS)
      await expect(migrate(handle.db)).resolves.toContain('0000_init.sql');
    } finally {
      await handle.close();
    }
  });

  it('vector(384) column round-trips embeddings on cluster_exemplars', async () => {
    const handle = await createDb();
    try {
      await migrate(handle.db);
      const embedding = Array.from({ length: 384 }, (_, i) => (i % 7) / 7);
      await handle.db.insert(clusters).values({
        id: 'code-gen',
        name: 'Code generation',
        description: 'stub',
        exemplarCount: 1,
      });
      await handle.db.insert(clusterExemplars).values({
        clusterId: 'code-gen',
        text: 'Write a Python function',
        embedding,
      });
      const rows = await handle.db.select().from(clusterExemplars);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.embedding).toHaveLength(384);
      expect(rows[0]?.embedding?.[0]).toBeCloseTo(0, 6);
      expect(rows[0]?.embedding?.[6]).toBeCloseTo(6 / 7, 6);
    } finally {
      await handle.close();
    }
  });

  it('splitStatements splits on statement breakpoints and skips empties', () => {
    const stmts = splitStatements('SELECT 1;\n--> statement-breakpoint\n\nSELECT 2;');
    expect(stmts).toEqual(['SELECT 1;', 'SELECT 2;']);
  });
});

describe('repositories on PGlite', () => {
  it('inserts + selects a frontier (with points) via the repo', async () => {
    const handle = await migratedDb();
    try {
      await insertFrontier(handle.db, FRONTIER);
      const latest = await getLatestFrontier(handle.db, 'code-gen');
      // G1.6: rows come back with their scope made explicit (null = platform).
      expect(latest).toEqual({ ...FRONTIER, orgId: null, instrument: 'default' });
    } finally {
      await handle.close();
    }
  });

  it('inserts + selects an eval result by cache key and run id', async () => {
    const handle = await migratedDb();
    try {
      await insertEvalResult(handle.db, EVAL_RESULT);
      expect(await getEvalResultByCacheKey(handle.db, 'cache-key-1')).toEqual(EVAL_RESULT);
      expect(await getEvalResultByCacheKey(handle.db, 'missing')).toBeNull();
      expect(await listEvalResults(handle.db, 'run-1')).toEqual([EVAL_RESULT]);
    } finally {
      await handle.close();
    }
  });

  it('inserts + lists request logs', async () => {
    const handle = await migratedDb();
    try {
      const id = await insertRequestLog(handle.db, {
        orgId: DEFAULT_ORG_ID,
        clusterId: 'code-gen',
        strategyHash: 'abc123',
        model: 'mock-frontier',
        usage: { inputTokens: 5, outputTokens: 10, costUsd: 0, latencyMs: 1800 },
        latencyMs: 1800,
        status: 'ok',
        trace: 'cluster=code-gen;strategy=abc123;frontier=v1;policy=max_quality',
      });
      expect(id).toBeGreaterThan(0n);
      const logs = await listRequestLogs(handle.db, DEFAULT_ORG_ID);
      expect(logs).toHaveLength(1);
      expect(logs[0]?.model).toBe('mock-frontier');
    } finally {
      await handle.close();
    }
  });
});
