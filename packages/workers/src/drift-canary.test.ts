// The provider-drift tripwire: one job claim, ten deliberate sweeps.
//
// 2026-09-12, found on the first live run: the per-cluster platform sweep is
// guarded by withDeliveryGuard keyed on ctx.delivery, so ten sweeps inside
// one job shared one claim — the first ran and the other nine replayed its
// recorded result as their own reading. Pinned here: every sweep is called
// WITHOUT a delivery, the job itself is claimed once, idempotency is per
// (week, cluster), and a drift retires the model's cells and enqueues the
// learning period.
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { strategyHash, type FrontierPoint } from '@potion/core';
import { createDb, migrate, getLiveEvalResultByCacheKey, insertEvalResult, jobExecutions, listDriftCanariesForWeek, type DbHandle } from '@potion/db';
import { saveFrontier } from '@potion/pareto';
import { createDriftCanaryHandler } from './drift-canary.js';
import type { FrontierPlatformSweepResult, JobContext } from './handlers.js';
import type { FrontierPlatformSweepPayload } from './jobs.js';

const REPO_PRICES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../prices.json');
let db: DbHandle;
let pricesPath: string;

beforeEach(async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'drift-'));
  pricesPath = path.join(root, 'prices.json');
  copyFileSync(REPO_PRICES, pricesPath);
  db = await createDb();
  await migrate(db.db);
});
afterEach(async () => {
  await db.close();
});

function point(clusterId: string, model: string, quality: number, costPer1K: number, half = 0.02): FrontierPoint {
  const cfg = { type: 'single', model } as const;
  return {
    clusterId, strategyHash: strategyHash(cfg), strategyConfig: cfg, quality, costPer1K, latencyP95: 400, providerMode: 'live',
    evidence: { cacheKeys: [], runIds: ['r'], n: 40, qualityCi95: half },
  };
}

const WEEK = '2026-W37';
const NOW = new Date('2026-09-11T06:00:00Z');

describe('drift:canary', () => {
  it('claims the job once, calls every sweep WITHOUT a delivery, records per cluster, and a drift retires cells + enqueues learning', async () => {
    const cheapA = point('classification', 'mock-cheap', 0.98, 0.1);
    const cheapB = point('code-gen', 'mock-mid', 0.9, 0.2);
    await saveFrontier(db.db, 'classification', [cheapA, point('classification', 'mock-frontier', 0.99, 4)], 'manual', 'test-prices');
    await saveFrontier(db.db, 'code-gen', [cheapB, point('code-gen', 'mock-frontier', 0.95, 4)], 'manual', 'test-prices');
    // a live cell of the classification pick — the thing a drift must retire
    await insertEvalResult(db.db, {
      runId: 'run-old', itemId: 'it-1', clusterId: 'classification', strategyHash: cheapA.strategyHash, strategyConfig: cheapA.strategyConfig,
      quality: 0.98, scorer: 'exact', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }, latencyMs: { total: 1 }, modelVersions: {},
      pricesVersion: 'v', providerMode: 'live', cacheKey: 'ck-old', createdAt: NOW.toISOString(),
    } as never);

    const seen: Array<{ clusterId: string; delivery: unknown; salt: string | undefined }> = [];
    const enqueued: string[] = [];
    const sweep = async (payload: FrontierPlatformSweepPayload, ctx: JobContext): Promise<FrontierPlatformSweepResult> => {
      seen.push({ clusterId: payload.clusterId, delivery: ctx.delivery, salt: payload.cacheSalt });
      const target = payload.clusterId === 'classification' ? cheapA : cheapB;
      // classification collapsed to 0.5 (drift); code-gen reads as stored (ok)
      const meanQuality = payload.clusterId === 'classification' ? 0.5 : 0.9;
      return { published: false, spendUsd: 0.05, sampled: [{ strategyHash: target.strategyHash, n: 4, meanQuality }] } as unknown as FrontierPlatformSweepResult;
    };
    const handler = createDriftCanaryHandler({ sweep, now: () => NOW });
    const ctx: JobContext = {
      db: db.db, dbHandle: db, pricesPath,
      delivery: { jobId: 'job-drift-1', attempt: 1 },
      queue: { enqueue: async (kind: string) => { enqueued.push(kind); return 'j'; } } as never,
    };

    const res = await handler({}, ctx);
    expect(res.ran).toBe(true);
    expect(res.week).toBe(WEEK);
    // every sweep was a DELIBERATE call — no shared claim to replay
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const s of seen) {
      expect(s.delivery, `${s.clusterId} sweep must run without a delivery`).toBeUndefined();
      expect(s.salt).toBe(WEEK);
    }
    // one claim for the job itself
    const claims = await db.db.select().from(jobExecutions);
    expect(claims.filter((c) => c.jobKind === 'drift:canary')).toHaveLength(1);
    // the verdicts are each cluster's OWN reading
    const byCluster = new Map(res.canaries.map((c) => [c.clusterId, c]));
    expect(byCluster.get('classification')?.verdict).toBe('drift');
    expect(byCluster.get('code-gen')?.verdict).toBe('ok');
    expect(res.drift).toEqual(['classification/mock-cheap']);
    // the drifted model's cell is retired, the learning period enqueued
    expect(res.cellsRetired).toBe(1);
    expect(await getLiveEvalResultByCacheKey(db.db, 'ck-old')).toBeNull();
    expect(enqueued).toContain('learning:period');
    // recorded per cluster
    const rows = await listDriftCanariesForWeek(db.db, WEEK);
    expect(rows.map((r) => r.clusterId).sort()).toEqual([...byCluster.keys()].sort());

    // the same week again, a new job: nothing re-runs, nothing is spent
    const again = await handler({}, { ...ctx, delivery: { jobId: 'job-drift-2', attempt: 1 } });
    expect(again.ran).toBe(false);
    expect(again.alreadyRecorded.sort()).toEqual([...byCluster.keys()].sort());
    expect(seen.length, 'no sweep ran the second time').toBe(res.canaries.length);
  });

  it('a retry of the SAME job replays its recorded result instead of spending again', async () => {
    await saveFrontier(db.db, 'classification', [point('classification', 'mock-cheap', 0.98, 0.1)], 'manual', 'test-prices');
    let calls = 0;
    const sweep = async (_payload: FrontierPlatformSweepPayload): Promise<FrontierPlatformSweepResult> => {
      calls += 1;
      return { published: false, spendUsd: 0.05, sampled: [{ strategyHash: strategyHash({ type: 'single', model: 'mock-cheap' }), n: 4, meanQuality: 0.98 }] } as unknown as FrontierPlatformSweepResult;
    };
    const handler = createDriftCanaryHandler({ sweep, now: () => NOW });
    const ctx: JobContext = { db: db.db, dbHandle: db, pricesPath, delivery: { jobId: 'job-drift-9', attempt: 1 } };
    const first = await handler({}, ctx);
    const replay = await handler({}, { ...ctx, delivery: { jobId: 'job-drift-9', attempt: 2 } });
    expect(calls).toBe(first.canaries.length);
    expect(replay).toEqual(first);
  });
});
