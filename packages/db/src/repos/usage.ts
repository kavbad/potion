// Usage rollup repository (M2 Wave 2, ROADMAP #18, migration 0006).
//
// usage_daily is the billing/usage source of truth at (org, UTC day,
// cluster) grain. It is populated ONLY by the idempotent batch rollup
// aggregateUsage() below — the chat path NEVER writes to it.
//
// Why batch-only (documented decision): the serve path stays side-effect
// free apart from the single request_logs insert it already does — no hot-
// path upsert contention, no partial-failure mode where a chat succeeds but
// its meter write fails, and the rollup is trivially re-runnable to repair
// or backfill. Realtime write-through (or a queue consumer) is a later
// decision once an operator needs sub-day freshness; /api/usage/current
// already covers the in-flight day by reading request_logs live.
//
// Cost columns: platform_cost_usd is our price-table cost of served usage
// (summed from request_logs.usage->>'costUsd'). cost_usd is the customer-
// facing number — pricing v1 is pass-through (margin 0), so the rollup
// writes the same value; the configurable margin applies at invoice time
// (apps/server/src/billing, `[●]` pricing decision documented there).
import { and, asc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import type { PotionDb } from '../db.js';
import { usageDaily, type UsageDailyRow } from '../schema.js';

/** A UTC day range, inclusive on both ends, 'YYYY-MM-DD'. */
export interface UsageRange {
  fromDay: string;
  toDay: string;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDayString(s: string): boolean {
  return DAY_RE.test(s);
}

export function assertDayRange(range: UsageRange): void {
  if (!isDayString(range.fromDay) || !isDayString(range.toDay)) {
    throw new Error(
      `days must be YYYY-MM-DD (got ${range.fromDay}..${range.toDay})`,
    );
  }
}

/** Today's UTC day string ('YYYY-MM-DD'). */
export function utcDay(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/** First day of a 'YYYY-MM' period. */
export function periodFromDay(period: string): string {
  return `${period}-01`;
}

/** Last day of a 'YYYY-MM' period (UTC; no timezone drift — pure math). */
export function periodToDay(period: string): string {
  const [y, m] = period.split('-').map((x) => Number(x));
  if (!y || !m || m < 1 || m > 12) throw new Error(`invalid period '${period}' (want YYYY-MM)`);
  // Day 0 of the next month = last day of this month.
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

export function isPeriodString(s: string): boolean {
  return /^\d{4}-\d{2}$/.test(s);
}

/** Rollup grain row: one request_logs group for one org/day/cluster. */
export interface UsageRollupRow {
  orgId: string;
  day: string;
  clusterId: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** COGS: what Potion paid the provider. Equal to costUsd — the two diverge
   *  at INVOICE time via margin, not here (BYOK is no longer offered). */
  platformCostUsd: number;
  /** S3: what the same traffic would have cost on the highest-quality point.
   *  The counterfactual for outcome pricing; 0 where nothing recorded one. */
  baselineCostUsd: number;
}

/** Totals over a range (the shape /api/usage/current and invoices total). */
export interface UsageTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  platformCostUsd: number;
  baselineCostUsd: number;
}

// The rollup SELECT shared by aggregateUsage (writes usage_daily) and
// liveUsageRollup (reads only, for the in-flight day). Status filter: only
// 'ok' rows are billable served usage — 4xx/429/5xx rows carry no usage and
// are excluded (they remain auditable in request_logs). Days are UTC.
/**
 * Rollup contract (G0.1): `requests` and token counts cover SERVED traffic
 * only (status='ok'). Cost sums ALSO include status='guarantee_judge' rows —
 * the guarantee's judge-scoring calls are real org-attributable spend that
 * budgets and invoices must see, but they are scoring overhead, not served
 * requests, so counting them as requests/tokens would misstate usage.
 * status='rubric_gen' (G1.5) follows the same rule: rubric-generation and
 * probe-calibration LLM calls are org-attributable overhead spend.
 * status='eval_live' (G1.7) likewise: live eval-sweep spend on customer
 * suites — customer-attributable, flows into budgets/hard-stops/forecasts/
 * invoices via this single chokepoint. (Invoice wart, pre-existing: cost-
 * only clusters render quantity-0 lines labeled "routed requests" — the
 * relabel is G2.1 scope.)
 *
 * S3 (migration 0039) adds `baseline_cost_usd`: what the same traffic would
 * have cost on the highest-quality point — the counterfactual behind
 * outcome-based pricing. Summed only over rows that actually recorded one, so
 * a period with partial coverage under-reports the baseline rather than
 * fabricating it.
 *
 * G1 holdout rows are excluded from THAT SUM ONLY (`AND NOT holdout`). A
 * holdout row IS the baseline, so it can never contribute one — schema.ts
 * says so on the column, and chat.ts refuses to write one. This is the second
 * lock on the same door: the writer is one call site, this sum is the only
 * reader that reaches an invoice, and a phantom baseline here becomes
 * `projectedSavedUsd` on a customer's bill. It also REPAIRS: the upsert
 * full-replaces the window, so re-rolling a period drops any phantom a
 * pre-fix serve path already recorded. Requests, tokens and cost stay
 * unfiltered — a held-out request really was served and really cost money.
 *
 * `platform_cost_usd` deliberately stays equal to `cost_usd`. It is COGS —
 * what Potion paid the provider — and the two diverge at INVOICE time via
 * margin, not here. An earlier S3 pass filtered it to paid_by='platform' to
 * exclude BYOK spend; BYOK is no longer offered, so that filter excluded
 * nothing real while silently zeroing every pre-0039 row's COGS.
 *
 * NOTE for future edits: keep `--` line comments OUT of the sql template
 * below. Drizzle renders the template around its parameter placeholders and a
 * line comment there swallowed the remainder of the statement, which surfaces
 * as the unhelpful "syntax error at end of input".
 */
function rollupQuery(range: UsageRange, orgId?: string): SQL {
  return sql`
    SELECT org_id,
           to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
           coalesce(cluster_id, 'unassigned') AS cluster_id,
           count(*) FILTER (WHERE status = 'ok')::int AS requests,
           coalesce(sum((usage->>'inputTokens')::numeric) FILTER (WHERE status = 'ok'), 0)::int AS input_tokens,
           coalesce(sum((usage->>'outputTokens')::numeric) FILTER (WHERE status = 'ok'), 0)::int AS output_tokens,
           coalesce(sum((usage->>'costUsd')::numeric), 0)::float8 AS cost_usd,
           coalesce(sum((usage->>'costUsd')::numeric), 0)::float8 AS platform_cost_usd,
           coalesce(sum(baseline_cost_usd) FILTER (WHERE status = 'ok' AND NOT holdout), 0)::float8 AS baseline_cost_usd
    FROM request_logs
    WHERE status IN ('ok', 'guarantee_judge', 'rubric_gen', 'eval_live')
      AND to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD') BETWEEN ${range.fromDay} AND ${range.toDay}
      ${orgId !== undefined ? sql`AND org_id = ${orgId}` : sql``}
    GROUP BY 1, 2, 3
  `;
}

function toRollupRow(r: Record<string, unknown>): UsageRollupRow {
  return {
    orgId: String(r.org_id),
    day: String(r.day),
    clusterId: String(r.cluster_id),
    requests: Number(r.requests),
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    costUsd: Number(r.cost_usd),
    platformCostUsd: Number(r.platform_cost_usd),
    baselineCostUsd: Number(r.baseline_cost_usd),
  };
}

/**
 * Roll up request_logs → usage_daily for [fromDay, toDay] (UTC days,
 * inclusive). IDEMPOTENT: rows in the window are full-replaced (INSERT … ON
 * CONFLICT DO UPDATE), so re-running for the same window always converges to
 * the same state. Returns the rollup rows written.
 *
 * Scoping note: a day whose request_logs rows were ALL deleted after a
 * previous rollup keeps its stale usage_daily row (the upsert only touches
 * groups present in request_logs). request_logs is append-only in practice;
 * a repair sweep can DELETE from usage_daily in the window first if that
 * invariant ever changes.
 */
export async function aggregateUsage(
  db: PotionDb,
  range: UsageRange,
  /** G2.4: scope the refresh to ONE org. The customer-reachable invoice path
   * passes its own org so a viewer-grade GET can never rewrite every
   * tenant's rollup; the batch CLI/admin trigger omits it (global). */
  orgId?: string,
): Promise<UsageRollupRow[]> {
  assertDayRange(range);
  const rolled = await db.execute(rollupQuery(range, orgId));
  const rows = (rolled.rows as Array<Record<string, unknown>>).map(toRollupRow);
  for (const r of rows) {
    await db
      .insert(usageDaily)
      .values({
        orgId: r.orgId,
        day: r.day,
        clusterId: r.clusterId,
        requests: r.requests,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        costUsd: r.costUsd,
        platformCostUsd: r.platformCostUsd,
        baselineCostUsd: r.baselineCostUsd,
      })
      .onConflictDoUpdate({
        target: [usageDaily.orgId, usageDaily.day, usageDaily.clusterId],
        set: {
          requests: r.requests,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          costUsd: r.costUsd,
          platformCostUsd: r.platformCostUsd,
          baselineCostUsd: r.baselineCostUsd,
        },
      });
  }
  return rows;
}

/**
 * The same rollup math as aggregateUsage but READ-ONLY (no usage_daily
 * write), org-scoped — the live path behind GET /api/usage/current, which
 * must see the in-flight day before the batch job has run.
 */
export async function liveUsageRollup(
  db: PotionDb,
  orgId: string,
  range: UsageRange,
): Promise<UsageRollupRow[]> {
  assertDayRange(range);
  const rolled = await db.execute(rollupQuery(range, orgId));
  return (rolled.rows as Array<Record<string, unknown>>).map(toRollupRow);
}

/** Sum a rollup row set into totals. */
export function sumRollup(rows: UsageRollupRow[]): UsageTotals {
  return rows.reduce<UsageTotals>(
    (acc, r) => ({
      requests: acc.requests + r.requests,
      inputTokens: acc.inputTokens + r.inputTokens,
      outputTokens: acc.outputTokens + r.outputTokens,
      costUsd: acc.costUsd + r.costUsd,
      platformCostUsd: acc.platformCostUsd + r.platformCostUsd,
      baselineCostUsd: acc.baselineCostUsd + r.baselineCostUsd,
    }),
    { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, platformCostUsd: 0, baselineCostUsd: 0 },
  );
}

/** usage_daily rows for one org in [fromDay, toDay], day-then-cluster order. */
export async function listUsageDaily(
  db: PotionDb,
  orgId: string,
  range: UsageRange,
): Promise<UsageDailyRow[]> {
  assertDayRange(range);
  return db
    .select()
    .from(usageDaily)
    .where(
      and(
        eq(usageDaily.orgId, orgId),
        gte(usageDaily.day, range.fromDay),
        lte(usageDaily.day, range.toDay),
      ),
    )
    .orderBy(asc(usageDaily.day), asc(usageDaily.clusterId));
}
