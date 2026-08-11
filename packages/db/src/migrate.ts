// Migration runner (SPEC §7): executes the SQL files under packages/db/drizzle/
// in lexical order, each one EXACTLY ONCE, tracked in `schema_migrations`.
//
// F12 — WHY THE LEDGER EXISTS. This runner used to re-execute every statement
// of every file on every boot, and its header asserted the property that made
// that safe: "every statement is idempotent (CREATE ... IF NOT EXISTS)". That
// assertion was false. 0023 backfills tenancy with
//   UPDATE frontiers SET org_id = c.org_id FROM clusters c
//     WHERE ... AND c.org_id IS NOT NULL AND frontiers.org_id IS NULL
// against four tables whose org_id is NULLABLE, where NULL *means platform*.
// Nothing closes that predicate, so every restart MOVED platform evidence
// into a tenant's pool — deleting the platform fallback the serving read
// depends on, and injecting evidence the tenant never generated. Worse: once
// the tenant owned the same (cluster, version), the UPDATE collided with
// frontiers_org_cluster_version and migrate() THREW — and since
// apps/server/src/context.ts calls it on the boot path, the server would not
// start at all.
//
// A comment asserting a protection must be traceable to the code enforcing
// it (tasks/lessons.md). The ledger is that code; this comment is now backed
// by `appliedMigrations()` and by migration-safety.test.ts, which fails the
// build if a future migration adds an unguarded data statement.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import type { PotionDb } from './db.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../drizzle', import.meta.url));

/**
 * The last migration that existed BEFORE the ledger did.
 *
 * Every database alive today has already had 0000–0032 applied (repeatedly —
 * that was the bug). Baselining marks exactly this prefix as applied WITHOUT
 * executing it, so the very boot that installs the ledger does not perform
 * one final re-attribution on its way in. Files after the cutoff are new to
 * every database and run normally — which is what lets 0033's repair run.
 *
 * Never extend this. New migrations belong after it, not inside it.
 */
export const BASELINE_THROUGH = '0032_job_executions.sql';

export interface MigrationReport {
  /** Every migration recorded as applied after this run (sorted). */
  applied: string[];
  /** Files whose statements this run actually executed. */
  executed: string[];
  /** Files marked applied WITHOUT executing (pre-existing database). */
  baselined: string[];
}

export function listMigrationFiles(dir: string = MIGRATIONS_DIR): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/**
 * Split a migration file into executable statements, dropping chunks that are
 * only comments.
 *
 * F21 (found while writing 0033): the predicate used to be the regex
 * `/^(--[^\n]*\n?)*$/`. Every `--` INSIDE a comment line is another place the
 * group can start an iteration, so a divider like
 *   -- ---- frontiers ------------------------------
 * gives the engine exponentially many ways to partition the line. On a chunk
 * that then fails to match, it backtracks through all of them: the boot HANGS
 * — no error, no timeout, no log line, and PGlite/WASM pins the event loop so
 * even a watchdog timer never fires. A migration whose comment used ASCII
 * rules would have silently wedged startup forever.
 *
 * This form is linear: keep the chunk if any line is neither blank nor a
 * comment. Same intent, no backtracking.
 */
export function splitStatements(sqlText: string): string[] {
  const hasExecutableLine = (chunk: string): boolean =>
    chunk.split('\n').some((line) => {
      const t = line.trim();
      return t.length > 0 && !t.startsWith('--');
    });
  return sqlText
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && hasExecutableLine(s));
}

/** Bootstrap: the ledger cannot be a migration file — it has to exist before
 * we can ask which files have run. Created directly, idempotently. */
async function ensureLedger(db: PotionDb): Promise<void> {
  await db.execute(
    sql.raw(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now(),
      baselined boolean NOT NULL DEFAULT false
    )`),
  );
}

async function ledgerRows(db: PotionDb): Promise<Set<string>> {
  const res = await db.execute(sql.raw('SELECT filename FROM schema_migrations'));
  const rows = (res as unknown as { rows?: Array<{ filename: string }> }).rows ?? [];
  return new Set(rows.map((r) => r.filename));
}

/** True when this database predates the ledger: schema objects exist but
 * nothing has been recorded. Uses information_schema for driver portability
 * (PGlite and node-postgres both answer it). */
async function looksPreExisting(db: PotionDb): Promise<boolean> {
  const res = await db.execute(
    sql.raw(
      "SELECT count(*)::int AS n FROM information_schema.tables " +
        "WHERE table_schema = 'public' AND table_name = 'orgs'",
    ),
  );
  const rows = (res as unknown as { rows?: Array<{ n: number }> }).rows ?? [];
  return Number(rows[0]?.n ?? 0) > 0;
}

async function record(db: PotionDb, filename: string, baselined: boolean): Promise<void> {
  await db.execute(
    sql`INSERT INTO schema_migrations (filename, baselined) VALUES (${filename}, ${baselined})
        ON CONFLICT (filename) DO NOTHING`,
  );
}

/**
 * Apply every not-yet-applied migration, in order, exactly once.
 *
 * Each file's statements and its ledger row commit together, so a file is
 * recorded only if it fully succeeded; a crash mid-file leaves it unrecorded
 * and it retries on the next boot.
 */
export async function migrateWithReport(db: PotionDb): Promise<MigrationReport> {
  await ensureLedger(db);

  const files = listMigrationFiles();
  let done = await ledgerRows(db);
  const baselined: string[] = [];

  // Decide baselining BEFORE executing anything — this is the whole point.
  if (done.size === 0 && (await looksPreExisting(db))) {
    for (const file of files) {
      if (file > BASELINE_THROUGH) continue;
      await record(db, file, true);
      baselined.push(file);
    }
    done = await ledgerRows(db);
  }

  const executed: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const statements = splitStatements(readFileSync(`${MIGRATIONS_DIR}/${file}`, 'utf8'));
    await db.transaction(async (tx) => {
      for (const statement of statements) {
        await tx.execute(sql.raw(statement));
      }
      await tx.execute(
        sql`INSERT INTO schema_migrations (filename, baselined) VALUES (${file}, false)
            ON CONFLICT (filename) DO NOTHING`,
      );
    });
    executed.push(file);
  }

  return { applied: [...(await ledgerRows(db))].sort(), executed, baselined };
}

/**
 * Back-compatible entry point: returns every migration recorded as applied
 * (not just the ones this call executed), so a second call still reports the
 * full set. Callers wanting to know what actually ran use migrateWithReport.
 */
export async function migrate(db: PotionDb): Promise<string[]> {
  return (await migrateWithReport(db)).applied;
}

/** The ledger's contents — the traceable evidence for "applied exactly once". */
export async function appliedMigrations(db: PotionDb): Promise<string[]> {
  await ensureLedger(db);
  return [...(await ledgerRows(db))].sort();
}
