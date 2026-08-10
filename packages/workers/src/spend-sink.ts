// Per-call spend sink for job handlers (post-capstone item 1): adapts the
// harness SpendSink contract to the request_logs chokepoint. One row per
// successful provider call, written AS SPEND OCCURS — the handler completing
// (or not) no longer decides whether spend is billed. Rows use the existing
// spend statuses ('eval_live' / 'rubric_gen'), which the usage rollup already
// bills, so budgets and hard-stops see mid-run spend with no rollup change.
//
// The meter also accumulates in-memory totals (calls, per-provider sums) for
// the completion-time reconcile — completion RECONCILES the record, it is
// never the sole write (owner requirement, from the G2.8 under-metering and
// the $1.1045 cache-replay over-metering instances).
import type { Usage } from '@potion/core';
import { insertRequestLog, type PotionDb } from '@potion/db';
import { roundCost } from '@potion/core';
import type { SpendCall, SpendSink } from '@potion/harness';

export interface SpendMeter {
  sink: SpendSink;
  /** Successful provider calls metered so far. */
  calls: number;
  /** Σ per-call costUsd (rounded per call at the seam). */
  meteredUsd: number;
  /** Per-provider spend — the unit the operator ledger reconciles against
   * provider bills. */
  perProvider: Record<string, number>;
}

/**
 * Reconcile summary recorded on the run row at completion
 * (eval_runs.options.metering). deltaUsd = executedSpendUsd − meteredUsd;
 * the two sides legitimately differ by rounding accumulation order
 * (per-call rounding vs the strategies' round-per-accumulation), bounded
 * well under RECONCILE_TOLERANCE_USD per run. Anything larger is a metering
 * defect and warns loudly.
 */
export interface MeteringReconcile {
  calls: number;
  meteredUsd: number;
  perProvider: Record<string, number>;
  /** What the run actually spent (RunSummary.executedSpendUsd). */
  executedSpendUsd: number;
  /** What the evidence would have cost (RunSummary.spendUsd, cache-inclusive)
   * — recorded so the two never get conflated again. */
  evidenceCostUsd: number;
  deltaUsd: number;
}

export const RECONCILE_TOLERANCE_USD = 1e-5;

/** A meter whose sink writes one request_logs row per provider call. The
 * insert is awaited by the seam BEFORE the provider response returns, so a
 * process killed mid-run has already made every completed call durable. */
export function perCallRequestLogSink(
  db: PotionDb,
  opts: { orgId: string; clusterId?: string; status: 'eval_live' | 'rubric_gen' },
): SpendMeter {
  const meter: SpendMeter = {
    calls: 0,
    meteredUsd: 0,
    perProvider: {},
    sink: async (c: SpendCall) => {
      await insertRequestLog(db, {
        orgId: opts.orgId,
        ...(opts.clusterId !== undefined ? { clusterId: opts.clusterId } : {}),
        model: c.model,
        provider: c.provider,
        usage: {
          inputTokens: c.inputTokens,
          outputTokens: c.outputTokens,
          costUsd: c.costUsd,
          latencyMs: c.latencyMs,
        } as Usage,
        latencyMs: c.latencyMs,
        status: opts.status,
      });
      meter.calls += 1;
      meter.meteredUsd = roundCost(meter.meteredUsd + c.costUsd);
      meter.perProvider[c.provider] = roundCost((meter.perProvider[c.provider] ?? 0) + c.costUsd);
    },
  };
  return meter;
}

/** Build the completion-time reconcile record and warn past tolerance. */
export function reconcileMetering(
  meter: SpendMeter,
  run: { executedSpendUsd: number; spendUsd: number },
  label: string,
): MeteringReconcile {
  const deltaUsd = roundCost(run.executedSpendUsd - meter.meteredUsd);
  if (Math.abs(deltaUsd) > RECONCILE_TOLERANCE_USD) {
    console.warn(
      `[metering] ${label}: executed spend $${run.executedSpendUsd.toFixed(6)} vs metered ` +
        `$${meter.meteredUsd.toFixed(6)} (delta $${deltaUsd.toFixed(6)}) exceeds tolerance — ` +
        'under-metering hides spend from hard-stop caps; over-metering bills spend that never occurred',
    );
  }
  return {
    calls: meter.calls,
    meteredUsd: meter.meteredUsd,
    perProvider: meter.perProvider,
    executedSpendUsd: run.executedSpendUsd,
    evidenceCostUsd: run.spendUsd,
    deltaUsd,
  };
}
