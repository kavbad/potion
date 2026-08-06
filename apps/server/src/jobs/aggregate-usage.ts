// Usage rollup job (M2 Wave 2, ROADMAP #18) — the batch entry point for
// request_logs → usage_daily:
//   pnpm --filter @potion/server aggregate -- [--from YYYY-MM-DD] [--to YYYY-MM-DD]
// Defaults: today (UTC) only. Idempotent — safe on any cron schedule
// (nightly backfill of yesterday + today is the intended cadence). The chat
// path never writes usage_daily; this job is the only writer (documented in
// packages/db/src/repos/usage.ts).
import { createDb, migrate, aggregateUsage, utcDay } from '@potion/db';

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1]!.startsWith('--')) out[a.slice(2)] = argv[++i]!;
      else out[a.slice(2)] = 'true';
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const today = utcDay();
  const fromDay = args.from ?? today;
  const toDay = args.to ?? fromDay;

  const db = await createDb(process.env.DATABASE_URL);
  try {
    await migrate(db.db);
    const rows = await aggregateUsage(db.db, { fromDay, toDay });
    console.log(
      JSON.stringify(
        { fromDay, toDay, rowsUpserted: rows.length, rows },
        null,
        2,
      ),
    );
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
