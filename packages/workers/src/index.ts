// Worker runtime (SPEC §12.2): registers one handler per JobKind on a
// PotionQueue and lets it consume. Driver-agnostic — memory (default,
// in-process) or bullmq (REDIS_URL set; jobs then survive worker restarts).
import type { DbHandle, PotionDb } from '@potion/db';
import type { PotionQueue } from '@potion/queue';
import type { ArtifactStore } from '@potion/artifacts';
import {
  defaultHandlers,
  DEFAULT_PRICES_PATH,
  type JobContext,
  type WorkerHandler,
} from './handlers.js';
import { JOB_KINDS, type JobKind, type JobPayloads } from './jobs.js';

/** Accepts a full DbHandle (server context, tests) or a bare PotionDb. */
export type WorkerDb = DbHandle | PotionDb;

function asHandle(db: WorkerDb): DbHandle {
  if ('db' in db && typeof (db as DbHandle).close === 'function') return db as DbHandle;
  // Bare PotionDb: wrap without ownership (never closed by the runner).
  return { db: db as PotionDb, driver: 'pglite', close: async () => {} };
}

export interface RunWorkerOptions {
  queue: PotionQueue;
  db: WorkerDb;
  /** Override/replace individual handlers (tests, #21 shadow:judge later). */
  handlers?: Partial<{ [K in JobKind]: WorkerHandler<K> }>;
  /** Artifact sink for harness/sweep JSON (SPEC §12.2: "when configured"). */
  artifacts?: ArtifactStore;
  /** prices.json path (default: repo root). */
  pricesPath?: string;
  /** Suite dir override (tests); default: packages/harness/suites. */
  suitesDir?: string;
  /** M5 #36: platform embedder for traces:cluster (the server passes its
   * own dimension-guarded instance; tests inject a deterministic fake). */
  embedder?: { embed(t: string[]): Promise<number[][]> };
  /** M5 #36: suite v2 dir for synthesized agent replay suites (default:
   * POTION_SUITES_V2_DIR env, else the harness repo suites dir — the
   * prices.json precedent; tests/walkthrough override to a tmp copy). */
  suitesV2Dir?: string;
}

export interface WorkerHandle {
  /** The job kinds this worker consumes. */
  kinds: readonly JobKind[];
  /** The queue the worker is registered on (caller keeps ownership). */
  queue: PotionQueue;
  /** Stop consuming: closes the queue (memory: drains first; bullmq: drains
   * in-flight handlers then closes worker + queue). */
  close(): Promise<void>;
}

/**
 * Register all job handlers on `queue` and start consuming. With the memory
 * driver consumption is immediate and in-process; with bullmq a BullMQ Worker
 * is spun up on the first registerHandler (see packages/queue).
 */
export async function runWorker(opts: RunWorkerOptions): Promise<WorkerHandle> {
  const dbHandle = asHandle(opts.db);
  const ctx: JobContext = {
    db: dbHandle.db,
    dbHandle,
    artifacts: opts.artifacts,
    // POTION_PRICES_PATH lets research:scan persist registry diffs to a
    // non-default (e.g. tmp/walkthrough) prices.json without code changes.
    pricesPath: opts.pricesPath ?? process.env.POTION_PRICES_PATH ?? DEFAULT_PRICES_PATH,
    suitesDir: opts.suitesDir,
    // M5 #36: traces:cluster needs the platform embedder; suite synthesis
    // targets POTION_SUITES_V2_DIR when set (tmp copies in tests/walkthrough).
    embedder: opts.embedder,
    suitesV2Dir: opts.suitesV2Dir ?? process.env.POTION_SUITES_V2_DIR,
    // M4 #33/#35: handlers that emit follow-up jobs (alert dispatch on
    // guarantee breach / budget events) enqueue on this queue when present.
    queue: opts.queue,
  };
  const handlers = { ...defaultHandlers, ...(opts.handlers ?? {}) };
  for (const kind of JOB_KINDS) {
    const handler = handlers[kind] as WorkerHandler;
    opts.queue.registerHandler(kind, (payload: JobPayloads[JobKind]) => handler(payload, ctx));
  }
  return {
    kinds: JOB_KINDS,
    queue: opts.queue,
    close: async () => {
      await opts.queue.close();
    },
  };
}

export * from './jobs.js';
export {
  defaultHandlers,
  evalRunHandler,
  sweepRunHandler,
  stalenessScanHandler,
  shadowJudgeHandler,
  guaranteeEvaluateHandler,
  createGuaranteeEvaluateHandler,
  alertsDispatchHandler,
  dispatchAlertEvent,
  emitAlertEvent,
  alertSlackText,
  alertRequestBody,
  budgetEvaluateHandler,
  createBudgetEvaluateHandler,
  // ---- M4b #37 autoresearcher ----
  researchScanHandler,
  researchCycleHandler,
  RESEARCH_V2_SUITE_IDS,
  RESEARCH_SCAN_MAX_CYCLES,
  RESEARCH_CYCLE_DEFAULT_LIVE_CAP_USD,
  MOCK_CYCLE_BUDGET_CAP_USD,
  type ResearchScanResult,
  type ResearchCycleResult,
  type CyclePromotion,
  // ---- M5 #36 agent workloads ----
  tracesClusterHandler,
  tracesPurgeHandler,
  redactTraceText,
  toolSignatureSlug,
  TRACES_CLUSTER_DEFAULT_SINCE_DAYS,
  TRACES_CLUSTER_DEFAULT_LIMIT,
  AGENT_CLUSTER_COSINE_THRESHOLD,
  AGENT_SUITE_ITEM_CAP,
  type TracesClusterResult,
  type TracesPurgeResult,
  type AgentClusterOutcome,
  ALERT_DISPATCH_ATTEMPTS,
  ALERT_DISPATCH_TIMEOUT_MS,
  serveQualityScore,
  hashStrategy,
  DEFAULT_EVAL_CAP_USD,
  type AlertDispatchDeps,
  type AlertDeliveryOutcome,
  type AlertsDispatchResult,
  type BudgetEventMeter,
  type BudgetEvaluateOrgResult,
  type BudgetEvaluateResult,
  type GuaranteeBreachMeter,
  type GuaranteeEvaluateResult,
  type JobContext,
  type WorkerHandler,
  type EvalRunResult,
  type SweepRunResult,
  type SweepSuiteOutcome,
} from './handlers.js';
