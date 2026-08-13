// TRUE-CASCADE org deletion (G2.7) — the deletion-semantics carve-out
// (owner, 2026-08-07): OPERATIONAL purge (retention) is stale-never-delete;
// ORG-LEVEL deletion (offboarding / legal erasure) is a TRUE CASCADE —
// evidence rows AND tombstones included, historical explainability knowingly
// sacrificed. This is the only code path allowed to hard-delete evidence.
//
// The cascade is hand-written and ORDERED: the schema has exactly one FK
// cascade (derived_suite_items → derived_suites); every other org reference
// is NO ACTION and would block DELETE FROM orgs. Id sets are SNAPSHOTTED
// before parents are deleted (the judge_calibrations union and the
// alert_deliveries cast-join are unreachable afterwards). Platform assets
// are NEVER touched: models, strategy_configs (content-addressed, shared),
// recipe_status (platform library), clusters WHERE org_id IS NULL (the
// taxonomy). eval_items is a dead table (no reads/writes anywhere) and is
// deliberately ignored.
//
// The report carries PER-TABLE deleted counts — the owner's status+evidence
// rule applies to deletion reports too: "here's exactly what was erased".
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { PotionDb } from '../db.js';
import {
  alertDeliveries,
  alertRules,
  apiKeys,
  authEvents,
  budgetEvents,
  budgets,
  clusterExemplars,
  clusterIncumbents,
  clusterRubrics,
  guaranteeVerdicts,
  suiteCertifications,
  clusters,
  custodyAudit,
  derivedSuites,
  evalResults,
  evalRuns,
  frontierPoints,
  frontiers,
  incidents,
  judgeCalibrations,
  magicLinks,
  memberships,
  orgs,
  policies,
  providerKeys,
  qualitySamples,
  labFeltSamples,
  labHarnesses,
  labHarnessMemory,
  labRuns,
  labRunSteps,
  requestLogs,
  researchCycles,
  sessions,
  shadowResults,
  shareTokens,
  traceSpans,
  usageDaily,
  users,
  DEFAULT_ORG_ID,
} from '../schema.js';

export interface OrgDeleteReport {
  orgId: string;
  /** True when the org row was already absent — the whole call is a no-op
   * (idempotent double-delete). */
  alreadyDeleted: boolean;
  /** Per-table deleted row counts (only tables with >0 are guaranteed
   * present; zero-count tables may be listed as 0). */
  deleted: Record<string, number>;
  /** Orphaned users erased (zero remaining memberships AND sessions). */
  usersErased: number;
}

const CHUNK = 500;

/** Chunked delete for the hot tables — PGlite is single-connection and a
 * request-log-heavy org must not be one giant in-memory transaction. */
async function chunkedDeleteByOrg(
  db: PotionDb,
  table: typeof requestLogs | typeof traceSpans,
  orgId: string,
): Promise<number> {
  let total = 0;
  for (;;) {
    const res = await db.execute(
      sql`DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM ${table} WHERE org_id = ${orgId} LIMIT ${CHUNK})`,
    );
    const n = (res as { rowCount?: number }).rowCount ?? 0;
    total += n;
    if (n < CHUNK) break;
  }
  return total;
}

/**
 * Delete an org and EVERYTHING derived from it. Refuses DEFAULT_ORG_ID
 * (platform-wide unauthenticated request logs live under it, it is the
 * 0003 backfill target re-seeded every boot, and the dev-auth fallback).
 * Idempotent: an absent org returns {alreadyDeleted: true} with zeros.
 */
