// F12 — evidence must not cross the org boundary at boot.
//
// The defect these pin: migrate() re-executed every statement of every file
// on every boot, and 0023's tenancy backfill targets four tables whose org_id
// is NULLABLE, where NULL *means platform*. So each restart MOVED platform
// evidence into a tenant's pool (deleting the platform fallback the serving
// read depends on), and once the tenant owned the same (cluster, version) the
// UPDATE collided with frontiers_org_cluster_version and migrate() THREW —
// on the boot path, so the server would not start.
import { beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, createOrg, type DbHandle } from './index.js';
import { appliedMigrations, BASELINE_THROUGH, migrate, migrateWithReport } from './migrate.js';
import { clusters, evalResults, frontiers } from './schema.js';

const CLUSTER = 'agent-abc123-slug';
let h: DbHandle;

beforeEach(async () => {
  h = await createDb();
});

/** An org-owned cluster carrying PLATFORM evidence. This state is legitimate
 * and load-bearing: repos/frontiers.ts documents the serving read as
 * org-preferred with PLATFORM FALLBACK, and share links + the public
 * leaderboard are platform-only by design. */
async function seedCrossTenantState(version = 1): Promise<void> {
  await createOrg(h.db, { id: 'org_tenant', name: 'Tenant' });
  await h.db.insert(clusters).values({
    id: CLUSTER, name: 'tenant cluster', description: 'd', orgId: 'org_tenant',
  });
  await h.db.insert(frontiers).values({
    id: `f-platform-${version}`, clusterId: CLUSTER, version, orgId: null,
    trigger: 'manual', points: [], pricesVersion: 'v1',
    createdAt: '2026-08-10T00:00:00.000Z',
  } as never);
  await h.db.insert(evalResults).values({
    cacheKey: `ck-platform-${version}`, runId: 'r1', itemId: 'i1', clusterId: CLUSTER,
    strategyHash: 'hh', strategyConfig: { type: 'single', model: 'mock-cheap' },
    quality: 0.9, scorer: 'mock', usage: {}, latencyMs: { total: 100 },
    modelVersions: {}, pricesVersion: 'v1', providerMode: 'mock',
    orgId: null, stale: false, createdAt: '2026-08-10T00:00:00.000Z',
  } as never);
}

async function attribution(): Promise<Record<string, number>> {
  const res = await h.db.execute(sql.raw(`
    SELECT (SELECT count(*)::int FROM frontiers WHERE org_id IS NULL) AS plat_f,
           (SELECT count(*)::int FROM frontiers WHERE org_id = 'org_tenant') AS ten_f,
           (SELECT count(*)::int FROM eval_results WHERE org_id IS NULL) AS plat_e,
           (SELECT count(*)::int FROM eval_results WHERE org_id = 'org_tenant') AS ten_e`));
  return (res as unknown as { rows: Record<string, number>[] }).rows[0]!;
}

describe('F12: a reboot never re-attributes evidence', () => {
  it('THE REGRESSION: platform evidence on an org-owned cluster survives a reboot untouched', async () => {
    await migrate(h.db);
    await seedCrossTenantState();
    const before = await attribution();
    expect(before).toMatchObject({ plat_f: 1, ten_f: 0, plat_e: 1, ten_e: 0 });

    await migrate(h.db); // reboot
    await migrate(h.db); // and again, for good measure

    // Before the ledger this read {plat_f:0, ten_f:1, plat_e:0, ten_e:1} —
    // the evidence was MOVED, not copied.
    expect(await attribution()).toEqual(before);
  }, 120_000);

  it('THE OUTAGE: the collision state that used to throw now boots clean', async () => {
    await migrate(h.db);
    await seedCrossTenantState(1);
    // The tenant owns its own frontier at the same (cluster, version) — the
    // natural result of the tenant recomputing while a platform v1 exists.
    await h.db.insert(frontiers).values({
      id: 'f-tenant-1', clusterId: CLUSTER, version: 1, orgId: 'org_tenant',
      trigger: 'recompute', points: [], pricesVersion: 'v1',
      createdAt: '2026-08-10T01:00:00.000Z',
    } as never);

    // Previously: 'Failed query: UPDATE frontiers SET org_id = c.org_id' —
    // a unique-index violation thrown on the boot path.
    await expect(migrate(h.db)).resolves.toBeTruthy();
    expect(await attribution()).toMatchObject({ plat_f: 1, ten_f: 1 });
  }, 120_000);

  it('a migration executes exactly once, and re-running executes nothing', async () => {
    const first = await migrateWithReport(h.db);
    expect(first.executed.length).toBeGreaterThan(0);
    expect(first.baselined).toEqual([]); // fresh db is not baselined

    const second = await migrateWithReport(h.db);
    expect(second.executed).toEqual([]);
    expect(second.applied).toEqual(first.applied);
    // Back-compat: migrate() still reports the full applied set, not a delta.
    await expect(migrate(h.db)).resolves.toContain('0000_init.sql');
  }, 120_000);
});

