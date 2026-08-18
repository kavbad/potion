// THE MODEL REGISTRY IN THE DATABASE (SERVING-ROADMAP S5).
//
// The property under test is SURVIVAL. prices.json was the registry and
// research:scan grew it with writeFileSync — so every discovered model died
// on the next redeploy (the file ships inside the container image) and never
// reached the running process anyway (loadPrices runs once at boot). A
// catalog that cannot outlive a restart is a build artifact, not a catalog.
//
// The load-bearing test is therefore the one that simulates a redeploy: seed,
// discover, seed again from the ORIGINAL committed file, and assert the
// discovery is still there. That is the exact motion that used to lose data.
import { describe, expect, it } from 'vitest';
import { createDb, migrate } from './index.js';
import {
  addScannedModels,
  countModels,
  listModelCatalog,
  loadModelRegistry,
  seedModelRegistry,
  type RegistryTable,
} from './repos/model-registry.js';

const SEED: RegistryTable = {
  version: '2026-08-04',
  updatedAt: '2026-08-04T00:00:00.000Z',
  entries: [
    { alias: 'or-deepseek', provider: 'openrouter', model: 'deepseek/deepseek-chat-v3.1', inputPer1M: 0.25, outputPer1M: 0.95 },
    { alias: 'or-opus', provider: 'openrouter', model: 'anthropic/claude-opus-4.5', inputPer1M: 5, outputPer1M: 25 },
  ],
};

async function fresh() {
  const h = await createDb();
  await migrate(h.db);
  return h;
}

describe('seeding from the committed price table', () => {
  it('fills an empty registry and reports what it inserted', async () => {
    const h = await fresh();
    const r = await seedModelRegistry(h.db, SEED);
    expect(r.inserted.sort()).toEqual(['or-deepseek', 'or-opus']);
    expect(r.skipped).toEqual([]);
    expect(await countModels(h.db)).toBe(2);
    await h.close();
  }, 60_000);

  it('is IDEMPOTENT — a second seed inserts nothing', async () => {
    const h = await fresh();
    await seedModelRegistry(h.db, SEED);
    const again = await seedModelRegistry(h.db, SEED);
    expect(again.inserted).toEqual([]);
    expect(again.skipped.length).toBe(2);
    expect(await countModels(h.db)).toBe(2);
    await h.close();
  }, 60_000);

  it('SURVIVES A REDEPLOY: a scanned model outlives re-seeding from the old file', async () => {
    // This is the bug, in three lines. Boot, discover, boot again from the
    // committed file — and the discovery must still be there. Under the old
    // file-based registry the redeploy overwrote it with the image's copy.
    const h = await fresh();
    await seedModelRegistry(h.db, SEED);
    await addScannedModels(
      h.db,
      [{ alias: 'or-newcomer', provider: 'openrouter', model: 'vendor/brand-new', inputPer1M: 0.1, outputPer1M: 0.4 }],
      '2026-08-18',
    );

    await seedModelRegistry(h.db, SEED); // the redeploy

    const registry = (await loadModelRegistry(h.db))!;
    expect(registry.entries.map((e) => e.alias)).toContain('or-newcomer');
    expect(registry.entries.length).toBe(3);
    await h.close();
  }, 60_000);

  it('NEVER clobbers a live entry with the committed file version', async () => {
    // A redeploy must not silently revert prices the catalog has moved on
    // from — that reintroduces the very bug this replaces.
    const h = await fresh();
    await seedModelRegistry(h.db, SEED);
    await addScannedModels(
      h.db,
      [{ alias: 'or-deepseek', provider: 'openrouter', model: 'deepseek/deepseek-chat-v3.1', inputPer1M: 99, outputPer1M: 99 }],
      'x',
    );
    await seedModelRegistry(h.db, SEED);
    const row = (await listModelCatalog(h.db)).find((r) => r.alias === 'or-deepseek')!;
    expect(row.inputPer1M).toBe(0.25); // the ORIGINAL, untouched by either write
    await h.close();
  }, 60_000);
});

describe('the registry version keys eval cache cells, so it must move exactly right', () => {
  it('carries the seed file version VERBATIM — not a re-derived hash', async () => {
    // A content hash would have changed on the first boot after this
    // migration and invalidated the Step 5 campaign's paid-for evidence.
    const h = await fresh();
    await seedModelRegistry(h.db, SEED);
    expect((await loadModelRegistry(h.db))!.version).toBe('2026-08-04');
    await h.close();
  }, 60_000);

  it('moves when a scan adds something, and only then', async () => {
    const h = await fresh();
    await seedModelRegistry(h.db, SEED);
    const before = (await loadModelRegistry(h.db))!.version;

    await addScannedModels(h.db, [], 'unused-because-nothing-was-added');
    expect((await loadModelRegistry(h.db))!.version).toBe(before);

    await addScannedModels(
      h.db,
      [{ alias: 'or-fresh', provider: 'openrouter', model: 'v/m', inputPer1M: 1, outputPer1M: 2 }],
      '2026-09-01',
    );
    expect((await loadModelRegistry(h.db))!.version).toBe('2026-09-01');
    await h.close();
  }, 60_000);
});

describe('loading', () => {
  it('returns NULL for an empty registry, not an empty table', async () => {
    // An empty table is indistinguishable from a broken read, and a caller
    // that served one would resolve no models at all. Null makes the boot
    // path fall back to the file, which is the honest recovery.
    const h = await fresh();
    expect(await loadModelRegistry(h.db)).toBeNull();
    await h.close();
  }, 60_000);

  it('records the ORIGIN of every row, so a scan can be told from the baseline', async () => {
    const h = await fresh();
    await seedModelRegistry(h.db, SEED);
    await addScannedModels(
      h.db,
      [{ alias: 'or-found', provider: 'openrouter', model: 'v/m', inputPer1M: 1, outputPer1M: 2, supportsTools: true, contextLength: 128000 }],
      'v2',
    );
    const rows = await listModelCatalog(h.db);
    expect(rows.find((r) => r.alias === 'or-deepseek')!.source).toBe('seed');
    const found = rows.find((r) => r.alias === 'or-found')!;
    expect(found.source).toBe('scan');
    // …and the catalog facts a price table has nowhere to put.
    expect(found.supportsTools).toBe(true);
    expect(found.contextLength).toBe(128000);
    // Absent stays ABSENT — never a fabricated default that would silently
    // truncate a prompt or route a tool call to a model that cannot take one.
    expect(rows.find((r) => r.alias === 'or-opus')!.contextLength).toBeNull();
    expect(rows.find((r) => r.alias === 'or-opus')!.supportsTools).toBeNull();
    await h.close();
  }, 60_000);
});
