// The platform frontier baseline — measured routing on day zero.
//
// What these pin is a property, not a happy path: a freshly migrated database
// must end up with LIVE-provenance platform frontiers, because without them
// `guardFrontierProvenance` discards the mock seed under a live server and
// every request from every org rides the default strategy. The import is a
// data write that runs on every boot, so its safety rules (never clobber,
// never downgrade, idempotent) carry the same weight as the F12 ledger's.
import { describe, expect, it } from 'vitest';
import { createDb, migrate } from './index.js';
import {
  baselineFrontierId,
  importPlatformBaseline,
  loadPlatformBaseline,
  type PlatformBaseline,
} from './repos/platform-baseline.js';
import { frontierPoints, frontiers } from './schema.js';

function baselineOf(clusterId: string, providerMode = 'live'): PlatformBaseline {
  return {
    source: 'test',
    capturedFrom: 'test',
    capturedAt: '2026-08-16',
    providerMode,
    note: 'test',
    frontiers: [
      {
        frontier: {
          id: `fr-${clusterId}`,
          cluster_id: clusterId,
          version: 1,
          parent_id: null,
          trigger: 'manual',
          points: [],
          org_id: null,
          prices_version: 'test-v1',
          created_at: '2026-08-12T00:00:00.000Z',
        },
        points: [
          {
            cluster_id: clusterId,
            strategy_hash: 'abc123',
            strategy_config: { type: 'single', model: 'or-deepseek' },
            quality: 0.9,
            cost_per_1k: 1.5,
            latency_p95: 900,
            evidence: { n: 20 },
            provider_mode: providerMode,
          },
        ],
      },
    ],
  };
}

describe('platform baseline import', () => {
  it('the COMMITTED baseline covers the taxonomy and is entirely live-provenance', () => {
    const baseline = loadPlatformBaseline();
    expect(baseline, 'the committed baseline must be loadable from disk').not.toBeNull();
    expect(baseline!.frontiers.length).toBe(10); // the full cluster taxonomy
    const points = baseline!.frontiers.flatMap((f) => f.points);
    expect(points.length).toBeGreaterThan(20);
    // Not one mock point may ride in — the whole value is that this is
    // measured evidence, so a single mock row would make it a lie.
    expect(points.every((p) => p.provider_mode === 'live')).toBe(true);
    // And it carries its own provenance, so the origin is legible.
    expect(baseline!.source).toMatch(/Step 5/);
  });

  it('a fresh database gets live platform frontiers for every baseline cluster', async () => {
    const h = await createDb();
    await migrate(h.db);
    const baseline = loadPlatformBaseline()!;
    const report = await importPlatformBaseline(h.db, baseline);

    expect(report.imported.length).toBe(10);
    expect(report.skippedExisting).toEqual([]);
    expect(report.refusedNotLive).toEqual([]);

    const rows = await h.db.select().from(frontierPoints);
    expect(rows.length).toBe(report.pointsImported);
    expect(rows.every((r) => r.providerMode === 'live')).toBe(true);
    expect(rows.every((r) => r.orgId === null)).toBe(true); // platform scope
    await h.close();
  }, 60_000);

  it('is IDEMPOTENT — a second import writes nothing (the F12 lesson)', async () => {
    const h = await createDb();
    await migrate(h.db);
    const baseline = loadPlatformBaseline()!;
    const first = await importPlatformBaseline(h.db, baseline);
    const before = (await h.db.select().from(frontierPoints)).length;

    const second = await importPlatformBaseline(h.db, baseline);
    expect(second.imported).toEqual([]);
    expect(second.skippedExisting.length).toBe(first.imported.length);
    expect(second.pointsImported).toBe(0);
    expect((await h.db.select().from(frontierPoints)).length).toBe(before);
    await h.close();
  }, 60_000);

  it('NEVER clobbers an existing platform frontier, whatever its provenance', async () => {
    const h = await createDb();
    await migrate(h.db);
    // An operator's own sweep landed first — even a mock one wins.
    await h.db.insert(frontiers).values({
      id: 'fr-operator-owned',
      clusterId: 'code-gen',
      version: 7,
      parentId: null,
      trigger: 'manual',
      points: [] as never,
      orgId: null,
      pricesVersion: 'operator',
      createdAt: '2026-08-16T00:00:00.000Z',
    });

    const report = await importPlatformBaseline(h.db, baselineOf('code-gen'));
    expect(report.imported).toEqual([]);
    expect(report.skippedExisting).toEqual(['code-gen']);

    const kept = await h.db.select().from(frontiers);
    expect(kept.length).toBe(1);
    expect(kept[0]!.id).toBe('fr-operator-owned'); // untouched
    expect(kept[0]!.version).toBe(7);
    await h.close();
  }, 60_000);

  it('REFUSES a baseline row that is not live-provenance (never downgrade)', async () => {
    const h = await createDb();
    await migrate(h.db);
    const report = await importPlatformBaseline(h.db, baselineOf('summarization', 'mock'));
    expect(report.refusedNotLive).toEqual(['summarization']);
    expect(report.imported).toEqual([]);
    expect((await h.db.select().from(frontiers)).length).toBe(0);
    await h.close();
  }, 60_000);

  it('imported rows are labelled platform-baseline, so the origin is legible in SQL', async () => {
    const h = await createDb();
    await migrate(h.db);
    await importPlatformBaseline(h.db, baselineOf('creative'));
    const rows = await h.db.select().from(frontiers);
    expect(rows[0]!.trigger).toBe('platform-baseline');
    expect(rows[0]!.id).toBe(baselineFrontierId('creative'));
    await h.close();
  }, 60_000);
});
