// Versioned-persistence round-trip tests on PGlite (zero services).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FrontierPoint } from '@potion/core';
import { createDb, frontierPoints, frontiers, migrate, type DbHandle } from '@potion/db';
import { eq } from 'drizzle-orm';
import { loadCurrentFrontier, loadFrontier, saveFrontier } from './persistence.js';

const P1: FrontierPoint = {
  clusterId: 'code-gen',
  strategyHash: 'h-cheap',
  strategyConfig: { type: 'single', model: 'mock-cheap' },
  quality: 0.55,
  costPer1K: 0.2,
  latencyP95: 300,
};
const P2: FrontierPoint = {
  clusterId: 'code-gen',
  strategyHash: 'h-frontier',
  strategyConfig: { type: 'single', model: 'mock-frontier' },
  quality: 0.95,
  costPer1K: 6,
  latencyP95: 1800,
};

describe('frontier persistence (PGlite)', () => {
  let handle: DbHandle;
  beforeAll(async () => {
    handle = await createDb('pglite://');
    await migrate(handle.db);
  });
  afterAll(async () => {
    await handle.close();
  });

  it('first save → v1 with parentId null; round-trips points', async () => {
    const saved = await saveFrontier(handle.db, 'code-gen', [P1, P2], 'manual', 'pv-1');
    expect(saved.version).toBe(1);
    expect(saved.parentId).toBeNull();
    expect(saved.trigger).toBe('manual');

    const loaded = await loadCurrentFrontier(handle.db, 'code-gen');
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(saved.id);
    expect(loaded!.version).toBe(1);
    expect(loaded!.pricesVersion).toBe('pv-1');
    expect(loaded!.points).toEqual([P1, P2]);

    const byId = await loadFrontier(handle.db, saved.id);
    expect(byId).toEqual(loaded);

    // frontier_points rows were written too (one per point, FK-linked).
    const rows = await handle.db
      .select()
      .from(frontierPoints)
      .where(eq(frontierPoints.frontierId, saved.id));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.strategyHash).sort()).toEqual(['h-cheap', 'h-frontier']);
  });

  it('second save → v2 chained to v1 (version = max + 1, parentId = previous id)', async () => {
    const v1 = await loadCurrentFrontier(handle.db, 'code-gen');
    const saved = await saveFrontier(handle.db, 'code-gen', [P2], 'new-model', 'pv-2');
    expect(saved.version).toBe(2);
    expect(saved.parentId).toBe(v1!.id);
    expect(saved.trigger).toBe('new-model');

    const current = await loadCurrentFrontier(handle.db, 'code-gen');
    expect(current!.version).toBe(2);
    expect(current!.points).toEqual([P2]);

    // v1 still loadable by id (history retained).
    const old = await loadFrontier(handle.db, v1!.id);
    expect(old!.version).toBe(1);
    expect(old!.points).toEqual([P1, P2]);
  });

  it('versions chain independently per cluster', async () => {
    const other = await saveFrontier(handle.db, 'extraction', [P1], 'manual', 'pv-1');
    expect(other.version).toBe(1); // unaffected by code-gen's v1/v2
    const codeGen = await loadCurrentFrontier(handle.db, 'code-gen');
    expect(codeGen!.version).toBe(2);
  });

  it('loadCurrentFrontier / loadFrontier return null when absent', async () => {
    expect(await loadCurrentFrontier(handle.db, 'summarization')).toBeNull();
    expect(await loadFrontier(handle.db, 'fr-does-not-exist')).toBeNull();
  });

  it('empty-points frontier round-trips (zero frontier_points rows)', async () => {
    const saved = await saveFrontier(handle.db, 'creative', [], 'recompute', 'pv-3');
    const loaded = await loadCurrentFrontier(handle.db, 'creative');
    expect(loaded!.points).toEqual([]);
    const count = await handle.db
      .select()
      .from(frontiers)
      .where(eq(frontiers.id, saved.id));
    expect(count).toHaveLength(1);
  });
});
