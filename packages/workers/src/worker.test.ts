// Worker tests (SPEC §12.2): eval:run end-to-end on mock providers with
// results persisted + artifact written; staleness:scan; shadow:judge stub;
// handler override; sweep:run budget-governed loop.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { strategyHash, type FrontierPoint, type Policy, type StrategyConfig } from '@potion/core';
import { createArtifactStore, type ArtifactStore } from '@potion/artifacts';
import {
  createDb,
  DEFAULT_ORG_ID,
  evalResults,
  evalRuns,
  insertFrontier,
  insertPolicy,
  insertQualitySample,
  listIncidents,
  listQualitySamples,
  migrate,
  strategyConfigs,
  type DbHandle,
} from '@potion/db';
import { createQueue } from '@potion/queue';
import { createGuaranteeEvaluateHandler, runWorker } from './index.js';

const strategy: StrategyConfig = { type: 'single', model: 'mock-mid' };

let root: string;
let suitesDir: string;
let artifactsDir: string;
let db: DbHandle;
let artifacts: ArtifactStore;

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'potion-workers-'));
  suitesDir = path.join(root, 'suites');
  artifactsDir = path.join(root, 'artifacts');
  mkdirSync(suitesDir, { recursive: true });
  // 2-item suite, exact scoring — deterministic on mock providers.
  const suite = [
    { id: 'mini-1', clusterId: 'mini', prompt: [{ role: 'user', content: 'say alpha' }], reference: 'alpha', scoring: { kind: 'exact' } },
    { id: 'mini-2', clusterId: 'mini', prompt: [{ role: 'user', content: 'say beta' }], reference: 'beta', scoring: { kind: 'exact' } },
  ];
  writeFileSync(
    path.join(suitesDir, 'mini.jsonl'),
    suite.map((i) => JSON.stringify(i)).join('\n') + '\n',
  );
  db = await createDb();
  await migrate(db.db);
  artifacts = createArtifactStore('local', { dir: artifactsDir });
});

afterEach(async () => {
  await db.close();
  rmSync(root, { recursive: true, force: true });
});

async function seedStrategy(): Promise<string> {
  const hash = strategyHash(strategy);
  await db.db.insert(strategyConfigs).values({ hash, config: strategy });
  return hash;
}

