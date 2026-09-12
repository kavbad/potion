// MEASUREMENT BUDGET — Potion's own cost of measuring a customer, bounded.
//
// Operator (2026-09-11): measurement is covered by Potion, not billed to the
// customer. That turns the learning period's spend from a line on someone
// else's invoice into our cost of goods, and cost of goods gets a ceiling
// sized to the revenue it serves. Before this the only bound was a flat
// $3/org/day that (a) read the wrong ledger — learning_proposals.spend_usd,
// which discovery and failed runs never wrote to — and (b) did not scale:
// one org's serving traffic was $0.51 for the month and its measurement
// $2.95.
//
// THE RULE. Per org per calendar month, measurement may spend
//   clamp(MEASUREMENT_SHARE_OF_SERVING × serving spend over the trailing
//         30 days, MEASUREMENT_MONTHLY_FLOOR_USD, MEASUREMENT_MONTHLY_CAP_USD)
// on top of the existing daily cap. The floor lets a brand-new org be
// measured at all; the share keeps it proportional; the cap is the old
// daily cap × 10, a number a human can defend. Both caps read the request
// log (status eval_live) — where the money is actually recorded — so
// discovery and refused runs count.
import type { PotionDb } from '@potion/db';
import { measurementSpendSince, servingSpendSince } from '@potion/db';

export const LEARNING_PERIOD_DAILY_CAP_USD = 3;
export const MEASUREMENT_SHARE_OF_SERVING = 0.25;
export const MEASUREMENT_MONTHLY_FLOOR_USD = 1;
export const MEASUREMENT_MONTHLY_CAP_USD = 30;

export interface MeasurementBudget {
  /** What may still be spent right now: min(daily remaining, monthly remaining). */
  remainingUsd: number;
  /** The month's ceiling, sized to trailing serving spend. */
  ceilingUsd: number;
  servingUsd30d: number;
  spentMonthUsd: number;
  spentTodayUsd: number;
  /** Which bound is binding when remainingUsd is exhausted. */
  exhausted: 'daily' | 'monthly' | null;
}

export function measurementCeilingUsd(servingUsd30d: number): number {
  const share = MEASUREMENT_SHARE_OF_SERVING * Math.max(0, servingUsd30d);
  return Math.max(MEASUREMENT_MONTHLY_FLOOR_USD, Math.min(MEASUREMENT_MONTHLY_CAP_USD, share));
}

export async function measurementBudgetFor(db: PotionDb, orgId: string, now = new Date()): Promise<MeasurementBudget> {
  const dayAgo = new Date(now.getTime() - 24 * 3600 * 1000);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
  const [spentTodayUsd, spentMonthUsd, servingUsd30d] = await Promise.all([
    measurementSpendSince(db, orgId, dayAgo),
    measurementSpendSince(db, orgId, monthStart),
    servingSpendSince(db, orgId, thirtyDaysAgo),
  ]);
  const ceilingUsd = measurementCeilingUsd(servingUsd30d);
  const dailyLeft = LEARNING_PERIOD_DAILY_CAP_USD - spentTodayUsd;
  const monthlyLeft = ceilingUsd - spentMonthUsd;
  const remainingUsd = Math.max(0, Math.min(dailyLeft, monthlyLeft));
  const exhausted = remainingUsd > 0.05 ? null : dailyLeft <= monthlyLeft ? 'daily' : 'monthly';
  return { remainingUsd, ceilingUsd, servingUsd30d, spentMonthUsd, spentTodayUsd, exhausted };
}

/** A one-line reason for a skipped measurement, for reports and logs. */
export function budgetExhaustedReason(b: MeasurementBudget): string {
  return b.exhausted === 'monthly'
    ? `monthly measurement ceiling reached ($${b.spentMonthUsd.toFixed(2)} of $${b.ceilingUsd.toFixed(2)}, sized to $${b.servingUsd30d.toFixed(2)} of serving over 30 days)`
    : `daily measurement cap reached ($${b.spentTodayUsd.toFixed(2)} of $${LEARNING_PERIOD_DAILY_CAP_USD.toFixed(2)})`;
}