export async function deleteOrgCascade(db: PotionDb, orgId: string): Promise<OrgDeleteReport> {
  if (orgId === DEFAULT_ORG_ID) {
    throw new Error(
      `refusing to delete '${DEFAULT_ORG_ID}' — it holds platform-wide unauthenticated ` +
        'request logs, is the tenancy-backfill target re-seeded at every boot, and is the ' +
        'dev-auth fallback org',
    );
  }
  const orgRows = await db.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, orgId));
  if (orgRows.length === 0) {
    return { orgId, alreadyDeleted: true, deleted: {}, usersErased: 0 };
  }

  const deleted: Record<string, number> = {};
  const count = async (name: string, p: Promise<Array<unknown>>): Promise<void> => {
    deleted[name] = (deleted[name] ?? 0) + (await p).length;
  };

  // ---- 1. SNAPSHOT id sets (all reads; parents still exist) ----
  const orgClusterIds = (
    await db.select({ id: clusters.id }).from(clusters).where(eq(clusters.orgId, orgId))
  ).map((r) => r.id);
  const orgSuiteIds = (
    await db.select({ id: derivedSuites.suiteId }).from(derivedSuites).where(eq(derivedSuites.orgId, orgId))
  ).map((r) => r.id);
  const ruleIds = (
    await db.select({ id: alertRules.id }).from(alertRules).where(eq(alertRules.orgId, orgId))
  ).map((r) => r.id);
  const rubricCalIds = (
    await db
      .select({ id: clusterRubrics.calibrationId })
      .from(clusterRubrics)
      .where(eq(clusterRubrics.orgId, orgId))
  )
    .map((r) => r.id)
    .filter((id): id is string => id !== null);
  // judge_calibrations union: (a) org suites, (b) org clusters, (c) rubric
  // calibration ids — (c) is load-bearing (both scope columns are nullable).
  const calIdSet = new Set<string>(rubricCalIds);
  if (orgSuiteIds.length > 0) {
    for (const r of await db
      .select({ id: judgeCalibrations.id })
      .from(judgeCalibrations)
      .where(inArray(judgeCalibrations.suiteId, orgSuiteIds)))
      calIdSet.add(r.id);
  }
  if (orgClusterIds.length > 0) {
    for (const r of await db
      .select({ id: judgeCalibrations.id })
      .from(judgeCalibrations)
      .where(inArray(judgeCalibrations.clusterId, orgClusterIds)))
      calIdSet.add(r.id);
  }
  const calIds = [...calIdSet];

  // ---- 2. Ordered FK edges ----
  if (ruleIds.length > 0) {
    // alert_deliveries.rule_id is TEXT vs alert_rules.id UUID — cast join,
    // and no FK exists (the silent-orphan class): must go before the rules.
    await count(
      'alert_deliveries',
      db
        .delete(alertDeliveries)
        .where(inArray(alertDeliveries.ruleId, ruleIds.map((id) => String(id))))
        .returning({ id: alertDeliveries.id }),
    );
  }
  await count('alert_rules', db.delete(alertRules).where(eq(alertRules.orgId, orgId)).returning({ id: alertRules.id }));
  await count('api_keys', db.delete(apiKeys).where(eq(apiKeys.orgId, orgId)).returning({ id: apiKeys.id }));
  await count('policies', db.delete(policies).where(eq(policies.orgId, orgId)).returning({ id: policies.id }));
  await count(
    'frontier_points',
    db.delete(frontierPoints).where(eq(frontierPoints.orgId, orgId)).returning({ id: frontierPoints.id }),
  );
  await count('frontiers', db.delete(frontiers).where(eq(frontiers.orgId, orgId)).returning({ id: frontiers.id }));
  if (orgClusterIds.length > 0) {
    await count(
      'cluster_exemplars',
      db
        .delete(clusterExemplars)
        .where(inArray(clusterExemplars.clusterId, orgClusterIds))
        .returning({ id: clusterExemplars.id }),
    );
  }
  await count(
    'cluster_rubrics',
    db.delete(clusterRubrics).where(eq(clusterRubrics.orgId, orgId)).returning({ id: clusterRubrics.id }),
  );
  // The guarantee trio (0025 incumbents, 0029 verdicts, 0031 certifications).
  // All three landed AFTER the G2.7 cascade and none of their items touched
  // this file, so every org that ever designated an incumbent — i.e. every
  // guarantee customer — failed deletion with an FK violation while the
  // "nothing derived survives" test passed, because its fixture stops short
  // of designation. Found by the invariant sweep; the completeness meta-test
  // in org-delete.test.ts now makes the next such omission a build failure.
  await count(
    'cluster_incumbents',
    db.delete(clusterIncumbents).where(eq(clusterIncumbents.orgId, orgId)).returning({ id: clusterIncumbents.id }),
  );
  await count(
    'guarantee_verdicts',
    db.delete(guaranteeVerdicts).where(eq(guaranteeVerdicts.orgId, orgId)).returning({ id: guaranteeVerdicts.id }),
  );
  await count(
    'suite_certifications',
    db
      .delete(suiteCertifications)
      .where(eq(suiteCertifications.orgId, orgId))
      .returning({ id: suiteCertifications.id }),
  );
  // derived_suite_items ride the schema's ONE real cascade.
  await count(
    'derived_suites',
    db.delete(derivedSuites).where(eq(derivedSuites.orgId, orgId)).returning({ id: derivedSuites.suiteId }),
  );
  if (calIds.length > 0) {
    await count(
      'judge_calibrations',
      db.delete(judgeCalibrations).where(inArray(judgeCalibrations.id, calIds)).returning({ id: judgeCalibrations.id }),
    );
  }
  // Org clusters LAST among cluster-linked tables; platform (NULL) rows are
  // untouchable by construction of the predicate.
  await count(
    'clusters',
    db
      .delete(clusters)
      .where(and(eq(clusters.orgId, orgId), sql`${clusters.orgId} IS NOT NULL`))
      .returning({ id: clusters.id }),
  );

  // ---- 3. Hot tables, chunked, outside any transaction ----
  deleted.request_logs = await chunkedDeleteByOrg(db, requestLogs, orgId);

  // ---- Lab runtime (Step 3, 0035): runs, checkpoints, harness memory ----
  // Harness memory is the most privacy-sensitive data the Lab holds; steps
  // carry verbatim model I/O. Steps go first (FK to runs), then runs, then
  // memory. Covered by the F5 schema-derived completeness meta-test from the
  // same commit that created the tables.
  await count('lab_run_steps', db.delete(labRunSteps).where(eq(labRunSteps.orgId, orgId)).returning({ x: labRunSteps.seq }));
  await count('lab_runs', db.delete(labRuns).where(eq(labRuns.orgId, orgId)).returning({ x: labRuns.id }));
  await count('lab_harness_memory', db.delete(labHarnessMemory).where(eq(labHarnessMemory.orgId, orgId)).returning({ x: labHarnessMemory.key }));
  // Lab Step 7 (0036): felt-sample cache — org-scoped like all lab data.
  await count('lab_felt_samples', db.delete(labFeltSamples).where(eq(labFeltSamples.orgId, orgId)).returning({ x: labFeltSamples.probeHash }));
  // Lab Step 8 (0037): harness catalog.
  await count('lab_harnesses', db.delete(labHarnesses).where(eq(labHarnesses.orgId, orgId)).returning({ x: labHarnesses.harnessHash }));
  deleted.trace_spans = await chunkedDeleteByOrg(db, traceSpans, orgId);

  // ---- 4. Free-order bulk ----
  await count(
    'quality_samples',
    db.delete(qualitySamples).where(eq(qualitySamples.orgId, orgId)).returning({ id: qualitySamples.id }),
  );
  await count(
    'shadow_results',
    db.delete(shadowResults).where(eq(shadowResults.orgId, orgId)).returning({ id: shadowResults.id }),
  );
  await count('incidents', db.delete(incidents).where(eq(incidents.orgId, orgId)).returning({ id: incidents.id }));
  await count(
    'usage_daily',
    db.delete(usageDaily).where(eq(usageDaily.orgId, orgId)).returning({ orgId: usageDaily.orgId }),
  );
  // budget_events: bare-text org column, no FK — the OTHER silent-orphan.
  await count(
    'budget_events',
    db.delete(budgetEvents).where(eq(budgetEvents.orgId, orgId)).returning({ orgId: budgetEvents.orgId }),
  );
  await count('budgets', db.delete(budgets).where(eq(budgets.orgId, orgId)).returning({ orgId: budgets.orgId }));
  await count(
    'custody_audit',
    db.delete(custodyAudit).where(eq(custodyAudit.orgId, orgId)).returning({ id: custodyAudit.id }),
  );
  await count(
    'auth_events',
    db.delete(authEvents).where(eq(authEvents.orgId, orgId)).returning({ id: authEvents.id }),
  );
  await count(
    'share_tokens',
    db.delete(shareTokens).where(eq(shareTokens.orgId, orgId)).returning({ id: shareTokens.id }),
  );
  await count(
    'provider_keys',
    db.delete(providerKeys).where(eq(providerKeys.orgId, orgId)).returning({ id: providerKeys.id }),
  );
  await count(
    'magic_links',
    db.delete(magicLinks).where(eq(magicLinks.orgId, orgId)).returning({ tokenHash: magicLinks.tokenHash }),
  );
  await count(
    'research_cycles',
    db.delete(researchCycles).where(eq(researchCycles.orgId, orgId)).returning({ id: researchCycles.id }),
  );
  await count(
    'eval_results',
    db.delete(evalResults).where(eq(evalResults.orgId, orgId)).returning({ cacheKey: evalResults.cacheKey }),
  );
  await count('eval_runs', db.delete(evalRuns).where(eq(evalRuns.orgId, orgId)).returning({ id: evalRuns.id }));

  // ---- 5. Tail transaction: identity + org row ----
  let usersErased = 0;
  await db.transaction(async (tx) => {
    const memberUserIds = (
      await tx.select({ userId: memberships.userId }).from(memberships).where(eq(memberships.orgId, orgId))
    ).map((r) => r.userId);
    const sessionRows = await tx
      .delete(sessions)
      .where(eq(sessions.orgId, orgId))
      .returning({ id: sessions.id });
    deleted.sessions = sessionRows.length;
    const memberRows = await tx
      .delete(memberships)
      .where(eq(memberships.orgId, orgId))
      .returning({ userId: memberships.userId });
    deleted.memberships = memberRows.length;
    // Orphaned users (erasure semantics — the carve-out is a legal-erasure
    // shape and users.email is UNIQUE PII): erase only users with ZERO
    // remaining memberships AND sessions anywhere.
    for (const userId of new Set(memberUserIds)) {
      const remainingMemberships = await tx
        .select({ orgId: memberships.orgId })
        .from(memberships)
        .where(eq(memberships.userId, userId))
        .limit(1);
      if (remainingMemberships.length > 0) continue;
      const remainingSessions = await tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.userId, userId))
        .limit(1);
      if (remainingSessions.length > 0) continue;
      await tx.delete(users).where(eq(users.id, userId));
      usersErased += 1;
    }
    await tx.delete(orgs).where(eq(orgs.id, orgId));
    deleted.orgs = 1;
  });

  return { orgId, alreadyDeleted: false, deleted, usersErased };
}
