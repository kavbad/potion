// Shared ground for the job handlers (2026-09-09).
//
// A PURE MOVE out of handlers.ts, which had reached 6,709 lines. Nothing here
// is new and no logic changed: these are the declarations more than one
// handler module needs, lifted so extracted modules can import them WITHOUT
// importing handlers.ts back. A cycle would leave module-init-time constants
// at the mercy of import order — not a trade worth making for a refactor
// whose whole point is to change nothing.
//
// registryPrices is exported HERE but deliberately NOT re-exported from
// handlers.ts: it was private before the split, and a pure move must not
// widen the public surface.

import { type PriceTable } from '@potion/core';
import { loadModelRegistry, type DbHandle, type PotionDb } from '@potion/db';
import { type PotionQueue } from '@potion/queue';
import { loadPrices } from '@potion/providers';
import {  } from '@potion/harness';
import {  } from 'drizzle-orm';
import { type ArtifactStore } from '@potion/artifacts';
import { type JobPayloads } from './jobs.js';

/**
 * The price table every handler should read: THE REGISTRY, from the database.
 *
 * S5 moved the catalog out of prices.json, which a scan used to grow with
 * writeFileSync — so discoveries died on the next redeploy and never reached
 * the running process. Reading the db here is what makes a scan take effect
 * IMMEDIATELY, in-process, for every later cycle and sweep in the same run.
 *
 * It also fixes a bug this move introduced and an existing test caught: the
 * scan diffed new listings against the FILE. With writes redirected to the
 * database, the file never changed, so every re-scan would have re-discovered
 * the same models forever and re-enqueued a cycle for each.
 *
 * Falls back to the file when the registry is empty or unreadable. A stale
 * catalog is a worse answer than a fresh one and a far better answer than
 * none — an empty price table resolves no models at all.
 */
export async function registryPrices(ctx: { db: PotionDb; pricesPath: string }): Promise<PriceTable> {
  try {
    const registry = await loadModelRegistry(ctx.db);
    if (registry) return registry as PriceTable;
  } catch {
    // fall through to the seed file
  }
  return loadPrices(ctx.pricesPath).table;
}

/** Everything a handler needs beyond its payload. */
export interface JobContext {
  db: PotionDb;
  dbHandle: DbHandle;
  artifacts?: ArtifactStore | undefined;
  pricesPath: string;
  suitesDir?: string | undefined;
  /** M4 #33/#35: the queue the worker consumes on. Handlers that EMIT
   * follow-up jobs (guarantee:evaluate breach → alerts:dispatch;
   * budget:evaluate event → alerts:dispatch) enqueue here when present,
   * else fall back to the in-process path. */
  queue?: PotionQueue | undefined;
  /** M5 #36: platform embedder for agent-session clustering (structural
   * twin of @potion/cluster's Embedder — workers deliberately do not depend
   * on the cluster package). */
  embedder?: { embed(t: string[]): Promise<number[][]> } | undefined;
  /**
   * G2.8: which KIND of embedder the above is. The cosine threshold that
   * works for one is catastrophic for the other (G0.5: 96% @0.2 vs 6% @0.62
   * on real embeddings), and the handler cannot tell them apart by duck
   * typing. Absent → the handler warns rather than guesses.
   */
  embedderKind?: 'mock' | 'live' | undefined;
  /** M5 #36: dir for synthesized agent replay suites (suite v2 layout).
   * Default: the harness repo suites dir (SUITES_V2_DIR), mirroring the
   * prices.json precedent — tests/walkthrough override to a tmp copy. */
  suitesV2Dir?: string | undefined;
  /**
   * F10: which DELIVERY of the job this is. Absent when a handler is called
   * directly (tests, operator scripts) — such a call is deliberate by
   * construction, so the delivery guard lets it run unguarded.
   */
  delivery?: { jobId: string; attempt: number } | undefined;
}

/**
 * A job handler, keyed by job name.
 *
 * `R` carries the handler's RESULT type (2026-09-02). Every concrete handler
 * below already annotates its own return — `: Promise<EvalRunResult>` and so
 * on — but annotating the const as `WorkerHandler<'eval:run'>` erased that to
 * `unknown`, because the declared type of the binding wins. Anything reading a
 * handler's result (tests, operator scripts, the in-process callers) then got
 * `unknown` and had to cast its way back to the type the handler already
 * promised, which is how a fixture drifts out of shape unnoticed.
 *
 * Defaulted to `unknown`, so every existing `WorkerHandler<'job:name'>`
 * annotation keeps working unchanged; pass the second argument where the
 * result is read.
 */
export type WorkerHandler<K extends keyof JobPayloads = keyof JobPayloads, R = unknown> = (
  payload: JobPayloads[K],
  ctx: JobContext,
) => Promise<R>;

/** Consecutive NON-confident all-clears on a restore verify before
 * 'guarantee_recovery_unconfirmed' escalates for human review (owner
 * refinement: uncertainty never auto-restores and never silently persists). */
export const RECOVERY_UNCONFIRMED_AFTER = 3;

/**
 * Step items per cluster suite, filled session-ROUND-ROBIN in deterministic
 * session order so no long session monopolizes the suite. At the capstone
 * corpus (23 sessions × ~40 steps ≈ 920 raw) this yields 23×8 = 184 items —
 * the volume the cost projection in the item plan is computed against.
 * Selection happens HERE, in synthesis: the db-side roster cap is a sorted-id
 * prefix and would otherwise select steps by hash order.
 */
export const AGENT_SUITE_ITEM_CAP_V2 = 200;

export const LIVE_SWEEP_JUDGE_MAX_TOKENS = 768;

export const LIVE_SWEEP_ANSWER_MAX_TOKENS = 1600;
