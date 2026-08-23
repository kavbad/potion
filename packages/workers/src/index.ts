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
import { startResearchSchedule } from './schedule.js';

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
  /**
   * Hours between autoresearcher scans. Omit to read
   * POTION_RESEARCH_SCAN_INTERVAL_HOURS; unset or 0 leaves the heartbeat OFF.
   * See schedule.ts — a scan is free, so the cost of a heartbeat is bounded
   * by the cycles a genuinely new model triggers.
   */
  researchScanIntervalHours?: number;
  /** M5 #36: suite v2 dir for synthesized agent replay suites (default:
   * POTION_SUITES_V2_DIR env, else the harness repo suites dir — the
   * prices.json precedent; tests/walkthrough override to a tmp copy). */
  suitesV2Dir?: string;
}

export interface WorkerHandle {
  /** The job kinds this worker consumes. */
  kinds: readonly JobKind[];
  /** Autoresearcher heartbeat cadence, or null when it is off. Surfaced so a
   *  deployment can assert its research programme is actually running rather
   *  than assuming it. */
  researchScanIntervalHours: number | null;
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
  // The autoresearcher's heartbeat. Off unless an interval is named — see
  // schedule.ts for why a timer is safe here (a scan spends nothing; only a
  // genuinely new model causes a capped, budget-gated cycle).
  const research = startResearchSchedule({
    queue: opts.queue,
    ...(opts.researchScanIntervalHours !== undefined
      ? { intervalHours: opts.researchScanIntervalHours }
      : {}),
  });

  const handlers = { ...defaultHandlers, ...(opts.handlers ?? {}) };
  for (const kind of JOB_KINDS) {
    const handler = handlers[kind] as WorkerHandler;
    // F10: the DELIVERY rides on a per-job ctx. It is what lets a handler
    // tell a queue RETRY (or a stall redelivery) from a deliberate re-run —
    // the only discriminator available, since two verdicts for one tuple are
    // legitimate when a human asked twice.
    opts.queue.registerHandler(kind, (payload: JobPayloads[JobKind], delivery) =>
      handler(payload, { ...ctx, delivery }),
    );
  }
  return {
    kinds: JOB_KINDS,
    queue: opts.queue,
    researchScanIntervalHours: research.intervalHours,
    close: async () => {
      research.stop();
      await opts.queue.close();
    },
  };
}

export * from './jobs.js';
export {
  startResearchSchedule,
  RESEARCH_SCAN_INTERVAL_ENV,
  type ResearchSchedule,
  type ResearchScheduleOptions,
} from './schedule.js';
export { createOrgDeleteHandler, orgDeleteHandler, type OrgDeleteHandlerOpts } from './org-delete.js';
export {
  defaultHandlers,
  evalRunHandler,
  sweepRunHandler,
  stalenessScanHandler,
  shadowJudgeHandler,
  guaranteeEvaluateHandler,
  createGuaranteeEvaluateHandler,
  alertsDispatchHandler,
  createAlertsDispatchHandler,
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
  tracesRedactHandler,
  redactTraceText,
  toolSignatureSlug,
  canonicalToolSequence,
  orgHashOf,
  // ---- G1.5 automated scorer construction ----
  rubricGenerateHandler,
  // ---- G1.7 live capped org evals ----
  frontierLiveSweepHandler,
  OrgBudgetRefusalError,
  DEFAULT_LIVE_SWEEP_CAP_USD,
  LIVE_SWEEP_JUDGE_MAX_TOKENS,
  LIVE_SWEEP_ANSWER_MAX_TOKENS,
  type FrontierLiveSweepResult,
  // ---- Lab Step 5 platform live sweep ----
  frontierPlatformSweepHandler,
  PlatformSweepRefusalError,
  PLATFORM_OPS_ORG_ID,
  PLATFORM_SUITE_BY_CLUSTER,
  PLATFORM_SWEEP_CASCADE_CONFIDENCE_BELOW,
  PLATFORM_SWEEP_MAX_ANSWERERS,
  type FrontierPlatformSweepResult,
  type PlatformSweepRefusalReason,
  // ---- Lab Step 8 trial runs ----
  labRunHandler,
  createLabRunHandler,
  type LabRunHandlerDeps,
  // ---- Lab Step 10 grant revocation (best-effort provider-side) ----
  labGrantRevokeHandler,
  createLabGrantRevokeHandler,
  type LabGrantRevokeDeps,
  rubricTemplateFor,
  validateGeneratedRubric,
  buildRubricGenerationMessages,
  RUBRIC_DEFAULT_LIVE_CAP_USD,
  type RubricGenerateResult,
  TRACES_CLUSTER_DEFAULT_SINCE_DAYS,
  TRACES_CLUSTER_DEFAULT_LIMIT,
  AGENT_CLUSTER_COSINE_THRESHOLD,
  AGENT_SUITE_ITEM_CAP,
  type TracesClusterResult,
  type TracesPurgeResult,
  type AgentClusterOutcome,
  ALERT_DISPATCH_ATTEMPTS,
  ALERT_DISPATCH_TIMEOUT_MS,
  // ---- Post-capstone item 3: suite certification (Decision 2) ----
  suiteCertifyHandler,
  CERTIFICATION_SELF_RETENTION_FLOOR,
  type SuiteCertifyResult,
  // ---- G2.2 incident SLAs ----
  GUARANTEE_VERIFY_SLA_MIN,
  VERIFY_RETRY_MIN,
  RECOVERY_UNCONFIRMED_AFTER,
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
export * from './observatory.js';
export * from './notion-sink.js';
export * from './replay.js';
export * from './frontier-notes/index.js';
export * from './learning-period.js';
