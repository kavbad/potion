// Research repo tests (M4b, ROADMAP #37, SPEC §15.6) — PGlite, zero services.
// Covers: cycle insert/update/list/spend-total, recipe_status upsert
// semantics (firstCycleId sticky, updatedAt moves), migration 0014
// idempotency, and the trigger/status CHECK constraints.
import { describe, expect, it } from 'vitest';
import {
  createDb,
  getRecipeStatusByHashes,
  getResearchCycle,
  insertResearchCycle,
  listRecipeStatusByStatus,
  listResearchCycles,
  migrate,
  researchSpendTotalUsd,
  updateResearchCycle,
  upsertRecipeStatus,
  type DbHandle,
} from './index.js';

async function migratedDb(): Promise<DbHandle> {
  const handle = await createDb(); // PGlite: zero services
  await migrate(handle.db);
  return handle;
}

describe('research_cycles repo (M4b #37)', () => {
  it('insert → get → update lifecycle (queued → completed) with spend + seed', async () => {
    const h = await migratedDb();
    const cycle = await insertResearchCycle(h.db, {
      trigger: 'scan',
      focusAlias: 'or-fable-5',
      candidates: [{ type: 'single', model: 'or-fable-5' }],
      seed: 42,
    });
    expect(cycle.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(cycle.status).toBe('queued');
    expect(cycle.spendUsd).toBe(0);
    expect(cycle.provenance).toBe('unknown');
    expect(cycle.seed).toBe(42);

    const running = await updateResearchCycle(h.db, cycle.id, { status: 'running' });
    expect(running?.status).toBe('running');

    const done = await updateResearchCycle(h.db, cycle.id, {
      status: 'completed',
      spendUsd: 1.25,
      provenance: 'mock',
      completedAt: new Date(),
    });
    expect(done?.spendUsd).toBe(1.25);
    expect(done?.provenance).toBe('mock');
    expect(done?.completedAt).not.toBeNull();

    const fetched = await getResearchCycle(h.db, cycle.id);
    expect(fetched?.focusAlias).toBe('or-fable-5');
    expect((fetched?.candidates as unknown[]).length).toBe(1);

    // Unknown id → null (crash-consistency contract).
    expect(await updateResearchCycle(h.db, crypto.randomUUID(), { status: 'failed' })).toBeNull();
    await h.close();
  });

  it('listResearchCycles is newest-first; spend total sums every cycle', async () => {
    const h = await migratedDb();
    const a = await insertResearchCycle(h.db, { trigger: 'schedule' });
    const b = await insertResearchCycle(h.db, { trigger: 'manual' });
    await updateResearchCycle(h.db, a.id, { spendUsd: 2 });
    await updateResearchCycle(h.db, b.id, { spendUsd: 3.5 });
    const list = await listResearchCycles(h.db);
    expect(list.length).toBe(2);
    expect(new Date(list[0]!.createdAt).getTime()).toBeGreaterThanOrEqual(
      new Date(list[1]!.createdAt).getTime(),
    );
    expect(await researchSpendTotalUsd(h.db)).toBeCloseTo(5.5, 10);
    await h.close();
  });

  it('rejects out-of-vocabulary trigger and status (CHECK constraints)', async () => {
    const h = await migratedDb();
    await expect(
      insertResearchCycle(h.db, { trigger: 'nightly' as never }),
    ).rejects.toThrow();
    await h.close();
  });
});

describe('recipe_status repo (M4b #37)', () => {
  it('upsert inserts then updates; firstCycleId is sticky', async () => {
    const h = await migratedDb();
    const c1 = await insertResearchCycle(h.db, { trigger: 'manual' });
    const c2 = await insertResearchCycle(h.db, { trigger: 'manual' });

    await upsertRecipeStatus(h.db, 'hash-a', 'candidate', c1.id);
    let map = await getRecipeStatusByHashes(h.db, ['hash-a']);
    expect(map.get('hash-a')?.status).toBe('candidate');
    expect(map.get('hash-a')?.firstCycleId).toBe(c1.id);

    // Promote in a later cycle: status moves, firstCycleId stays c1.
    await upsertRecipeStatus(h.db, 'hash-a', 'frontier', c2.id);
    map = await getRecipeStatusByHashes(h.db, ['hash-a']);
    expect(map.get('hash-a')?.status).toBe('frontier');
    expect(map.get('hash-a')?.firstCycleId).toBe(c1.id);

    const frontier = await listRecipeStatusByStatus(h.db, 'frontier');
    expect(frontier.map((r) => r.strategyHash)).toEqual(['hash-a']);
    await h.close();
  });

  it('missing hashes are absent from the map (implicit candidate)', async () => {
    const h = await migratedDb();
    const map = await getRecipeStatusByHashes(h.db, ['never-seen']);
    expect(map.size).toBe(0);
    expect(await getRecipeStatusByHashes(h.db, [])).toEqual(new Map());
    await h.close();
  });
});

describe('migration 0014_research', () => {
  it('is idempotent (double migrate does not throw)', async () => {
    const h = await createDb();
    await migrate(h.db);
    await expect(migrate(h.db)).resolves.toContain('0014_research.sql');
    await h.close();
  });
});
