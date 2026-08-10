// Post-capstone item 1 verification replay (operator script, run once against
// a COPY of .pglite/g28-live, $0):
//   PATH=... DATABASE_URL=pglite://<copy> [POTION_EVAL_PROVIDER=live] \
//     pnpm --filter @potion/workers exec tsx scripts/g28-metering-replay.ts
//
// Two checks against the REAL capstone evidence (never the curated original —
// run this on a copy; it writes verdict/run rows by design):
//   1. WITHOUT the env: the new mode-mismatch guard must refuse — this is
//      the leg-5c operator error replayed ($0.0413 mock verdict rendered
//      against a live contract, caught only by the 0029 providerMode stamp).
//      Post-guard it cannot be committed at all.
//   2. WITH POTION_EVAL_PROVIDER=live: the verify is fully cached (proven by
//      the supersession runs: zero provider calls), so per-call metering must
//      write ZERO new eval_live rows and reconcile calls=0 / meteredUsd=0 —
//      the filed $1.1045 over-metering, closed on the data that filed it.
import { createDb, evalResults, migrate, requestLogs } from '@potion/db';
import { and, eq } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';
import { guaranteeSuiteVerifyHandler, type JobContext } from '../src/handlers.js';

const ORG = 'org_g28_capstone';
const CLUSTER = 'agent-2dfbfb-d8898a';
const PRICES = fileURLToPath(new URL('../../../prices.json', import.meta.url));

async function main() {
  const h = await createDb();
  const db = h.db;
  await migrate(db); // applies 0030 to the copy

  const evalLiveRows = async () =>
    (await db.select().from(requestLogs).where(eq(requestLogs.status, 'eval_live'))).length;

  // Resolve the capstone candidate's FULL hash from the stored evidence
  // (the g28-supersede pattern).
  const rows = await db
    .select({ s: evalResults.strategyHash })
    .from(evalResults)
    .where(and(eq(evalResults.clusterId, CLUSTER), eq(evalResults.providerMode, 'live')));
  const candidate = [...new Set(rows.map((r) => r.s))].find((s) => s.startsWith('8fe33bc4'));
  if (!candidate) throw new Error('capstone evidence not found — wrong DATABASE_URL?');

  const before = await evalLiveRows();
  const ctx: JobContext = { db, dbHandle: h, pricesPath: PRICES };
  const result = await guaranteeSuiteVerifyHandler(
    { orgId: ORG, policyId: 'pol-g28-serve', clusterId: CLUSTER, servingStrategyHash: candidate, capUsd: 8 },
    ctx,
  );
  const after = await evalLiveRows();

  console.log(
    `MODE=${process.env.POTION_EVAL_PROVIDER ?? '(unset)'} outcome=${result.outcome} ` +
      `providerMode=${result.providerMode} verdictId=${result.verdictId?.slice(0, 8) ?? 'null'}`,
  );
  console.log(`eval_live request_log rows: ${before} before → ${after} after (delta ${after - before})`);
  if (result.retention) {
    console.log(
      `retention mean=${result.retention.mean.toFixed(4)} ci=[${result.retention.ci95
        .map((x) => x.toFixed(4))
        .join(', ')}] pairs=${result.retention.pairs}`,
    );
  }
  if (result.detail) console.log(`detail: ${result.detail}`);
  await h.close();
}

void main().catch((e: unknown) => {
  console.error(`REPLAY FAILED: ${(e as Error).message}`);
  process.exit(1);
});