describe('F12: baselining a database that predates the ledger', () => {
  it('THE UPGRADE BOOT: marks the historical prefix applied WITHOUT executing it', async () => {
    // Simulate a pre-ledger database: schema present, ledger empty.
    await migrate(h.db);
    await seedCrossTenantState();
    await h.db.execute(sql.raw('DELETE FROM schema_migrations'));
    const before = await attribution();

    const report = await migrateWithReport(h.db);

    // 0000..0032 are accepted as already-applied on faith (they were), and
    // crucially NOT run — otherwise the very boot that installs the fix
    // performs one last re-attribution on its way in.
    expect(report.baselined).toContain('0000_init.sql');
    expect(report.baselined).toContain(BASELINE_THROUGH);
    expect(report.baselined).not.toContain('0033_evidence_attribution_repair.sql');
    expect(report.executed).not.toContain('0023_org_frontiers.sql');
    expect(await attribution()).toEqual(before);
  }, 120_000);

  it('a FRESH database runs everything and baselines nothing', async () => {
    const report = await migrateWithReport(h.db);
    expect(report.baselined).toEqual([]);
    expect(report.executed).toContain('0000_init.sql');
    expect(report.executed).toContain('0023_org_frontiers.sql');
    expect(await appliedMigrations(h.db)).toContain(BASELINE_THROUGH);
  }, 120_000);
});

describe('F12 repair (0033): only the provable subset is touched', () => {
  const DIR = new URL('../drizzle', import.meta.url).pathname;

  /** Apply history up to (and including) `through`, leaving 0033 unrun so the
   * damaged state can be staged the way a re-attributed database really is. */
  async function applyThrough(through: string): Promise<void> {
    const { readFileSync } = await import('node:fs');
    const { listMigrationFiles, splitStatements } = await import('./migrate.js');
    for (const file of listMigrationFiles(DIR)) {
      if (file > through) continue;
      for (const s of splitStatements(readFileSync(`${DIR}/${file}`, 'utf8'))) {
        await h.db.execute(sql.raw(s));
      }
    }
  }

  async function runRepair(): Promise<void> {
    const { readFileSync } = await import('node:fs');
    const { splitStatements } = await import('./migrate.js');
    for (const s of splitStatements(
      readFileSync(`${DIR}/0033_evidence_attribution_repair.sql`, 'utf8'),
    )) {
      await h.db.execute(sql.raw(s));
    }
  }

  it('resets what is provably impossible and leaves what is merely suspicious', async () => {
    await applyThrough(BASELINE_THROUGH);
    // RAW insert, not createOrg: this test deliberately stages a PARTIAL
    // migration history (through 0032), so the orgs table here is missing
    // every column later migrations add — while the ORM's insert names all
    // of them. Anything else makes this test fail on the next orgs column
    // for a reason that has nothing to do with the F12 repair it exercises.
    await h.db.execute(sql.raw("INSERT INTO orgs (id, name) VALUES ('org_tenant', 'Tenant')"));
    await h.db.insert(clusters).values({
      id: CLUSTER, name: 'c', description: 'd', orgId: 'org_tenant',
    });
    // (a) PROVABLE: attributed to the org but created BEFORE the org existed.
    //     The org did not exist, so this cannot be its evidence. 0023 only
    //     ever moved rows that were NULL, so NULL is where it belongs.
    await h.db.execute(sql.raw(`INSERT INTO frontiers (id, cluster_id, version, org_id, trigger, points, prices_version, created_at) VALUES ('f-stolen', '${CLUSTER}', 1, 'org_tenant', 'manual', '[]', 'v1', '2020-01-01T00:00:00.000Z')`)); // raw: this db is at BASELINE_THROUGH, before 0047's instrument column
    // (b) AMBIGUOUS: created after the org. Indistinguishable from evidence
    //     the tenant legitimately generated. Must NOT be guessed at.
    await h.db.execute(sql.raw(`INSERT INTO frontiers (id, cluster_id, version, org_id, trigger, points, prices_version, created_at) VALUES ('f-genuine', '${CLUSTER}', 2, 'org_tenant', 'recompute', '[]', 'v1', '2099-01-01T00:00:00.000Z')`)); // raw: this db is at BASELINE_THROUGH, before 0047's instrument column

    await runRepair();

    const rows = await h.db.execute(sql.raw(
      "SELECT id, org_id FROM frontiers WHERE id IN ('f-stolen','f-genuine') ORDER BY id"));
    expect((rows as unknown as { rows: Array<Record<string, unknown>> }).rows).toEqual([
      { id: 'f-genuine', org_id: 'org_tenant' }, // untouched
      { id: 'f-stolen', org_id: null },          // returned to platform
    ]);

    const audit = await h.db.execute(sql.raw(
      'SELECT row_key, disposition FROM evidence_attribution_audit ORDER BY row_key'));
    expect((audit as unknown as { rows: Array<Record<string, unknown>> }).rows).toEqual([
      { row_key: 'f-genuine', disposition: 'ambiguous-review' },
      { row_key: 'f-stolen', disposition: 'reset-to-platform' },
    ]);
  }, 120_000);

  it('a database that was never damaged is left completely alone', async () => {
    await applyThrough(BASELINE_THROUGH);
    await migrate(h.db); // includes 0033
    await seedCrossTenantState();
    const before = await attribution();
    await migrate(h.db);
    expect(await attribution()).toEqual(before);
    const audit = await h.db.execute(sql.raw(
      'SELECT count(*)::int AS n FROM evidence_attribution_audit'));
    expect((audit as unknown as { rows: Array<{ n: number }> }).rows[0]!.n).toBe(0);
  }, 120_000);
});
