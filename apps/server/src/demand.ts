// DEMAND LEARNING — the flush (S7 L2).
//
// The serve path accumulates in memory (context.demand) and never writes;
// this is the only place demand reaches the database. Two jobs: drain the
// accumulator into the k-gated merge, and refresh the opt-out set the serve
// path consults.
//
// Failure posture: a flush that throws LOSES that window's counts and logs
// it. That is deliberate. Under-counting demand delays a measurement;
// retrying a drained window would double-count it, and an inflated cell is a
// cell that could send money after a workload nobody actually has.
import { eq } from 'drizzle-orm';
import { mergeDemandDeltas, orgs, type MergeReport } from '@potion/db';
import type { PotionContext } from './context.js';

/** How often the accumulator is drained (ms). */
export const DEMAND_FLUSH_INTERVAL_MS = Number(process.env.POTION_DEMAND_FLUSH_MS ?? 60_000);

/**
 * Publication thresholds, overridable per deployment.
 *
 * Lowering them below the defaults is a deliberate operator act with a
 * privacy consequence — it is how a cell can be published while still
 * describing few enough customers to be recognizable. Left unset, the
 * library defaults (5 orgs / 20 requests) apply.
 */
export function publicationThresholds(): { minOrgs?: number; minRequests?: number } {
  const out: { minOrgs?: number; minRequests?: number } = {};
  const orgsEnv = process.env.POTION_DEMAND_MIN_ORGS;
  const reqEnv = process.env.POTION_DEMAND_MIN_REQUESTS;
  if (orgsEnv !== undefined && orgsEnv !== '') out.minOrgs = Number(orgsEnv);
  if (reqEnv !== undefined && reqEnv !== '') out.minRequests = Number(reqEnv);
  return out;
}

/** Is demand learning on at all for this deployment? Default: on. */
export function demandLearningEnabled(): boolean {
  return process.env.POTION_DEMAND_LEARNING !== '0';
}

/** Reload the opt-out set. Cheap: opted-out orgs only, ids only. */
export async function refreshDemandOptOut(ctx: PotionContext): Promise<void> {
  const rows = await ctx.db.db
    .select({ id: orgs.id })
    .from(orgs)
    .where(eq(orgs.demandLearningOptOut, true));
  ctx.demandOptOut.clear();
  for (const row of rows) ctx.demandOptOut.add(row.id);
}

export interface FlushReport extends MergeReport {
  /** Observations the cell cap turned away this window (see core/demand.ts).
   * Non-zero means this window under-counts demand — reported, never
   * silent. */
  dropped: number;
}

/** Drain the accumulator into the database, then refresh the opt-out set. */
export async function flushDemand(ctx: PotionContext): Promise<FlushReport> {
  const dropped = ctx.demand.dropped;
  const deltas = ctx.demand.drain();
  const report =
    deltas.length === 0
      ? { merged: 0, published: 0, withheld: 0 }
      : await mergeDemandDeltas(ctx.db.db, deltas, publicationThresholds());
  // After the merge, so an org that opted out mid-window stops contributing
  // from the next request onward.
  await refreshDemandOptOut(ctx);
  return { ...report, dropped };
}
