// Thin typed repository for request_logs (SPEC §7/§8; ORG-SCOPED since M2
// Wave 1 / ROADMAP #13). Rows carry org_id NOT NULL — including
// unauthenticated traffic, which the server attributes to the default org.
import { and, desc, eq, sql } from 'drizzle-orm';
import type { PotionDb } from '../db.js';
import { requestLogs, type NewRequestLog, type RequestLogRow } from '../schema.js';

/** Insert a request-log row (row.orgId is required by the schema). */
export async function insertRequestLog(db: PotionDb, log: NewRequestLog): Promise<bigint> {
  const rows = await db.insert(requestLogs).values(log).returning({ id: requestLogs.id });
  const row = rows[0];
  if (!row) throw new Error('insertRequestLog: no id returned');
  return row.id;
}

export async function listRequestLogs(
  db: PotionDb,
  orgId: string,
  limit = 100,
): Promise<RequestLogRow[]> {
  return db
    .select()
    .from(requestLogs)
    .where(eq(requestLogs.orgId, orgId))
    .orderBy(desc(requestLogs.id))
    .limit(limit);
}

/** The routing facts of one SERVED request, looked up by completion id —
 * the Outcome API's ingest-time attribution (newest row wins on the
 * pathological duplicate). null = no served request with that id. */
export async function servedRequestRouting(
  db: PotionDb,
  orgId: string,
  completionId: string,
): Promise<{ clusterId: string | null; strategyHash: string | null; routerVersion: number | null } | null> {
  const rows = await db
    .select({
      clusterId: requestLogs.clusterId,
      strategyHash: requestLogs.strategyHash,
      routerVersion: requestLogs.routerVersion,
    })
    .from(requestLogs)
    .where(
      and(
        eq(requestLogs.orgId, orgId),
        eq(requestLogs.completionId, completionId),
        eq(requestLogs.status, 'ok'),
      ),
    )
    .orderBy(desc(requestLogs.id))
    .limit(1);
  return rows[0] ?? null;
}

export interface ServedClusterCostRow {
  clusterId: string;
  /** Mean ACTUAL cost per served request over the window. */
  meanCostUsd: number;
  requests: number;
}

/**
 * Measured serving cost per cluster since `since` (status='ok' rows with a
 * recorded cost). The shadow-evidence comparison basis (2026-09-01):
 * challenger costs are measured actuals on the org's own traffic, so the
 * serving side of the compare must be measured actuals too — putting a
 * SUITE-average costPer1K on one side of the inequality would mix
 * measurement bases (the savings-baseline critique, same class).
 */
export async function servedClusterCostSince(
  db: PotionDb,
  orgId: string,
  since: Date,
): Promise<ServedClusterCostRow[]> {
  const result = await db.execute(
    sql`SELECT cluster_id,
               avg((usage->>'costUsd')::float) AS mean_cost_usd,
               count(*)::int AS requests
        FROM request_logs
        WHERE org_id = ${orgId}
          AND status = 'ok'
          AND cluster_id IS NOT NULL
          AND usage->>'costUsd' IS NOT NULL
          AND ts > ${since.toISOString()}::timestamptz
        GROUP BY cluster_id`,
  );
  return (result.rows as Array<{ cluster_id: string; mean_cost_usd: number | string; requests: number }>).map(
    (r) => ({ clusterId: r.cluster_id, meanCostUsd: Number(r.mean_cost_usd), requests: r.requests }),
  );
}

/**
 * Serving-grade p95 latency per strategy (G2.6).
 *
 * WHY percentile_disc AND NOT percentile_cont: percentile_disc returns the
 * ceil(p·n)-th ORDER STATISTIC — provably the same quantity
 * quantileNearestRank computes in TypeScript. percentile_cont INTERPOLATES
 * between order statistics and is a different estimator, so a p95 read from
 * SQL and a p95 computed in the harness would differ for reasons that have
 * nothing to do with the underlying latency. The parity is a testable claim,
 * and servingLatencyParity in this package's tests is the test.
 *
 * status = 'ok' only: guarantee_judge / rubric_gen / eval_live rows carry a
 * latency_ms but are not served traffic. Letting platform work into a
 * customer's p95 would let Potion's own background jobs breach the customer's
 * SLO — the exact confusion the span distinction exists to prevent.
 *
 * NULL latency_ms rows are excluded by percentile_disc's own NULL handling;
 * `n` counts only the rows that contributed, so the caller's minimum-sample
 * gate sees the true evidence count rather than a row count.
 */
