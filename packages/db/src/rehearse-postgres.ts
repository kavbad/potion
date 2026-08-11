// Deployment rehearsal against REAL PostgreSQL (node-postgres), not PGlite.
//
//   DATABASE_URL=postgres://... pnpm --filter @potion/db rehearse-postgres
//
// Why this exists: every migration in this repo had only ever executed on
// PGlite — row 5 of docs/driver-semantics.md. That included the F12 ledger,
// its baselining probe, transaction-per-migration, and the 0033 repair, all
// written the same day they first met a real database. This script is the
// meeting, and it is re-runnable against the production database as the
// deploy runbook's preflight.
//
// It is DESTRUCTIVE: it seeds and deletes orgs and briefly writes a throwaway
// migration file. Point it at a scratch database, never at one holding
// customer evidence.
import { appendFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { createDb, type DbHandle } from './db.js';
import { appliedMigrations, BASELINE_THROUGH, listMigrationFiles, migrateWithReport } from './migrate.js';
import { createOrg } from './repos/orgs.js';
import { deleteOrgCascade } from './repos/org-delete.js';
import { clusters, evalResults, frontiers, requestLogs } from './schema.js';

const DIR = fileURLToPath(new URL('../drizzle', import.meta.url));
const results: Array<{ step: string; ok: boolean; detail: string }> = [];

function record(step: string, ok: boolean, detail: string): void {
  results.push({ step, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}\n      ${detail}`);
}

async function rows<T>(h: DbHandle, q: string): Promise<T[]> {
  const res = await h.db.execute(sql.raw(q));
  return (res as unknown as { rows: T[] }).rows;
}

async function reset(h: DbHandle): Promise<void> {
  await h.db.execute(sql.raw('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'));
  await h.db.execute(sql.raw('CREATE EXTENSION IF NOT EXISTS vector;'));
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url || url.startsWith('pglite')) {
    throw new Error('DATABASE_URL must point at a real PostgreSQL instance');
  }
  const h = await createDb(url);
  if (h.driver !== 'node-postgres') throw new Error(`expected node-postgres, got ${h.driver}`);

  // ---- 0. Preflight: the two hard requirements the deploy runbook states.
  const verRows = await rows<{ v: string }>(h, 'SELECT current_setting($$server_version_num$$) AS v');
  const v = verRows[0]?.v ?? '0';
  const major = Math.floor(Number(v) / 10000);
  record(
    '0. preflight: PostgreSQL >= 15 (0023 uses NULLS NOT DISTINCT)',
    major >= 15,
    `server_version_num=${v} (major ${major})`,
  );
  const ext = await rows<{ extversion: string }>(
    h, "SELECT extversion FROM pg_extension WHERE extname = 'vector'");
  record(
    '0. preflight: pgvector present (0000_init does CREATE EXTENSION vector)',
    ext.length > 0,
    ext.length > 0 ? `vector v${ext[0]!.extversion}` : 'MISSING — first boot would fail',
  );

  // ---- 1. THE FIRST REAL MIGRATION RUN.
  await reset(h);
  const all = listMigrationFiles(DIR);
  const first = await migrateWithReport(h.db);
  record(
    '1. first boot: every migration applies on node-postgres (never run outside PGlite before)',
    first.executed.length === all.length && first.baselined.length === 0,
    `executed ${first.executed.length}/${all.length}, baselined ${first.baselined.length}`,
  );

  // ---- 2. Applied-once.
  const second = await migrateWithReport(h.db);
  record(
    '2. second boot: executes nothing (the F12 ledger, on the real driver)',
    second.executed.length === 0 && second.applied.length === all.length,
    `executed ${second.executed.length}, ledger holds ${second.applied.length}`,
  );

  // ---- 3. Attribution invariance: the F12 property itself.
  await createOrg(h.db, { id: 'org_rehearsal', name: 'Rehearsal' });
  await h.db.insert(clusters).values({
    id: 'agent-rehearse-1', name: 'c', description: 'd', orgId: 'org_rehearsal',
  });
  await h.db.insert(frontiers).values({
    id: 'f-plat-1', clusterId: 'agent-rehearse-1', version: 1, orgId: null,
    trigger: 'manual', points: [], pricesVersion: 'v1', createdAt: '2026-08-10T00:00:00.000Z',
  } as never);
  await h.db.insert(evalResults).values({
    cacheKey: 'ck-plat-1', runId: 'r1', itemId: 'i1', clusterId: 'agent-rehearse-1',
    strategyHash: 'hh', strategyConfig: { type: 'single', model: 'mock-cheap' },
    quality: 0.9, scorer: 'mock', usage: {}, latencyMs: { total: 100 }, modelVersions: {},
    pricesVersion: 'v1', providerMode: 'mock', orgId: null, stale: false,
    createdAt: '2026-08-10T00:00:00.000Z',
  } as never);
  const attr = async (): Promise<string> =>
    JSON.stringify((await rows<Record<string, number>>(h, `
      SELECT (SELECT count(*)::int FROM frontiers WHERE org_id IS NULL) AS pf,
             (SELECT count(*)::int FROM frontiers WHERE org_id='org_rehearsal') AS tf,
             (SELECT count(*)::int FROM eval_results WHERE org_id IS NULL) AS pe,
             (SELECT count(*)::int FROM eval_results WHERE org_id='org_rehearsal') AS te`))[0]);
  const beforeAttr = await attr();
  await migrateWithReport(h.db);
  await migrateWithReport(h.db);
  const afterAttr = await attr();
  record(
    '3. platform evidence survives two reboots (F12, on real Postgres)',
    beforeAttr === afterAttr,
    `before ${beforeAttr} after ${afterAttr}`,
  );

  // ---- 4. Baseline rehearsal: the exact path a production upgrade takes.
  await h.db.execute(sql.raw('DELETE FROM schema_migrations'));
  const upgraded = await migrateWithReport(h.db);
  const baselinedPrefix =
    upgraded.baselined.includes('0000_init.sql') &&
    upgraded.baselined.includes(BASELINE_THROUGH) &&
    !upgraded.executed.includes('0023_org_frontiers.sql');
  record(
    '4. upgrade boot: historical prefix baselined WITHOUT executing (no last re-attribution)',
    baselinedPrefix && (await attr()) === beforeAttr,
    `baselined ${upgraded.baselined.length}, executed ${JSON.stringify(upgraded.executed)}, attribution ${await attr()}`,
  );

  // ---- 5. F17: the >500-row chunked erasure, unprovable on PGlite.
  await createOrg(h.db, { id: 'org_erase', name: 'Erase Me' });
  const N = 1200;
  for (let i = 0; i < N; i += 200) {
    await h.db.insert(requestLogs).values(
      Array.from({ length: 200 }, (_, k) => ({
        orgId: 'org_erase', route: '/v1/chat/completions', model: 'mock-cheap',
        provider: 'mock', promptTokens: 1, completionTokens: 1, costUsd: '0',
        latencyMs: 1, status: 200, createdAt: new Date(Date.now() - (i + k) * 1000),
      })) as never,
    );
  }
  const seeded = (await rows<{ n: number }>(h,
    "SELECT count(*)::int AS n FROM request_logs WHERE org_id='org_erase'"))[0]!.n;
  let eraseDetail: string;
  let eraseOk = false;
  try {
    const report = await deleteOrgCascade(h.db, 'org_erase');
    const left = (await rows<{ n: number }>(h,
      "SELECT count(*)::int AS n FROM request_logs WHERE org_id='org_erase'"))[0]!.n;
    eraseOk = left === 0 && report.deleted.request_logs === seeded;
    eraseDetail = `seeded ${seeded}, report says ${report.deleted.request_logs}, rows left ${left}`;
  } catch (e) {
    eraseDetail = `THREW: ${(e as Error).message.slice(0, 140)}`;
  }
  record(
    `5. F17: TRUE-CASCADE erasure of an org with ${N} request_logs (>500 chunk; vacuous on PGlite)`,
    eraseOk,
    eraseDetail,
  );

  // ---- 6. F21 on the real boot path: a migration with a divider comment.
  const throwaway = `9999_rehearsal_divider_comment.sql`;
  const path = `${DIR}/${throwaway}`;
  let f21Detail: string;
  let f21Ok = false;
  try {
    writeFileSync(path, [
      '-- F21 regression, executed on the real boot path.',
      '-- ---- a divider comment that used to hang the boot ----------------------',
      '-- ---- and a second one, for good measure -------------------------------',
      'CREATE TABLE IF NOT EXISTS rehearsal_divider_probe (id int PRIMARY KEY);',
    ].join('\n'));
    const started = Date.now();
    const withDivider = await migrateWithReport(h.db);
    const elapsed = Date.now() - started;
    const present = (await rows<{ n: number }>(h,
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name='rehearsal_divider_probe'"))[0]!.n;
    f21Ok = withDivider.executed.includes(throwaway) && present === 1 && elapsed < 30_000;
    f21Detail = `executed in ${elapsed}ms, probe table present=${present === 1}`;
  } catch (e) {
    f21Detail = `THREW: ${(e as Error).message.slice(0, 140)}`;
  } finally {
    rmSync(path, { force: true });
    await h.db.execute(sql.raw(
      `DELETE FROM schema_migrations WHERE filename = '${throwaway}'`)).catch(() => {});
    await h.db.execute(sql.raw('DROP TABLE IF EXISTS rehearsal_divider_probe')).catch(() => {});
  }
  record('6. F21: a migration with divider comments boots (real path, not unit timing)', f21Ok, f21Detail);

  // ---- 7. Ledger legibility for the operator.
  const applied = await appliedMigrations(h.db);
  record(
    '7. schema_migrations is readable and complete',
    applied.length === all.length,
    `${applied.length} rows, first=${applied[0]}, last=${applied[applied.length - 1]}`,
  );

  await h.close();

  const failed = results.filter((r) => !r.ok);
  const summary = [
    '',
    `REHEARSAL: ${results.length - failed.length}/${results.length} passed`,
    ...(failed.length ? [`FAILED: ${failed.map((f) => f.step).join('; ')}`] : []),
  ].join('\n');
  console.log(summary);
  if (process.env.REHEARSAL_LOG) {
    appendFileSync(process.env.REHEARSAL_LOG,
      results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}\t${r.step}\t${r.detail}`).join('\n') + summary + '\n');
  }
  if (failed.length) process.exitCode = 1;
}

void main().catch((e) => {
  console.error('REHEARSAL ABORTED:', e);
  process.exitCode = 1;
});
