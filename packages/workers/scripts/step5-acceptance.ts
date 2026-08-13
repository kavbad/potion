// Lab Step 5 — acceptance + reconciliation over the durable campaign db.
// READ-ONLY. Renders: per-cluster DoD table (frontier version, point mix,
// live-only evidence, suiteContentHash), containment assertions (zero
// org-attributed evidence anywhere; spend only under org_platform_ops),
// belt state, and the per-model spend sheet for provider reconciliation.
//
//   DATABASE_URL=pglite:///Users/kavonbadie/Projects/potion/.pglite/platform-sweep-step5 \
//     pnpm --filter @potion/workers exec tsx scripts/step5-acceptance.ts
import { createDb, evalResults, frontiers, requestLogs, getBudget, mtdSpendUsd } from '@potion/db';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { PLATFORM_OPS_ORG_ID, PLATFORM_SUITE_BY_CLUSTER } from '../src/handlers.js';

const db = await createDb();
try {
  let failed = false;
  const fail = (msg: string) => { failed = true; console.error(`FAIL: ${msg}`); };

  console.log('cluster                | frontier | pts | singles | composites | all-live | contentHash | live rows');
  console.log('-----------------------|----------|-----|---------|------------|----------|-------------|----------');
  for (const clusterId of Object.keys(PLATFORM_SUITE_BY_CLUSTER)) {
    const rows = await db.db.select().from(frontiers).where(and(eq(frontiers.clusterId, clusterId), isNull(frontiers.orgId)));
    const latest = rows.sort((a, b) => b.version - a.version)[0];
    const evidence = await db.db
      .select({ n: sql<number>`count(*)::int` })
      .from(evalResults)
      .where(and(eq(evalResults.clusterId, clusterId), isNull(evalResults.orgId), eq(evalResults.providerMode, 'live')));
    const liveRows = evidence[0]?.n ?? 0;
    if (!latest) {
      console.log(`${clusterId.padEnd(22)} | ${'—'.padEnd(8)} | — (not swept yet) | live rows ${liveRows}`);
      continue;
    }
    const pts = latest.points as Array<{ strategyConfig: { type: string }; providerMode?: string; evidence?: { suiteContentHash?: string } }>;
    const singles = pts.filter((p) => p.strategyConfig.type === 'single').length;
    const composites = pts.length - singles;
    const allLive = pts.length > 0 && pts.every((p) => p.providerMode === 'live');
    const hashed = pts.every((p) => p.evidence?.suiteContentHash !== undefined);
    console.log(
      `${clusterId.padEnd(22)} | v${String(latest.version).padEnd(7)} | ${String(pts.length).padStart(3)} | ${String(singles).padStart(7)} | ${String(composites).padStart(10)} | ${String(allLive).padStart(8)} | ${String(hashed).padStart(11)} | ${String(liveRows).padStart(8)}`,
    );
    if (!allLive) fail(`${clusterId}: latest platform frontier is not all-live`);
    if (!hashed) fail(`${clusterId}: points missing suiteContentHash provenance`);
  }

  // Containment: ZERO org-attributed evidence rows exist in the campaign db.
  const orgEval = await db.db.select({ n: sql<number>`count(*)::int` }).from(evalResults).where(isNotNull(evalResults.orgId));
  const orgFrontiers = await db.db.select({ n: sql<number>`count(*)::int` }).from(frontiers).where(isNotNull(frontiers.orgId));
  console.log(`\ncontainment: org-attributed eval_results=${orgEval[0]!.n} frontiers=${orgFrontiers[0]!.n} (must be 0/0)`);
  if (orgEval[0]!.n !== 0) fail('org-attributed eval_results rows exist');
  if (orgFrontiers[0]!.n !== 0) fail('org-attributed frontier rows exist');

  // Spend: every request_logs row belongs to the ops org, status eval_live.
  const foreignSpend = await db.db
    .select({ n: sql<number>`count(*)::int` })
    .from(requestLogs)
    .where(sql`org_id <> ${PLATFORM_OPS_ORG_ID}`);
  console.log(`spend home: request_logs outside ${PLATFORM_OPS_ORG_ID} = ${foreignSpend[0]!.n} (must be 0)`);
  if (foreignSpend[0]!.n !== 0) fail('spend rows outside the ops org');

  // Belt + MTD.
  const belt = await getBudget(db.db, PLATFORM_OPS_ORG_ID);
  const mtd = await mtdSpendUsd(db.db, PLATFORM_OPS_ORG_ID, new Date());
  console.log(`belt: $${belt?.monthlyCapUsd} hardStop=${belt?.hardStop} | MTD metered: $${mtd.toFixed(4)}`);

  // Reconciliation sheet: per-model spend from request_logs.
  const byModel = await db.db
    .select({
      model: requestLogs.model,
      calls: sql<number>`count(*)::int`,
      spend: sql<string>`sum((usage->>'costUsd')::numeric)::text`,
      tokensIn: sql<string>`sum((usage->>'inputTokens')::numeric)::text`,
      tokensOut: sql<string>`sum((usage->>'outputTokens')::numeric)::text`,
    })
    .from(requestLogs)
    .where(eq(requestLogs.orgId, PLATFORM_OPS_ORG_ID))
    .groupBy(requestLogs.model);
  console.log('\nRECONCILIATION SHEET (request_logs, org_platform_ops, status eval_live)');
  console.log('model                       | calls | tokens in | tokens out | metered USD');
  console.log('----------------------------|-------|-----------|------------|------------');
  let total = 0;
  for (const r of byModel.sort((a, b) => (a.model! < b.model! ? -1 : 1))) {
    total += Number(r.spend);
    console.log(
      `${(r.model ?? '?').padEnd(27)} | ${String(r.calls).padStart(5)} | ${String(r.tokensIn).padStart(9)} | ${String(r.tokensOut).padStart(10)} | $${Number(r.spend).toFixed(4).padStart(10)}`,
    );
  }
  console.log(`${'TOTAL'.padEnd(27)} | ${''.padStart(5)} | ${''.padStart(9)} | ${''.padStart(10)} | $${total.toFixed(4).padStart(10)}`);
  console.log('\nOperator countersign: lay the per-model rows against the OpenRouter dashboard totals for the campaign window.');

  if (failed) process.exit(1);
  console.log('\nACCEPTANCE CHECKS OK for all swept clusters.');
} finally {
  await db.close();
}
