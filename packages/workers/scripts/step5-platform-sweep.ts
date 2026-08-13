// Lab Step 5 — one PLATFORM live-sweep leg (operator script, the g17/g28
// invocation pattern). One cluster per invocation; resumable: a killed leg
// re-runs with the same args and pays only the remainder (per-call metering
// + |live cache keys).
//
//   set -a && source .env && set +a
//   PATH="$HOME/.local/bin:$PATH" POTION_EVAL_PROVIDER=live \
//     DATABASE_URL=pglite:///Users/kavonbadie/Projects/potion/.pglite/platform-sweep-step5 \
//     pnpm --filter @potion/workers exec tsx scripts/step5-platform-sweep.ts <clusterId> [capUsd] [sampleN]
//
// Defaults: capUsd 6 (the approved Tier B sub-cap), sampleN 15. The $60
// hard-stop belt on org_platform_ops is asserted into place BEFORE the
// handler runs (review outcome 1) — the handler still refuses without it.
import { createDb, createOrg, getBudget, getOrgById, migrate, upsertBudget } from '@potion/db';
import { fileURLToPath } from 'node:url';
import { frontierPlatformSweepHandler, PLATFORM_OPS_ORG_ID } from '../src/handlers.js';
import type { JobContext } from '../src/handlers.js';

const REPO_PRICES = fileURLToPath(new URL('../../../prices.json', import.meta.url));
const APPROVED_TOTAL_CAP_USD = 60;
// The ONE durable database this campaign spends against (review finding:
// createDb treats bare 'pglite://' as IN-MEMORY and silently creates fresh
// dirs for typo'd/relative paths — belt, month-to-date meter, and resume
// cache would evaporate per invocation while provider spend stayed real).
const CANONICAL_DB_URL = `pglite://${fileURLToPath(new URL('../../../.pglite/platform-sweep-step5', import.meta.url))}`;

const [clusterId, capArg, sampleArg] = process.argv.slice(2);
if (!clusterId) {
  console.error('usage: step5-platform-sweep.ts <clusterId> [capUsd=6] [sampleN=15]');
  process.exit(1);
}
const capUsd = capArg !== undefined ? Number(capArg) : 6;
const sampleN = sampleArg !== undefined ? Number(sampleArg) : 15;

if (process.env.POTION_EVAL_PROVIDER !== 'live') {
  console.error('refusing: POTION_EVAL_PROVIDER=live required (the handler would refuse too)');
  process.exit(1);
}
if (process.env.DATABASE_URL !== CANONICAL_DB_URL) {
  console.error(`refusing: DATABASE_URL must be exactly the canonical durable step-5 db:\n  ${CANONICAL_DB_URL}\n(got: ${process.env.DATABASE_URL ?? '<unset>'})`);
  process.exit(1);
}
// The rotation attestation covers OPENROUTER_API_KEY ONLY. Any other
// provider key in env would (a) widen the handler's key-reachability
// candidate set beyond what leg 0 forecast and the operator approved, and
// (b) spend on a key with no rotation attestation. Refuse, structurally.
for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY']) {
  if (process.env[k] !== undefined) {
    console.error(`refusing: ${k} is set — the Step 5 attestation covers OPENROUTER_API_KEY only; unset it for leg invocations (candidate set must match the approved leg-0 forecast)`);
    process.exit(1);
  }
}
if (process.env.OPENROUTER_API_KEY === undefined) {
  console.error('refusing: OPENROUTER_API_KEY not set');
  process.exit(1);
}

const db = await createDb();
try {
  await migrate(db.db);
  // The belt (review outcome 1): $60 hard stop on the ops org — created
  // ONLY when absent. An existing belt is operator-owned state; a habitual
  // invocation must never re-arm a cap the operator tightened mid-campaign
  // (review finding). The handler refuses if the belt is missing or soft.
  if ((await getOrgById(db.db, PLATFORM_OPS_ORG_ID)) === null) {
    await createOrg(db.db, { id: PLATFORM_OPS_ORG_ID, name: 'Platform operations' });
  }
  const existingBelt = await getBudget(db.db, PLATFORM_OPS_ORG_ID);
  if (existingBelt === null) {
    await upsertBudget(db.db, {
      orgId: PLATFORM_OPS_ORG_ID,
      monthlyCapUsd: APPROVED_TOTAL_CAP_USD,
      hardStop: true,
    });
    console.log(`belt created: $${APPROVED_TOTAL_CAP_USD} hard stop on ${PLATFORM_OPS_ORG_ID}`);
  } else {
    console.log(`belt present (operator-owned, untouched): $${existingBelt.monthlyCapUsd} hardStop=${existingBelt.hardStop}`);
  }

  const ctx: JobContext = { db: db.db, dbHandle: db, pricesPath: REPO_PRICES };
  const started = Date.now();
  const result = await frontierPlatformSweepHandler({ clusterId, capUsd, sampleN }, ctx);
  const secs = ((Date.now() - started) / 1000).toFixed(1);

  console.log(JSON.stringify(result, null, 2));
  // One ledger line per leg — copied verbatim into tasks/todo.md.
  console.log(
    `LEDGER | Step5 ${clusterId} | projected $${result.projectedSpendUsd.toFixed(4)} | actual $${result.spendUsd.toFixed(4)} | ` +
      `${result.executed} executed / ${result.cacheHits} cached | frontier v${result.frontierVersion} (${result.points} pts: ` +
      `${result.singlesOnFrontier} single, ${result.compositesOnFrontier} composite) | ${secs}s`,
  );
} finally {
  await db.close();
}
