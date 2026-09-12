// The provider-drift tripwire, run once from a shell (2026-09-11).
//
// The server schedules the same handler weekly as the 'drift:canary' job;
// this entry point exists for the host cron that used to run the retired
// scripts/observatory-week.ts (compose `observatory` profile) and for an
// operator who wants to run it now. Idempotent per ISO week unless --force.
//
//   docker compose … --profile observatory run --rm observatory \
//     node_modules/.bin/tsx scripts/drift-canary.ts [--force] [--week 2026-W37]
import { createDb, migrate } from '@potion/db';
import { driftCanaryHandler } from '@potion/workers';

const args = process.argv.slice(2);
const force = args.includes('--force');
const weekIdx = args.indexOf('--week');
const week = weekIdx >= 0 ? args[weekIdx + 1] : undefined;
const pricesPath = process.env.POTION_PRICES_PATH;
if (!pricesPath) throw new Error('POTION_PRICES_PATH is required');

const handle = await createDb(process.env.DATABASE_URL);
try {
  await migrate(handle.db);
  const res = await driftCanaryHandler({ ...(week !== undefined ? { week } : {}), force }, { db: handle.db, dbHandle: handle, pricesPath });
  console.log(JSON.stringify(res, null, 1));
} finally {
  await handle.close();
}