export async function servingLatencyP95(
  db: PotionDb,
  orgId: string,
  clusterId: string,
  windowMin: number,
  now: Date = new Date(),
): Promise<ServingLatencyRow[]> {
  const since = new Date(now.getTime() - windowMin * 60_000);
  const res = await db.execute(sql`
    SELECT strategy_hash AS strategy_hash,
           percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_ms,
           count(latency_ms) AS n
      FROM request_logs
     WHERE org_id = ${orgId}
       AND cluster_id = ${clusterId}
       AND status = 'ok'
       AND strategy_hash IS NOT NULL
       AND latency_ms IS NOT NULL
       AND ts >= ${since.toISOString()}
     GROUP BY strategy_hash
  `);
  const out: ServingLatencyRow[] = [];
  for (const r of res.rows as Array<Record<string, unknown>>) {
    const p95 = Number(r.p95_ms);
    const n = Number(r.n);
    if (!Number.isFinite(p95) || n <= 0) continue;
    out.push({ strategyHash: String(r.strategy_hash), p95Ms: p95, n });
  }
  return out;
}

export interface ServingLatencyRow {
  strategyHash: string;
  p95Ms: number;
  n: number;
}

/**
 * Degenerate-serving counts per strategy (2026-09-01, the or-gemini-flash
 * incident): how many of this org's served requests on this cluster came
 * back with ZERO completion tokens in the window. A zero-token 'ok' is a
 * response the customer paid to route and got nothing from — a suite score
 * cannot see it (the flagship's route was measured q=1.0 on its instrument
 * while returning six consecutive empties in production). status='ok' only,
 * same reasoning as servingLatencyP95: platform jobs never speak for a
 * customer's traffic.
 */
export async function servingDegenerateCounts(
  db: PotionDb,
  orgId: string,
  clusterId: string,
  windowMin: number,
  now: Date = new Date(),
): Promise<ServingDegeneracyRow[]> {
  const since = new Date(now.getTime() - windowMin * 60_000);
  const res = await db.execute(sql`
    SELECT strategy_hash AS strategy_hash,
           count(*) AS total,
           count(*) FILTER (WHERE (usage->>'completionTokens')::float = 0) AS empty
      FROM request_logs
     WHERE org_id = ${orgId}
       AND cluster_id = ${clusterId}
       AND status = 'ok'
       AND strategy_hash IS NOT NULL
       AND usage->>'completionTokens' IS NOT NULL
       AND ts >= ${since.toISOString()}
     GROUP BY strategy_hash
  `);
  const out: ServingDegeneracyRow[] = [];
  for (const r of res.rows as Array<Record<string, unknown>>) {
    const total = Number(r.total);
    const empty = Number(r.empty);
    if (!Number.isFinite(total) || total <= 0) continue;
    out.push({ strategyHash: String(r.strategy_hash), total, empty });
  }
  return out;
}

export interface ServingDegeneracyRow {
  strategyHash: string;
  total: number;
  empty: number;
}

/**
 * Realized served volume and spend per (policy, cluster) over a day range
 * (G2.6) — the denominator of the guarantee report's REALIZED latency
 * premium. The DTO answers "what is the bound costing per 1K"; the report
 * answers "what did the bound cost this month, in dollars", and that needs
 * the month's actual requests and actual spend, not a projection.
 *
 * status='ok' only, matching servingLatencyP95: platform work is not the
 * customer's traffic, on either side of the comparison.
 */
export async function servedSpendByPolicyCluster(
  db: PotionDb,
  orgId: string,
  fromDay: string,
  toDay: string,
): Promise<ServedSpendRow[]> {
  const res = await db.execute(sql`
    SELECT policy_id       AS policy_id,
           cluster_id      AS cluster_id,
           strategy_hash   AS strategy_hash,
           count(*)        AS requests,
           coalesce(sum((usage ->> 'costUsd')::double precision), 0) AS cost_usd
      FROM request_logs
     WHERE org_id = ${orgId}
       AND status = 'ok'
       AND policy_id IS NOT NULL
       AND cluster_id IS NOT NULL
       AND ts >= ${`${fromDay}T00:00:00Z`}
       AND ts <  ${`${toDay}T23:59:59.999Z`}
     GROUP BY policy_id, cluster_id, strategy_hash
  `);
  return (res.rows as Array<Record<string, unknown>>).map((r) => ({
    policyId: String(r.policy_id),
    clusterId: String(r.cluster_id),
    strategyHash: r.strategy_hash === null ? null : String(r.strategy_hash),
    requests: Number(r.requests),
    costUsd: Number(r.cost_usd),
  }));
}

export interface ServedSpendRow {
  policyId: string;
  clusterId: string;
  strategyHash: string | null;
  requests: number;
  costUsd: number;
}

/**
 * What the learning period cost this org (status = 'eval_live' rows carry
 * the per-call metering of measuring the org's own workloads). Billed to the
 * org's usage since 2026-08-22, so it must be visible to the org.
 */
export async function measurementSpendUsd(db: PotionDb, orgId: string, fromDay: string, toDay: string): Promise<number> {
  const rows = await db.execute(sql`
    SELECT coalesce(sum((usage ->> 'costUsd')::double precision), 0) AS cost_usd
      FROM request_logs
     WHERE org_id = ${orgId}
       AND status = 'eval_live'
       AND ts >= ${fromDay}::date
       AND ts < (${toDay}::date + interval '1 day')
  `);
  const r = (rows.rows as Array<{ cost_usd: number | string }>)[0];
  return Number(r?.cost_usd ?? 0);
}
