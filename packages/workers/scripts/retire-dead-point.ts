// Retire a DEAD serving point from a platform frontier (2026-09-02).
//
// WHY. A model on a committed frontier can stop being servable upstream — the
// 2026-09-02 case is `or-kat-coder-pro-v2.5`, on code-review v3 and
// extraction v3, whose sole OpenRouter endpoint now returns a hard 400 on
// every call (verified: deterministic across max_tokens 1 and 16). A served
// pick that 400s becomes an HTTP 503 with no fallback, so the dead point must
// leave the frontier.
//
// WHY NOT A PLAIN RE-SWEEP. The regression guard permits removing an
// incumbent ONLY as `dominated` (re-measured, produced rows, then lost). A
// model that THROWS every call is `contained` (0 cells) — evidence loss, which
// the guard refuses, correctly. This leg uses the deliberate-drop path added
// alongside it (handlers.ts / jobs.ts `deliberateDrops`): the operator
// acknowledges the CONTAINED incumbent as an intended drop, and the new
// version publishes without it while the containment record (error, 0 cells)
// stays the honest evidence.
//
// SURGICAL BY DESIGN. It auditions ONLY the dead alias, so every surviving
// incumbent carries forward from cache at $0 with its FULL original evidence
// (n unchanged) — this leg does not re-measure or re-power the survivors. The
// dead model fails pre-spend, so a run costs ≈ $0; the cap is a belt, not a
// budget.
//
//   set -a && source .env && set +a
//   PATH="$HOME/.local/bin:$PATH" POTION_EVAL_PROVIDER=live \
//     DATABASE_URL=pglite:///Users/kavonbadie/Projects/potion/.pglite/platform-sweep-step5 \
//     pnpm --filter @potion/workers exec tsx scripts/retire-dead-point.ts <clusterId> <deadAlias> [capUsd]
//
// publish is OFF unless RETIRE_PUBLISH=1: read the numbers (the leg must
// classify the dead alias as `contained` and the survivors as unchanged)
// before any frontier version is minted. After publishing every affected
// cluster, regenerate the committed baseline with scripts/export-baseline.mts
// and recompute the dashboard's hardcoded evidence copies.
import { createDb, createOrg, getBudget, getOrgById, migrate, upsertBudget } from '@potion/db';
import { strategyHash } from '@potion/core';
import { fileURLToPath } from 'node:url';
import { frontierPlatformSweepHandler, PLATFORM_OPS_ORG_ID } from '../src/handlers.js';
import type { FrontierPlatformSweepResult, JobContext } from '../src/handlers.js';

const REPO_PRICES = fileURLToPath(new URL('../../../prices.json', import.meta.url));
const APPROVED_TOTAL_CAP_USD = 60;
// The ONE durable database serving frontiers are minted against — the same
// canonical store step5-platform-sweep.ts guards (a bare/relative pglite URL
// is in-memory or a fresh dir, which would evaporate the belt and cache).
const CANONICAL_DB_URL = `pglite://${fileURLToPath(new URL('../../../.pglite/platform-sweep-step5', import.meta.url))}`;

const [clusterId, deadAlias, capArg] = process.argv.slice(2);
if (!clusterId || !deadAlias) {
  console.error('usage: retire-dead-point.ts <clusterId> <deadAlias> [capUsd=1]');
  process.exit(1);
}
const capUsd = capArg !== undefined ? Number(capArg) : 1;
const PUBLISH = process.env.RETIRE_PUBLISH === '1';

if (process.env.POTION_EVAL_PROVIDER !== 'live') {
  console.error('refusing: POTION_EVAL_PROVIDER=live required (the handler would refuse too)');
  process.exit(1);
}
if (process.env.DATABASE_URL !== CANONICAL_DB_URL) {
  console.error(`refusing: DATABASE_URL must be exactly the canonical durable step-5 db:\n  ${CANONICAL_DB_URL}\n(got: ${process.env.DATABASE_URL ?? '<unset>'})`);
  process.exit(1);
}
// Match step5's key discipline: the dead model is an OpenRouter alias, and a
// stray key for another provider would widen the reachable candidate set.
for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY']) {
  if (process.env[k] !== undefined) {
    console.error(`refusing: ${k} is set — unset it so the reachable candidate set is OpenRouter-only`);
    process.exit(1);
  }
}
if (process.env.OPENROUTER_API_KEY === undefined) {
  console.error('refusing: OPENROUTER_API_KEY not set (the dead alias must be re-measured live to be CONTAINED honestly)');
  process.exit(1);
}