describe('runWorker', () => {
  it('eval:run end-to-end: 2 items × 1 strategy persisted + artifact written', async () => {
    const hash = await seedStrategy();
    const queue = createQueue('memory');
    const worker = await runWorker({ queue, db, artifacts, suitesDir });

    const jobId = await queue.enqueue('eval:run', {
      suiteIds: ['mini'],
      strategyHashes: [hash],
      orgId: 'org-test',
    });
    await queue.close();

    const status = await queue.getJob(jobId);
    expect(status?.state).toBe('completed');
    const result = status?.result as {
      runId: string;
      executed: number;
      artifactKey: string | null;
    };
    expect(result.executed).toBe(2); // 2 items × 1 strategy
    expect(result.artifactKey).toBe(`eval/${result.runId}.json`);

    // results persisted (content-addressed eval_results cache: cacheKey PK,
    // runId/clusterId/quality/scorer — there is no status column by design)
    const rows = await db.db.select().from(evalResults);
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.runId === result.runId)).toBe(true);
    expect(rows.every((r) => r.clusterId === 'mini')).toBe(true);
    expect(rows.every((r) => typeof r.quality === 'number')).toBe(true);

    // run row recorded
    const runRows = await db.db.select().from(evalRuns);
    expect(runRows.length).toBe(1);
    expect(runRows[0]?.id).toBe(result.runId);
    expect((runRows[0]?.options as { orgId?: string }).orgId).toBe('org-test');

    // artifact JSON written via the store
    const artifactPath = path.join(artifactsDir, 'eval', `${result.runId}.json`);
    expect(existsSync(artifactPath)).toBe(true);
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as {
      runId: string;
      orgId: string;
      results: unknown[];
    };
    expect(artifact.runId).toBe(result.runId);
    expect(artifact.orgId).toBe('org-test');
    expect(artifact.results.length).toBe(2);

    await worker.close();
    void artifacts;
  });

  it('eval:run fails clearly for an unknown strategy hash', async () => {
    const queue = createQueue('memory');
    await runWorker({ queue, db, suitesDir });
    const jobId = await queue.enqueue('eval:run', {
      suiteIds: ['mini'],
      strategyHashes: ['deadbeef'],
    });
    await queue.close();
    const status = await queue.getJob(jobId);
    expect(status?.state).toBe('failed');
    expect(status?.error).toMatch(/unknown strategy hash/);
  });

  it('staleness:scan runs and reports counts', async () => {
    const queue = createQueue('memory');
    await runWorker({ queue, db, suitesDir });
    const jobId = await queue.enqueue('staleness:scan', {});
    await queue.close();
    const status = await queue.getJob(jobId);
    expect(status?.state).toBe('completed');
    const result = status?.result as {
      scanned: number;
      newlyFlagged: number;
      pricesVersionFlagged: number;
      judgeModelFlagged: number;
      modelVersionFlagged: number;
    };
    expect(result.scanned).toBe(0); // no eval results yet in this db
    expect(result.newlyFlagged).toBe(0);
  });

  it('shadow:judge stub accepts a payload and no-ops (ROADMAP #21)', async () => {
    const queue = createQueue('memory');
    await runWorker({ queue, db, suitesDir });
    const jobId = await queue.enqueue('shadow:judge', { shadowResultId: 'shadow-1' });
    await queue.close();
    const status = await queue.getJob(jobId);
    expect(status?.state).toBe('completed');
    expect(status?.result).toEqual({
      stub: true,
      shadowResultId: 'shadow-1',
      status: 'accepted',
    });
  });

  it('handlers override wins over the defaults', async () => {
    const queue = createQueue('memory');
    await runWorker({
      queue,
      db,
      suitesDir,
      handlers: {
        'shadow:judge': async (payload) => ({ custom: payload.shadowResultId }),
      },
    });
    const jobId = await queue.enqueue('shadow:judge', { shadowResultId: 's-9' });
    await queue.close();
    const status = await queue.getJob(jobId);
    expect(status?.state).toBe('completed');
    expect(status?.result).toEqual({ custom: 's-9' });
  });

  it('sweep:run runs the budget-governed loop and writes a sweep artifact', async () => {
    const queue = createQueue('memory');
    await runWorker({ queue, db, artifacts, suitesDir });
    const jobId = await queue.enqueue('sweep:run', {
      suiteIds: ['mini'],
      strategies: [strategy],
      capUsd: 1,
    });
    await queue.close();
    const status = await queue.getJob(jobId);
    expect(status?.state).toBe('completed');
    const result = status?.result as {
      outcomes: Array<{ suiteId: string; runId: string }>;
      stoppedEarly: boolean;
      totalSpendUsd: number;
      artifactKey: string | null;
    };
    expect(result.stoppedEarly).toBe(false);
    expect(result.outcomes.length).toBe(1);
    expect(result.outcomes[0]?.suiteId).toBe('mini');
    expect(result.totalSpendUsd).toBe(0); // mock providers cost $0
    expect(result.artifactKey).not.toBeNull();
    const sweepFiles = readdirSync(path.join(artifactsDir, 'sweep'));
    expect(sweepFiles.length).toBe(1);
  });
});

// ---- M3 #22 guarantee:evaluate (SPEC §12.5) ----

