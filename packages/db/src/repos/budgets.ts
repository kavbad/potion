// Budget autopilot repository + pure math (M4, ROADMAP #35, SPEC §13.7,
// migration 0011).
//
//   budgets       — one row per org (pk). hardStop=false (SOFT cap, the
//     default) NEVER blocks serving; hardStop=true fails closed at the cap
//     (the serving-path gate lives in apps/server/src/budget.ts, MTD cached
//     60s per org). warnPct drives the warn crossing (percentage of cap).
//   budget_events — the budget:evaluate worker's DEDUP LEDGER (documented
//     choice, SPEC §13.7): one row per (org, kind, UTC day), inserted ON
//     CONFLICT DO NOTHING — the worker emits the alert only when the insert
//     landed, so each kind fires at most once per org per day.
//
// Spend numbers come from request_logs via liveUsageRollup (the SAME
// customer-facing rollup behind /api/usage/current — status='ok' rows,
// usage->>'costUsd', UTC days), so the cap compares against exactly what
// the usage page shows.
import { desc, eq } from 'drizzle-orm';
import type { PotionDb } from '../db.js';
import {
  budgetEvents,
  budgets,
  type BudgetEventKind,
  type BudgetEventRow,
  type BudgetRow,
} from '../schema.js';
import { liveUsageRollup, utcDay } from './usage.js';

// ---------------------------------------------------------------------------
// budgets
// ---------------------------------------------------------------------------

/** The org's budget row, or null when none is configured. */
export async function getBudget(db: PotionDb, orgId: string): Promise<BudgetRow | null> {
  const rows = await db.select().from(budgets).where(eq(budgets.orgId, orgId)).limit(1);
  return rows[0] ?? null;
}

/** All budget rows (the budget:evaluate worker's sweep set). */
export async function listBudgets(db: PotionDb): Promise<BudgetRow[]> {
  return db.select().from(budgets);
}

/** Create or replace the org's budget (updated_at refreshed). */
export async function upsertBudget(
  db: PotionDb,
  row: { orgId: string; monthlyCapUsd: number; hardStop: boolean; warnPct: number },
): Promise<BudgetRow> {
  const upserted = await db
    .insert(budgets)
    .values({ ...row, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: budgets.orgId,
      set: {
        monthlyCapUsd: row.monthlyCapUsd,
        hardStop: row.hardStop,
        warnPct: row.warnPct,
        updatedAt: new Date(),
      },
    })
    .returning();
  return upserted[0]!;
}

// ---------------------------------------------------------------------------
// spend series (request_logs, UTC days)
// ---------------------------------------------------------------------------

/**
 * Per-day customer-facing spend for an org over [fromDay, toDay] (UTC,
 * inclusive), ZERO-FILLED for days with no served usage — the budget
 * anomaly math needs a complete series.
 */
export async function dailySpendSeries(
  db: PotionDb,
  orgId: string,
  range: { fromDay: string; toDay: string },
): Promise<Array<{ day: string; costUsd: number }>> {
  const rows = await liveUsageRollup(db, orgId, range);
  const byDay = new Map<string, number>();
  for (const r of rows) byDay.set(r.day, (byDay.get(r.day) ?? 0) + r.costUsd);
  const out: Array<{ day: string; costUsd: number }> = [];
  const cursor = new Date(`${range.fromDay}T00:00:00Z`);
  const end = new Date(`${range.toDay}T00:00:00Z`);
  while (cursor.getTime() <= end.getTime()) {
    const day = cursor.toISOString().slice(0, 10);
    out.push({ day, costUsd: byDay.get(day) ?? 0 });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/** Month-to-date customer-facing spend (1st of the UTC month → today). */
export async function mtdSpendUsd(
  db: PotionDb,
  orgId: string,
  now: Date = new Date(),
): Promise<number> {
  const today = utcDay(now);
  const rows = await liveUsageRollup(db, orgId, { fromDay: `${today.slice(0, 7)}-01`, toDay: today });
  return rows.reduce((sum, r) => sum + r.costUsd, 0);
}

// ---------------------------------------------------------------------------
// pure math (unit-tested directly; shared by the worker + the API + the
// dashboard payload)
// ---------------------------------------------------------------------------

/** Days in the UTC month containing `now`. */
export function daysInUtcMonth(now: Date): number {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
}

/**
 * MTD linear forecast (SPEC §13.7): straight-line extrapolation of MTD
 * spend to month end — mtd × (daysInMonth / dayOfMonth).
 */
export function forecastMtdUsd(mtd: number, now: Date = new Date()): number {
  const dayOfMonth = now.getUTCDate();
  return mtd * (daysInUtcMonth(now) / dayOfMonth);
}

/** The warn crossing in USD: warn_pct% of the cap. */
export function warnAtUsd(capUsd: number, warnPct: number): number {
  return capUsd * (warnPct / 100);
}

export interface SpendZScore {
  /** (mean7 − mean30) / std30 — positive = spending faster than trailing. */
  z: number;
  mean7: number;
  mean30: number;
  /** Population stddev of the trailing window. */
  std30: number;
}

/**
 * Z-score of the last-7-day daily-spend mean against the trailing 30-day
 * daily-spend distribution (SPEC §13.7). Returns null when the signal is
 * undefined — empty trailing window or std30 = 0 (perfectly steady spend
 * has no meaningful z; the forecast/warn crossings still fire).
 */
export function spendZScore(last7Daily: number[], trailing30Daily: number[]): SpendZScore | null {
  if (last7Daily.length === 0 || trailing30Daily.length === 0) return null;
  const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
  const mean7 = mean(last7Daily);
  const mean30 = mean(trailing30Daily);
  const variance =
    trailing30Daily.reduce((s, x) => s + (x - mean30) ** 2, 0) / trailing30Daily.length;
  const std30 = Math.sqrt(variance);
  if (std30 === 0) return null;
  return { z: (mean7 - mean30) / std30, mean7, mean30, std30 };
}

/** SPEC §13.7 anomaly threshold. */
export const BUDGET_ZSCORE_THRESHOLD = 2.5;

// ---------------------------------------------------------------------------
// budget_events (dedup ledger)
// ---------------------------------------------------------------------------

/**
 * Record a budget event for (org, kind, UTC day), deduped: returns true
 * ONLY when the row was actually inserted (first occurrence today). The
 * budget:evaluate worker emits the alerts:dispatch only on true, so each
 * kind fires at most once per org per day regardless of how often the
 * evaluator runs.
 */
export async function recordBudgetEvent(
  db: PotionDb,
  row: { orgId: string; kind: BudgetEventKind; day?: string },
  now: Date = new Date(),
): Promise<boolean> {
  const day = row.day ?? utcDay(now);
  const inserted = await db
    .insert(budgetEvents)
    .values({ orgId: row.orgId, kind: row.kind, day })
    .onConflictDoNothing()
    .returning({ orgId: budgetEvents.orgId });
  return inserted.length > 0;
}

/** Recent budget events for an org (status/tests), newest first. */
export async function listBudgetEvents(
  db: PotionDb,
  orgId: string,
  limit = 50,
): Promise<BudgetEventRow[]> {
  return db
    .select()
    .from(budgetEvents)
    .where(eq(budgetEvents.orgId, orgId))
    .orderBy(desc(budgetEvents.createdAt))
    .limit(limit);
}
