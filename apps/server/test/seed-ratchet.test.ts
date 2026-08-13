// Lab Step 5: the platform-scope seed ratchet — the demo seed's mock
// platform frontiers must never supersede a LIVE-evidenced platform
// frontier (the G1.7 "mock never clobbers live" taint rule, extended to the
// seed path the moment platform live evidence became possible). Found by
// the Step 5 pre-spend review: the first server boot against the durable
// sweep database would otherwise have buried every paid frontier under a
// fresh mock version.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createDb, migrate, type DbHandle } from '@potion/db';
import { loadCurrentFrontier, saveFrontier } from '@potion/pareto';
import type { FrontierPoint } from '@potion/core';
import { buildServer } from '../src/server.js';

let h: DbHandle;
let app: FastifyInstance;
let liveFrontierId: string;

const LIVE_POINT: FrontierPoint = {
  clusterId: 'code-gen',
  strategyHash: 'live-sweep-hash-1',
  strategyConfig: { type: 'single', model: 'or-opus' },
  quality: 0.91,
  costPer1K: 0.012,
  latencyP95: 900,
  providerMode: 'live',
  evidence: { cacheKeys: ['ck1'], runIds: ['run-live-1'], n: 15, qualityCi95: 0.03 },
};

beforeAll(async () => {
  h = await createDb();
  await migrate(h.db);
  // A paid platform frontier exists BEFORE the first seeding boot — the
  // post-Step-5 durable-db situation.
  const saved = await saveFrontier(h.db, 'code-gen', [LIVE_POINT], 'recompute', 'test-pv');
  liveFrontierId = saved.id;
  app = await buildServer({ db: h, seed: true });
}, 120_000);

afterAll(async () => {
  await app.close();
  await h.close();
});

describe('seed ratchet: mock never clobbers live at platform scope', () => {
  it('the live platform frontier is still latest after a seeding boot', async () => {
    const current = await loadCurrentFrontier(h.db, 'code-gen');
    expect(current).not.toBeNull();
    expect(current!.id).toBe(liveFrontierId);
    expect(current!.points.every((p) => p.providerMode === 'live')).toBe(true);
  });

  it('clusters WITHOUT live evidence still seed normally (the guard is per-cluster)', async () => {
    const extraction = await loadCurrentFrontier(h.db, 'extraction');
    expect(extraction).not.toBeNull();
    expect(extraction!.points.length).toBeGreaterThan(0);
    expect(extraction!.points.every((p) => p.providerMode === 'mock')).toBe(true);
  });
});