describe('guarantee:evaluate', () => {
  const CHEAP: StrategyConfig = { type: 'single', model: 'mock-cheap' };
  const MID: StrategyConfig = { type: 'single', model: 'mock-mid' };
  const H_CHEAP = strategyHash(CHEAP);
  const H_MID = strategyHash(MID);
  const GUARANTEE = { minQuality: 0.6, windowMin: 60, sampleRate: 1, action: 'rollback' as const };
  const POLICY: Policy = { type: 'min_cost', qualityFloor: 0, guarantee: GUARANTEE };

  function pt(config: StrategyConfig, quality: number, costPer1K: number): FrontierPoint {
    return {
      clusterId: 'code-gen',
      strategyHash: strategyHash(config),
      strategyConfig: config,
      quality,
      costPer1K,
      latencyP95: 500,
    };
  }

  async function seedFrontierChain(): Promise<void> {
    await insertFrontier(db.db, {
      id: 'fr-w-1',
      clusterId: 'code-gen',
      version: 1,
      parentId: null,
      trigger: 'manual',
      points: [pt(CHEAP, 0.5, 0.1)],
      pricesVersion: 'p',
      createdAt: '2026-08-04T00:00:00.000Z',
    });
    await insertFrontier(db.db, {
      id: 'fr-w-2',
      clusterId: 'code-gen',
      version: 2,
      parentId: 'fr-w-1',
      trigger: 'recompute',
      points: [pt(CHEAP, 0.5, 0.1), pt(MID, 0.7, 1.0)],
      pricesVersion: 'p',
      createdAt: '2026-08-04T01:00:00.000Z',
    });
  }

  it('per-sample mode: scores the served answer, inserts the sample, fires the breach + metric', async () => {
    await seedFrontierChain();
    // 4 low samples already present; the job's sample is the 5th (breach).
    for (let i = 0; i < 4; i++) {
      await insertQualitySample(db.db, { orgId: DEFAULT_ORG_ID, strategyHash: H_MID, quality: 0.1 });
    }
    const meterCalls: Array<{ orgId: string; action: string }> = [];
    const queue = createQueue('memory');
    await runWorker({
      queue,
      db,
      suitesDir,
      handlers: {
        'guarantee:evaluate': createGuaranteeEvaluateHandler({
          meter: {
            observeGuaranteeBreach(b) {
              meterCalls.push(b);
            },
          },
        }),
      },
    });
    const jobId = await queue.enqueue('guarantee:evaluate', {
      orgId: DEFAULT_ORG_ID,
      clusterId: 'code-gen',
      strategyHash: H_MID,
      policy: POLICY,
      sample: {
        requestId: 'chatcmpl-worker-1',
        promptText: 'completely disjoint vocabulary here',
        answerText: 'nothing overlapping whatsoever', // Jaccard ≈ 0 → low quality
      },
    });
    await queue.close();
    const status = await queue.getJob(jobId);
    expect(status?.state).toBe('completed');
    const result = status?.result as {
      sampleId: string | null;
      evaluations: Array<{ breach: boolean; action: string | null }>;
      breaches: Array<{ orgId: string; action: string; incidentId: string }>;
    };
    expect(result.sampleId).not.toBeNull();
    expect(result.evaluations[0]).toMatchObject({ breach: true, action: 'rollback' });
    expect(result.breaches).toHaveLength(1);
    // sample row tagged with the SERVING strategy hash
    const samples = await listQualitySamples(db.db, DEFAULT_ORG_ID);
    expect(samples).toHaveLength(5);
    expect(samples[0]!.requestId).toBe('chatcmpl-worker-1');
    expect(samples[0]!.strategyHash).toBe(H_MID);
    expect(samples[0]!.quality).toBeLessThan(0.6);
    // rollback incident → previous version's equivalent point (cheap on v1)
    const incidents = await listIncidents(db.db, DEFAULT_ORG_ID);
    expect(incidents[0]!.kind).toBe('rollback');
    expect(incidents[0]!.detail).toMatchObject({
      clusterId: 'code-gen',
      fromStrategy: H_MID,
      toStrategy: H_CHEAP,
      toFrontierVersion: 1,
    });
    // meter observed exactly one breach
    expect(meterCalls).toEqual([{ orgId: DEFAULT_ORG_ID, action: 'rollback' }]);
  });

  it('sweep mode: evaluates guarantee-carrying policies from the db', async () => {
    await seedFrontierChain();
    await insertPolicy(db.db, {
      id: 'pol-w-guarantee',
      orgId: DEFAULT_ORG_ID,
      name: 'guarantee',
      config: POLICY,
    });
    for (let i = 0; i < 5; i++) {
      await insertQualitySample(db.db, { orgId: DEFAULT_ORG_ID, strategyHash: H_MID, quality: 0.1 });
    }
    const queue = createQueue('memory');
    await runWorker({ queue, db, suitesDir });
    const jobId = await queue.enqueue('guarantee:evaluate', {}); // full sweep
    await queue.close();
    const status = await queue.getJob(jobId);
    expect(status?.state).toBe('completed');
    const result = status?.result as { sampleId: string | null; breaches: unknown[]; evaluations: unknown[] };
    expect(result.sampleId).toBeNull();
    expect(result.evaluations.length).toBeGreaterThanOrEqual(1);
    expect(result.breaches).toHaveLength(1);
    expect(await listIncidents(db.db, DEFAULT_ORG_ID)).toHaveLength(1);
  });

  it('sweep mode: insufficient evidence → no incident', async () => {
    await seedFrontierChain();
    await insertPolicy(db.db, {
      id: 'pol-w-guarantee',
      orgId: DEFAULT_ORG_ID,
      name: 'guarantee',
      config: POLICY,
    });
    await insertQualitySample(db.db, { orgId: DEFAULT_ORG_ID, strategyHash: H_MID, quality: 0.1 });
    const queue = createQueue('memory');
    await runWorker({ queue, db, suitesDir });
    const jobId = await queue.enqueue('guarantee:evaluate', {});
    await queue.close();
    expect((await queue.getJob(jobId))?.state).toBe('completed');
    expect(await listIncidents(db.db, DEFAULT_ORG_ID)).toHaveLength(0);
  });
});