const deadHash = strategyHash({ type: 'single', model: deadAlias });
console.log(
  `retire-dead-point: cluster=${clusterId} deadAlias=${deadAlias} hash=${deadHash.slice(0, 8)} ` +
    `cap $${capUsd} publish=${PUBLISH}`,
);

const db = await createDb();
try {
  await migrate(db.db);
  // The belt: $60 hard stop on the ops org, created ONLY when absent (an
  // existing belt is operator-owned; never re-arm a cap tightened mid-flight).
  if ((await getOrgById(db.db, PLATFORM_OPS_ORG_ID)) === null) {
    await createOrg(db.db, { id: PLATFORM_OPS_ORG_ID, name: 'Platform operations' });
  }
  if ((await getBudget(db.db, PLATFORM_OPS_ORG_ID)) === null) {
    await upsertBudget(db.db, { orgId: PLATFORM_OPS_ORG_ID, monthlyCapUsd: APPROVED_TOTAL_CAP_USD, hardStop: true, warnPct: 80 });
    console.log(`belt created: $${APPROVED_TOTAL_CAP_USD} hard stop on ${PLATFORM_OPS_ORG_ID}`);
  }

  const ctx: JobContext = { db: db.db, dbHandle: db, pricesPath: REPO_PRICES };
  const result = (await frontierPlatformSweepHandler(
    {
      clusterId,
      capUsd,
      // Audition ONLY the dead alias. Every other incumbent carries forward
      // from cache at $0 with its full original evidence; the dead alias is
      // re-measured (and fails) so its removal rests on a fresh live verdict.
      auditionModels: [deadAlias],
      // Salt ONLY the dead alias's cells. Without a salt the warm store
      // answers the audition with the alias's healthy pre-death rows and the
      // leg can never contain it (observed 2026-09-02: 0 executed / 168
      // cached, "NOT contained this run"). And without the SCOPE the salt
      // invalidates the survivors' cache keys too — carry-forward re-measured
      // all nine extraction survivors live (360 executed / 0 cached) and
      // drifted their quality, the opposite of surgical (also observed
      // 2026-09-02, caught at export by the survivors-verbatim check).
      // Deterministic so the DRY and PUBLISH runs share cells.
      cacheSalt: `retire:${deadAlias}`,
      cacheSaltStrategies: [deadHash],
      // Acknowledge the contained drop. The guard still refuses if the alias
      // is NOT contained this run (recovered, or delisted so it never became a
      // candidate) — this leg cannot silently drop a healthy point.
      deliberateDrops: [deadHash],
      publish: PUBLISH,
    },
    ctx,
  )) as FrontierPlatformSweepResult;

  console.log(JSON.stringify(result, null, 2));
  const dropped = result.deliberatelyDropped.find((d) => d.strategyHash === deadHash);
  const contained = result.failedCandidates.find((f) => f.strategyHash === deadHash);
  if (dropped) {
    console.log(`✓ ${deadAlias} classified CONTAINED and deliberately dropped (${dropped.error})`);
  } else if (contained && !PUBLISH) {
    // publish:false skips the regression guard entirely (nothing is saved, so
    // there is nothing to protect) — deliberatelyDropped is only populated on
    // a publishing run. Containment is the whole DRY verdict.
    console.log(`✓ ${deadAlias} CONTAINED on a fresh live call (${contained.error ?? 'error'}) — the ack is exercised at RETIRE_PUBLISH=1`);
  } else if (contained) {
    console.log(`⚠ ${deadAlias} was contained but NOT in the drop set — nothing was retired`);
  } else {
    console.log(`⚠ ${deadAlias} was NOT contained this run (recovered? not a candidate?) — check before publishing`);
  }
  console.log(
    `LEDGER | retire ${clusterId}/${deadAlias} | projected $${result.projectedSpendUsd.toFixed(4)} | ` +
      `actual $${result.spendUsd.toFixed(4)} | ${result.executed} executed / ${result.cacheHits} cached | ` +
      `frontier v${result.frontierVersion ?? '—'} (${result.points} pts) publish=${PUBLISH}`,
  );
} finally {
  await db.close();
}
