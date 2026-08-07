// Default job handlers (SPEC §12.2). All handlers run on mock providers
// (deterministic, zero network) unless overridden via runWorker handlers —
// live-provider sweeps stay an operator-run script affair (scripts/m1b-sweep).
import { fileURLToPath } from 'node:url';
import {
  redactPii, strategyHash, type Policy, type StrategyConfig } from '@potion/core';
import {
  purgeDerivedSuiteItems,
  upsertDerivedSuite,
  backfillRedactSpans,
  distinctSampledTargets,
  evalRuns,
  evaluateGuarantee,
  listPoliciesWithGuarantee,
  strategyConfigs,
  type DbHandle,
  type GuaranteeEvaluation,
  type PotionDb,
} from '@potion/db';
// ---- M4 #33 alerts + #35 budget autopilot (SPEC §13.5/§13.7) ----
import {
  ALERT_EVENTS,
  BUDGET_ZSCORE_THRESHOLD,
  dailySpendSeries,
  forecastMtdUsd,
  getBudget,
  insertAlertDelivery,
  listBudgets,
  matchingAlertRules,
  mtdSpendUsd,
  recordBudgetEvent,
  redactUrl,
  redactUrlsInText,
  spendZScore,
  utcDay,
  warnAtUsd,
  type AlertEvent,
  type AlertRuleRow,
  type BudgetEventKind,
} from '@potion/db';
import type { PotionQueue } from '@potion/queue';
// ---- end M4 #33/#35 imports ----
import {
  loadSuite,
  loadSuiteV2,
  markStale,
  projectRunCostUsd,
  runEval,
  type RunSummary,
  type StaleCounts,
} from '@potion/harness';
import { loadPrices } from '@potion/providers';
// ---- M4b #37 autoresearcher (SPEC §15) ----
import { writeFileSync } from 'node:fs';
import {
  diffModelListings,
  fetchOpenRouterModels,
  mockModels,
} from '@potion/providers';
import {
  aggregatesFromEvalResults,
  computeFrontier,
  loadCurrentFrontier,
  mergePriceEntry,
  saveFrontier,
} from '@potion/pareto';
import {
  DEFAULT_CANDIDATE_BUDGET,
  buildRegistry,
  classRepresentative,
  evaluatePromotion,
  generateCandidatesExplained,
  type ItemPair,
} from '@potion/researcher';
// ---- M5 #36 agent workloads (SPEC §14) ----
import { createHash } from 'node:crypto';
import { SUITES_V2_DIR } from '@potion/harness';
import {
  clusterExemplars,
  clusters,
  deleteSpansOlderThan,
  getOrgTraceRetentionDays,
  listOrgIdsWithSpans,
  listTracesForClustering,
  redactSpanAttrs,
  type TraceClusterSource,
} from '@potion/db';
import type { SuiteManifest } from '@potion/harness';
import type { TracesClusterPayload, TracesPurgePayload } from './jobs.js';
// ---- end M5 #36 imports ----
import {
  alertRules,
  evalResults,
  insertResearchCycle,
  recipeStatus,
  updateResearchCycle,
  upsertRecipeStatus,
} from '@potion/db';
import {
  highestQualityPoint,
  type FrontierPoint,
  type ProviderMode,
} from '@potion/core';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
// ---- end M4b #37 imports ----
import type { ArtifactStore } from '@potion/artifacts';
import type {
  AlertsDispatchPayload,
  BudgetEvaluatePayload,
  EvalRunPayload,
  GuaranteeEvaluatePayload,
  JobPayloads,
  ResearchCyclePayload,
  ResearchScanPayload,
  ShadowJudgePayload,
  StalenessScanPayload,
  SweepRunPayload,
} from './jobs.js';

/** Repo-root prices.json — works from src/ (tsx/vitest) and dist/. */
export const DEFAULT_PRICES_PATH = fileURLToPath(
  new URL('../../../prices.json', import.meta.url),
);

/** Default budget cap for eval:run when the payload omits capUsd. */
export const DEFAULT_EVAL_CAP_USD = 10;

/** Budget-fit tolerance shared with scripts/m1b-sweep (IEEE754 noise). */
const BUDGET_TOLERANCE = 1e-9;

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
  /** M5 #36: dir for synthesized agent replay suites (suite v2 layout).
   * Default: the harness repo suites dir (SUITES_V2_DIR), mirroring the
   * prices.json precedent — tests/walkthrough override to a tmp copy. */
  suitesV2Dir?: string | undefined;
}

export type WorkerHandler<K extends keyof JobPayloads = keyof JobPayloads> = (
  payload: JobPayloads[K],
  ctx: JobContext,
) => Promise<unknown>;

async function writeJsonArtifact(
  artifacts: ArtifactStore | undefined,
  key: string,
  value: unknown,
): Promise<string | null> {
  if (!artifacts) return null;
  await artifacts.put(key, Buffer.from(JSON.stringify(value, null, 2)));
  return key;
}

// ---------------------------------------------------------------------------
// eval:run — harness runner, programmatic, mock providers
// ---------------------------------------------------------------------------

export interface EvalRunResult {
  runId: string;
  spendUsd: number;
  executed: number;
  cacheHits: number;
  aggregates: number;
  artifactKey: string | null;
}

async function loadStrategies(db: PotionDb, hashes: string[]): Promise<StrategyConfig[]> {
  if (hashes.length === 0) return [];
  const rows = await db
    .select()
    .from(strategyConfigs)
    .where(inArray(strategyConfigs.hash, hashes));
  const byHash = new Map(rows.map((r) => [r.hash, r.config]));
  const missing = hashes.filter((h) => !byHash.has(h));
  if (missing.length > 0) {
    throw new Error(
      `unknown strategy hash(es): ${missing.join(', ')} — register configs in strategy_configs first`,
    );
  }
  // Preserve payload order (inArray does not).
  return hashes.map((h) => byHash.get(h)!);
}

export const evalRunHandler: WorkerHandler<'eval:run'> = async (
  payload: EvalRunPayload,
  ctx: JobContext,
): Promise<EvalRunResult> => {
  const strategies = await loadStrategies(ctx.db, payload.strategyHashes);
  const budgetCapUsd = payload.capUsd ?? DEFAULT_EVAL_CAP_USD;
  const summary: RunSummary = await runEval(
    {
      suiteIds: payload.suiteIds,
      strategies,
      budgetCapUsd,
      provider: 'mock',
      resume: true,
    },
    {
      db: ctx.dbHandle,
      pricesPath: ctx.pricesPath,
      ...(ctx.suitesDir !== undefined ? { suitesDir: ctx.suitesDir } : {}),
    },
  );
  // Record the run row (results themselves are persisted by the runner into
  // the content-addressed eval_results cache).
  await ctx.db.insert(evalRuns).values({
    id: summary.runId,
    options: {
      suiteIds: payload.suiteIds,
      strategyHashes: payload.strategyHashes,
      ...(payload.orgId !== undefined ? { orgId: payload.orgId } : {}),
    },
    budgetCapUsd,
    provider: 'mock',
    status: 'completed',
    spendUsd: summary.spendUsd,
  });
  const artifactKey = await writeJsonArtifact(ctx.artifacts, `eval/${summary.runId}.json`, {
    ...summary,
    orgId: payload.orgId ?? null,
  });
  return {
    runId: summary.runId,
    spendUsd: summary.spendUsd,
    executed: summary.executed,
    cacheHits: summary.cacheHits,
    aggregates: summary.aggregates.length,
    artifactKey,
  };
};

// ---------------------------------------------------------------------------
// sweep:run — sequential budget-governed multi-suite sweep (mock providers).
// Mirrors the runSweepLoop semantics of scripts/m1b-sweep.ts: preflight each
// suite against the remaining cap and stop gracefully when it would not fit.
// (The script's loop cannot be imported from a workspace package — scripts/ is
// not one — so the small loop is reimplemented here, fed by the same harness
// estimator + runEval.)
// ---------------------------------------------------------------------------

export interface SweepSuiteOutcome {
  suiteId: string;
  projectedUsd: number;
  spendUsd: number;
  runId: string;
}

export interface SweepRunResult {
  outcomes: SweepSuiteOutcome[];
  stoppedEarly: boolean;
  stopReason: string | null;
  totalSpendUsd: number;
  artifactKey: string | null;
}

export const sweepRunHandler: WorkerHandler<'sweep:run'> = async (
  payload: SweepRunPayload,
  ctx: JobContext,
): Promise<SweepRunResult> => {
  const { table: prices } = loadPrices(ctx.pricesPath);
  const itemsBySuite = payload.suiteIds.map((id) => loadSuite(id, ctx.suitesDir));
  const outcomes: SweepSuiteOutcome[] = [];
  let totalSpendUsd = 0;
  let stoppedEarly = false;
  let stopReason: string | null = null;

  for (let i = 0; i < payload.suiteIds.length; i++) {
    const suiteId = payload.suiteIds[i]!;
    const items = itemsBySuite[i]!;
    const remaining = payload.capUsd - totalSpendUsd;
    const projected = projectRunCostUsd(payload.strategies, items, prices);
    if (projected > remaining + BUDGET_TOLERANCE) {
      stoppedEarly = true;
      stopReason =
        `suite '${suiteId}' projected $${projected.toFixed(4)} does not fit the remaining ` +
        `$${remaining.toFixed(4)} of the $${payload.capUsd.toFixed(2)} cap — stopping gracefully ` +
        `(${outcomes.length}/${payload.suiteIds.length} suites completed)`;
      break;
    }
    const summary = await runEval(
      {
        suiteIds: [suiteId],
        strategies: payload.strategies,
        budgetCapUsd: remaining,
        provider: 'mock',
      },
      {
        db: ctx.dbHandle,
        pricesPath: ctx.pricesPath,
        ...(ctx.suitesDir !== undefined ? { suitesDir: ctx.suitesDir } : {}),
      },
    );
    totalSpendUsd += summary.spendUsd;
    outcomes.push({
      suiteId,
      projectedUsd: projected,
      spendUsd: summary.spendUsd,
      runId: summary.runId,
    });
  }

  const artifactKey = await writeJsonArtifact(
    ctx.artifacts,
    `sweep/sweep-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    {
      suiteIds: payload.suiteIds,
      strategies: payload.strategies,
      capUsd: payload.capUsd,
      outcomes,
      stoppedEarly,
      stopReason,
      totalSpendUsd,
      orgId: payload.orgId ?? null,
    },
  );
  return { outcomes, stoppedEarly, stopReason, totalSpendUsd, artifactKey };
};

// ---------------------------------------------------------------------------
// staleness:scan — flag eval_results whose prices/judge/model versions drifted
// ---------------------------------------------------------------------------

export const stalenessScanHandler: WorkerHandler<'staleness:scan'> = async (
  _payload: StalenessScanPayload,
  ctx: JobContext,
): Promise<StaleCounts> => {
  const { table: prices } = loadPrices(ctx.pricesPath);
  const judge = prices.entries.find((e) => e.alias === 'judge-class');
  const modelVersions: Record<string, string> = {};
  for (const entry of prices.entries) modelVersions[entry.alias] = entry.model;
  return markStale(ctx.db, {
    pricesVersion: prices.version,
    ...(judge !== undefined ? { judgeModel: judge.model } : {}),
    modelVersions,
  });
};

// ---------------------------------------------------------------------------
// shadow:judge — STUB for ROADMAP #21 (shadow mode). Another stream implements
// the real judge; this accepts the payload and succeeds as a no-op so the
// queue plumbing + endpoint contract can be exercised end-to-end today.
// ---------------------------------------------------------------------------

export const shadowJudgeHandler: WorkerHandler<'shadow:judge'> = async (
  payload: ShadowJudgePayload,
  _ctx: JobContext,
): Promise<{ stub: true; shadowResultId: string; status: 'accepted' }> => {
  if (typeof payload.shadowResultId !== 'string' || payload.shadowResultId.length === 0) {
    throw new Error("shadow:judge payload requires a non-empty 'shadowResultId' string");
  }
  return { stub: true, shadowResultId: payload.shadowResultId, status: 'accepted' };
};

// ---------------------------------------------------------------------------
// guarantee:evaluate — quality-guarantee breach evaluation (M3 #22 → G0.1,
// SPEC §12.5). SCORING no longer happens here: the server judge-scores each
// sampled answer in-process (a real llm-judge call — see apps/server
// guarantee.ts + @potion/harness serve-judge) and enqueues a CONTENT-FREE
// per-target job (org/cluster/strategy/policy). This handler evaluates the
// rolling window via the shared evaluator in @potion/db and emits breach
// alerts. Sweep mode (no policy/cluster/strategy fields) re-evaluates every
// guarantee-carrying policy against its org's recently sampled strategies.
// The old Jaccard-vs-prompt sample-scoring mode is retired (G0.1).
// ---------------------------------------------------------------------------

/** Structural meter duck-type (avoids a workers → observability dependency):
 * the server passes its observability meter when registering this handler. */
export interface GuaranteeBreachMeter {
  observeGuaranteeBreach?(b: { orgId: string; action: 'rollback' | 'alert' }): void;
}

export interface GuaranteeEvaluateResult {
  /** Rolling evaluations performed (1 per-target; N in sweep mode). */
  evaluations: GuaranteeEvaluation[];
  /** Breach incidents written this run. */
  breaches: Array<{ orgId: string; action: 'rollback' | 'alert'; incidentId: string }>;
}

/** One evaluation target: (org, policy, cluster, strategy, governing policy). */
interface EvaluationTarget {
  orgId: string;
  policyId: string;
  clusterId: string;
  strategyHash: string;
  policy: Policy;
}

async function resolveTargets(
  db: PotionDb,
  payload: GuaranteeEvaluatePayload,
): Promise<EvaluationTarget[]> {
  // Per-target / explicit mode: the caller names the exact keyed tuple.
  if (
    payload.policy &&
    payload.orgId &&
    payload.policyId &&
    payload.clusterId &&
    payload.strategyHash
  ) {
    if (payload.policy.guarantee === undefined) return [];
    return [
      {
        orgId: payload.orgId,
        policyId: payload.policyId,
        clusterId: payload.clusterId,
        strategyHash: payload.strategyHash,
        policy: payload.policy,
      },
    ];
  }
  // Sweep mode (G0.3): every guarantee-carrying policy (optionally one org)
  // × the org's KEYED evidence tuples sampled in the policy's window — the
  // sample rows carry policy/cluster now, so the old strategies ×
  // clustersForStrategy cartesian reconstruction (which multiplied incidents
  // across every cluster a strategy served) is gone.
  const policies = await listPoliciesWithGuarantee(db, payload.orgId);
  const targets: EvaluationTarget[] = [];
  for (const row of policies) {
    const guarantee = row.config.guarantee!;
    const tuples = await distinctSampledTargets(db, row.orgId, guarantee.windowMin);
    for (const t of tuples) {
      if (t.policyId !== row.id) continue; // evidence keyed to OTHER policies is not this policy's
      targets.push({
        orgId: row.orgId,
        policyId: t.policyId,
        clusterId: t.clusterId,
        strategyHash: t.strategyHash,
        policy: row.config,
      });
    }
  }
  return targets;
}

export function createGuaranteeEvaluateHandler(opts: {
  meter?: GuaranteeBreachMeter;
}): WorkerHandler<'guarantee:evaluate'> {
  return async (payload, ctx): Promise<GuaranteeEvaluateResult> => {
    const targets = await resolveTargets(ctx.db, payload);
    const evaluations: GuaranteeEvaluation[] = [];
    const breaches: GuaranteeEvaluateResult['breaches'] = [];
    for (const target of targets) {
      const evaluation = await evaluateGuarantee(ctx.db, target);
      // (target carries orgId/policyId/clusterId/strategyHash/policy — the
      // evaluator's exact keyed input shape.)
      evaluations.push(evaluation);
      if (evaluation.breach && evaluation.incidentId !== null && evaluation.action !== null) {
        breaches.push({
          orgId: target.orgId,
          action: evaluation.action,
          incidentId: evaluation.incidentId,
        });
        opts.meter?.observeGuaranteeBreach?.({ orgId: target.orgId, action: evaluation.action });
        // ---- M4 #33 alerts (m4-alerts-budget) ----
        // Incident creation → alert emission (SPEC §13.5): the in-process
        // serving path in apps/server/src/guarantee.ts does the same for
        // its evaluations. Alert delivery faults must NEVER fail the
        // guarantee job — the incident row is already the durable record.
        try {
          await emitAlertEvent(ctx, {
            orgId: target.orgId,
            event: evaluation.action === 'rollback' ? 'rollback' : 'quality_breach',
            detail: {
              incidentId: evaluation.incidentId,
              clusterId: target.clusterId,
              strategyHash: target.strategyHash,
              rollingQuality: evaluation.rollingQuality,
              samples: evaluation.samples,
              ...(evaluation.rollback !== null ? { rollback: evaluation.rollback } : {}),
            },
          });
        } catch {
          // swallowed — see above
        }
        // ---- end M4 #33 alerts emission ----
      }
    }
    return { evaluations, breaches };
  };
}

/** Default guarantee:evaluate handler (no meter — the server re-registers
 * with its observability meter; see server.ts). */
export const guaranteeEvaluateHandler: WorkerHandler<'guarantee:evaluate'> =
  createGuaranteeEvaluateHandler({});

// ---------------------------------------------------------------------------
// alerts:dispatch — alert delivery (M4 #33, SPEC §13.5). One job per alert
// EVENT; the handler resolves the org's ENABLED rules subscribed to the
// event and POSTs each one. Per-rule outcomes land in alert_deliveries
// (audit). target_url NEVER leaves alert_rules: delivery rows and error
// text are query-string-redacted (webhook secrets ride query strings).
//
// RETRY SEMANTICS (documented): delivery retries are PER-RULE INLINE (up to
// ALERT_DISPATCH_ATTEMPTS with backoff). The memory queue driver does not
// retry jobs at all, and a job-level retry would re-deliver the rules that
// already succeeded (duplicate notifications) — inline per-rule attempts
// keep delivery idempotent across both drivers. The bullmq driver's 3×
// job-level retry still covers infrastructure faults (db down mid-job).
// ---------------------------------------------------------------------------

/** Attempts per rule before the delivery is marked failed. */
export const ALERT_DISPATCH_ATTEMPTS = 3;
/** Per-attempt POST timeout. */
export const ALERT_DISPATCH_TIMEOUT_MS = 5_000;
/** Backoff BEFORE attempt i+1 (ms) — index 0 is the first attempt. */
export const ALERT_DISPATCH_BACKOFF_MS = [0, 50, 150] as const;

/** Injectable seams (tests / server in-process fallback). */
export interface AlertDispatchDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** Failure/observability log — receives ONLY redacted text. */
  log?: (msg: string) => void;
}

/** Slack-compatible text form of an alert event (kind=slack → {text}). */
export function alertSlackText(payload: AlertsDispatchPayload): string {
  const detail = JSON.stringify(payload.detail ?? {});
  return `*[potion] ${payload.event}* org=${payload.orgId} — ${detail}`;
}

/** The POST body for a rule kind: webhook gets the contract JSON
 * {event, org_id, detail, ts}; slack gets {text} (incoming-webhook shape). */
export function alertRequestBody(
  kind: AlertRuleRow['kind'],
  payload: AlertsDispatchPayload,
  ts: string,
): string {
  if (kind === 'slack') return JSON.stringify({ text: alertSlackText(payload) });
  return JSON.stringify({
    event: payload.event,
    org_id: payload.orgId,
    detail: payload.detail ?? {},
    ts,
  });
}

export interface AlertDeliveryOutcome {
  ruleId: string;
  kind: AlertRuleRow['kind'];
  status: 'delivered' | 'failed';
  attempts: number;
  /** Query-string-redacted failure detail (null on success). */
  lastError: string | null;
}

export interface AlertsDispatchResult {
  orgId: string;
  event: AlertEvent;
  /** Enabled rules matching the event subscription. */
  matched: number;
  delivered: number;
  failed: number;
  outcomes: AlertDeliveryOutcome[];
}

/** POST one rule with inline per-rule retry; append the audit row. */
async function deliverToRule(
  db: PotionDb,
  rule: AlertRuleRow,
  payload: AlertsDispatchPayload,
  deps: AlertDispatchDeps,
): Promise<AlertDeliveryOutcome> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => new Date());
  const ts = now().toISOString();
  const body = alertRequestBody(rule.kind, payload, ts);
  // The redacted target is safe to put in logs/audit; the raw URL is not.
  const redactedTarget = redactUrl(rule.targetUrl);
  let attempts = 0;
  let lastError: string | null = null;
  let delivered = false;
  for (let i = 0; i < ALERT_DISPATCH_ATTEMPTS; i++) {
    const backoff = ALERT_DISPATCH_BACKOFF_MS[Math.min(i, ALERT_DISPATCH_BACKOFF_MS.length - 1)]!;
    if (backoff > 0) await sleep(backoff);
    attempts += 1;
    try {
      const res = await fetchImpl(rule.targetUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(ALERT_DISPATCH_TIMEOUT_MS),
      });
      if (res.ok) {
        delivered = true;
        lastError = null;
        break;
      }
      lastError = `HTTP ${res.status} from ${redactedTarget}`;
    } catch (err) {
      // fetch errors never embed the URL, but redact defensively anyway.
      lastError = redactUrlsInText(
        `POST ${redactedTarget} failed: ${(err as Error).message}`,
      );
    }
  }
  await insertAlertDelivery(db, {
    ruleId: rule.id,
    event: payload.event,
    status: delivered ? 'delivered' : 'failed',
    attempts,
    ...(lastError !== null ? { lastError } : {}),
    ...(delivered ? { deliveredAt: now() } : {}),
  });
  if (!delivered) {
    deps.log?.(
      `alerts: rule ${rule.id} (${rule.kind}) event ${payload.event} FAILED after ` +
        `${attempts} attempt(s): ${lastError ?? 'unknown'}`,
    );
  }
  return { ruleId: rule.id, kind: rule.kind, status: delivered ? 'delivered' : 'failed', attempts, lastError };
}

/**
 * Dispatch one alert event to the org's matching enabled rules. Shared by
 * the alerts:dispatch job handler AND the server's in-process fire-and-
 * forget fallback (no queue on ctx — see apps/server/src/alerts.ts).
 */
export async function dispatchAlertEvent(
  db: PotionDb,
  payload: AlertsDispatchPayload,
  deps: AlertDispatchDeps = {},
): Promise<AlertsDispatchResult> {
  if (!ALERT_EVENTS.includes(payload.event)) {
    throw new Error(`alerts:dispatch unknown event '${payload.event}'`);
  }
  const rules = await matchingAlertRules(db, payload.orgId, payload.event);
  const outcomes: AlertDeliveryOutcome[] = [];
  for (const rule of rules) {
    outcomes.push(await deliverToRule(db, rule, payload, deps));
  }
  return {
    orgId: payload.orgId,
    event: payload.event,
    matched: rules.length,
    delivered: outcomes.filter((o) => o.status === 'delivered').length,
    failed: outcomes.filter((o) => o.status === 'failed').length,
    outcomes,
  };
}

export const alertsDispatchHandler: WorkerHandler<'alerts:dispatch'> = async (
  payload: AlertsDispatchPayload,
  ctx: JobContext,
): Promise<AlertsDispatchResult> => {
  return dispatchAlertEvent(ctx.db, payload);
};

/**
 * Emit an alert event: enqueue alerts:dispatch when the job context carries
 * a queue, else deliver in-process (the same fallback contract the server
 * uses — see apps/server/src/alerts.ts). NEVER throws into the caller's
 * control flow beyond queue/db faults the caller already tolerates; callers
 * wrap in try/catch like every other fire-and-forget emission.
 */
export async function emitAlertEvent(
  ctx: Pick<JobContext, 'db' | 'queue'>,
  payload: AlertsDispatchPayload,
): Promise<void> {
  if (ctx.queue) {
    await ctx.queue.enqueue('alerts:dispatch', payload);
    return;
  }
  await dispatchAlertEvent(ctx.db, payload);
}

// ---------------------------------------------------------------------------
// budget:evaluate — budget autopilot sweep (M4 #35, SPEC §13.7). Per org
// with a budget row:
//   · z-score anomaly — mean daily spend of the LAST 7 DAYS vs the trailing
//     30-day daily-spend distribution; |z| > 2.5 → budget_warning.
//   · MTD linear forecast — mtd × daysInMonth/dayOfMonth ≥ cap →
//     budget_warning (forecast).
//   · warn crossing — MTD ≥ warn_pct% of cap (and < cap) → budget_warning.
//   · cap — MTD ≥ cap → budget_exceeded.
// Dedup: the budget_events ledger (migration 0011) — one row per
// (org, kind, UTC day) inserted ON CONFLICT DO NOTHING; the alerts:dispatch
// is emitted ONLY when the insert landed, so each kind fires at most once
// per org per day no matter how often the sweep runs. budget_warning and
// budget_exceeded are DISTINCT kinds — both may fire the same day.
// ---------------------------------------------------------------------------

/** Structural meter duck-type (same optional-method pattern as
 * GuaranteeBreachMeter) — potion_budget_events_total{org_id,kind}. */
export interface BudgetEventMeter {
  observeBudgetEvent?(e: { orgId: string; kind: BudgetEventKind }): void;
}

export interface BudgetEvaluateOrgResult {
  orgId: string;
  capUsd: number;
  mtdUsd: number;
  forecastUsd: number;
  warnAtUsd: number;
  /** null when the z signal is undefined (empty/zero-variance trailing). */
  zScore: number | null;
  /** Events ACTUALLY emitted this run (post-dedup). */
  emitted: BudgetEventKind[];
}

export interface BudgetEvaluateResult {
  orgs: BudgetEvaluateOrgResult[];
}

export function createBudgetEvaluateHandler(opts: {
  meter?: BudgetEventMeter;
}): WorkerHandler<'budget:evaluate'> {
  return async (payload: BudgetEvaluatePayload, ctx: JobContext): Promise<BudgetEvaluateResult> => {
    const now = new Date();
    const budgets =
      payload.orgId !== undefined
        ? [(await getBudget(ctx.db, payload.orgId))].filter((b) => b !== null)
        : await listBudgets(ctx.db);
    const today = utcDay(now);
    // 37-day window: 30 trailing days + the last 7 days.
    const fromDay = utcDay(new Date(now.getTime() - 36 * 24 * 3600 * 1000));
    const results: BudgetEvaluateOrgResult[] = [];
    for (const budget of budgets) {
      const series = await dailySpendSeries(ctx.db, budget.orgId, { fromDay, toDay: today });
      const trailing30 = series.slice(0, 30).map((d) => d.costUsd);
      const last7 = series.slice(-7).map((d) => d.costUsd);
      const z = spendZScore(last7, trailing30);
      const mtd = await mtdSpendUsd(ctx.db, budget.orgId, now);
      const forecast = forecastMtdUsd(mtd, now);
      const warnAt = warnAtUsd(budget.monthlyCapUsd, budget.warnPct);

      // Candidate events, evaluated in order. Warning REASONS dedup into the
      // single budget_warning kind (first fresh reason wins the day).
      const candidates: Array<{ kind: BudgetEventKind; detail: Record<string, unknown> }> = [];
      if (mtd >= budget.monthlyCapUsd) {
        candidates.push({
          kind: 'budget_exceeded',
          detail: { reason: 'cap_exceeded', mtdUsd: mtd, capUsd: budget.monthlyCapUsd },
        });
      }
      if (z !== null && Math.abs(z.z) > BUDGET_ZSCORE_THRESHOLD) {
        candidates.push({
          kind: 'budget_warning',
          detail: {
            reason: 'spend_anomaly',
            z: z.z,
            mean7Usd: z.mean7,
            mean30Usd: z.mean30,
            std30Usd: z.std30,
          },
        });
      }
      if (forecast >= budget.monthlyCapUsd) {
        candidates.push({
          kind: 'budget_warning',
          detail: { reason: 'forecast_over_cap', forecastUsd: forecast, capUsd: budget.monthlyCapUsd },
        });
      }
      if (mtd >= warnAt && mtd < budget.monthlyCapUsd) {
        candidates.push({
          kind: 'budget_warning',
          detail: {
            reason: 'warn_crossing',
            mtdUsd: mtd,
            warnAtUsd: warnAt,
            warnPct: budget.warnPct,
            capUsd: budget.monthlyCapUsd,
          },
        });
      }

      const emitted: BudgetEventKind[] = [];
      for (const candidate of candidates) {
        const fresh = await recordBudgetEvent(
          ctx.db,
          { orgId: budget.orgId, kind: candidate.kind, day: today },
          now,
        );
        if (!fresh) continue; // already fired for this org/kind today
        opts.meter?.observeBudgetEvent?.({ orgId: budget.orgId, kind: candidate.kind });
        await emitAlertEvent(ctx, {
          orgId: budget.orgId,
          event: candidate.kind,
          detail: candidate.detail,
        });
        emitted.push(candidate.kind);
      }
      results.push({
        orgId: budget.orgId,
        capUsd: budget.monthlyCapUsd,
        mtdUsd: mtd,
        forecastUsd: forecast,
        warnAtUsd: warnAt,
        zScore: z?.z ?? null,
        emitted,
      });
    }
    return { orgs: results };
  };
}

/** Default budget:evaluate handler (no meter — the server re-registers with
 * its observability meter; see server.ts). */
export const budgetEvaluateHandler: WorkerHandler<'budget:evaluate'> =
  createBudgetEvaluateHandler({});

// ---------------------------------------------------------------------------
// M4b #37 autoresearcher (SPEC §15): research:scan + research:cycle.
// The researcher is PLATFORM-level — discovered recipes publish frontier
// versions every org inherits (per-org private research is a follow-up).
// ---------------------------------------------------------------------------

/** The standard v2 suite set every cycle sweeps (SPEC §15.3). */
export const RESEARCH_V2_SUITE_IDS: readonly string[] = [
  'code-gen-humaneval-js-v1',
  'extraction-authored-v1',
];

/** Max research:cycle jobs one scan enqueues (SPEC §15.2). */
export const RESEARCH_SCAN_MAX_CYCLES = 3;

/** Default LIVE spend cap per cycle in USD (SPEC §15.3). */
export const RESEARCH_CYCLE_DEFAULT_LIVE_CAP_USD = 5;

/** Mock cycles are UNCAPPED by contract (SPEC §15.3) — this is the sentinel
 * budgetCapUsd that makes the harness preflight a no-op for them. Mock spend
 * is simulated USD against real price entries, never real money. */
export const MOCK_CYCLE_BUDGET_CAP_USD = 1_000_000_000;

/** Promotion-gate threshold env overrides (SPEC §15.4: "env-tunable"). */
function promotionThresholdsFromEnv(): {
  qualityDeltaMin?: number;
  costCutMin?: number;
} {
  const out: { qualityDeltaMin?: number; costCutMin?: number } = {};
  const q = Number(process.env.POTION_RESEARCH_QUALITY_DELTA_MIN);
  if (Number.isFinite(q) && q > 0) out.qualityDeltaMin = q;
  const c = Number(process.env.POTION_RESEARCH_COST_CUT_MIN);
  if (Number.isFinite(c) && c > 0 && c < 1) out.costCutMin = c;
  return out;
}

// ---- research:scan (SPEC §15.2) ----

export interface ResearchScanResult {
  source: 'mock' | 'openrouter';
  listings: number;
  /** Aliases APPENDED to the registry this scan. */
  added: string[];
  alreadyKnown: number;
  skippedNoPricing: string[];
  /** New prices.json version after the append (null when nothing added). */
  pricesVersion: string | null;
  /** focusAliases handed to research:cycle (enqueued when a queue is
   * attached; in-process list otherwise — tests assert on it either way). */
  cyclesEnqueued: string[];
  artifactKey: string | null;
}

export const researchScanHandler: WorkerHandler<'research:scan'> = async (
  payload: ResearchScanPayload,
  ctx: JobContext,
): Promise<ResearchScanResult> => {
  // Default source: live OpenRouter when the key is present, else the
  // deterministic mock fixture (dev/CI stay zero-network by construction).
  const apiKey = process.env.OPENROUTER_API_KEY;
  const source = payload.source ?? (apiKey !== undefined ? 'openrouter' : 'mock');
  let listings: ReturnType<typeof mockModels>;
  if (source === 'openrouter') {
    if (apiKey === undefined) {
      throw new Error(
        "research:scan source 'openrouter' needs OPENROUTER_API_KEY in the worker env " +
          "(use source 'mock' for deterministic, zero-network scans)",
      );
    }
    listings = await fetchOpenRouterModels({ apiKey });
  } else {
    listings = mockModels();
  }

  const { table: prices } = loadPrices(ctx.pricesPath);
  const diff = diffModelListings(listings, prices);

  // Append new entries to the registry (SPEC: "with provider-reported
  // pricing when present" — no-pricing ids are reported, not appended).
  // The version bump deliberately invalidates stale-price eval cells (same
  // semantics as the M1a recompute flow's mergePriceEntry).
  let pricesVersion: string | null = null;
  if (diff.added.length > 0) {
    const merged = diff.added.reduce((t, e) => mergePriceEntry(t, e), prices);
    writeFileSync(ctx.pricesPath, `${JSON.stringify(merged, null, 2)}\n`);
    pricesVersion = merged.version;
  }

  // One cycle per new alias, cap RESEARCH_SCAN_MAX_CYCLES (SPEC §15.2).
  const focus = diff.added.slice(0, RESEARCH_SCAN_MAX_CYCLES).map((e) => e.alias);
  for (const focusAlias of focus) {
    if (ctx.queue) {
      await ctx.queue.enqueue('research:cycle', {
        focusAlias,
        trigger: 'scan',
        ...(payload.orgId !== undefined ? { orgId: payload.orgId } : {}),
      });
    }
  }

  const artifactKey = await writeJsonArtifact(
    ctx.artifacts,
    `research/scan-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    {
      source,
      listings: listings.length,
      added: diff.added,
      alreadyKnown: diff.alreadyKnown,
      skippedNoPricing: diff.skippedNoPricing,
      pricesVersion,
      cyclesEnqueued: focus,
    },
  );

  return {
    source,
    listings: listings.length,
    added: diff.added.map((e) => e.alias),
    alreadyKnown: diff.alreadyKnown.length,
    skippedNoPricing: diff.skippedNoPricing,
    pricesVersion,
    cyclesEnqueued: focus,
    artifactKey,
  };
};

// ---- research:cycle (SPEC §15.3 + §15.4) ----

export interface CyclePromotion {
  clusterId: string;
  strategyHash: string;
  path: 'quality' | 'cost' | 'bootstrap';
  reason: string;
  frontierId: string;
  frontierVersion: number;
}

export interface ResearchCycleResult {
  cycleId: string;
  trigger: string;
  candidates: number;
  candidateHashes: string[];
  suitesRun: string[];
  spendUsd: number;
  provenance: ProviderMode | 'unknown';
  promotions: CyclePromotion[];
  stoppedEarly: boolean;
  stopReason: string | null;
  artifactKey: string | null;
}

/** Live per-item quality rows for two hashes, paired by itemId (the §15.4
 * heldout pairs). LIVE-provenance rows only — the promotion gate never sees
 * mock evidence, which is why mock cycles structurally cannot promote. */
async function liveHeldoutPairs(
  ctx: JobContext,
  clusterId: string,
  candidateHash: string,
  incumbentHash: string,
  pricesVersion: string,
): Promise<ItemPair[]> {
  const rows = await ctx.db
    .select({
      itemId: evalResults.itemId,
      strategyHash: evalResults.strategyHash,
      quality: evalResults.quality,
    })
    .from(evalResults)
    .where(
      and(
        eq(evalResults.clusterId, clusterId),
        inArray(evalResults.strategyHash, [candidateHash, incumbentHash]),
        eq(evalResults.pricesVersion, pricesVersion),
        eq(evalResults.stale, false),
        eq(evalResults.providerMode, 'live'),
      ),
    );
  const byItem = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const m = byItem.get(r.itemId) ?? new Map<string, number>();
    m.set(r.strategyHash, r.quality);
    byItem.set(r.itemId, m);
  }
  const pairs: ItemPair[] = [];
  for (const [itemId, m] of byItem) {
    const candidateQuality = m.get(candidateHash);
    const incumbentQuality = m.get(incumbentHash);
    if (candidateQuality !== undefined && incumbentQuality !== undefined) {
      pairs.push({ itemId, candidateQuality, incumbentQuality });
    }
  }
  return pairs;
}

/** Fan a platform-level promotion alert out to every org with an ENABLED
 * rule subscribed to recipe_promoted (alerts are org-scoped; the event is
 * platform-wide, so we emit per subscribed org). */
async function emitPromotionAlerts(
  ctx: JobContext,
  detail: Record<string, unknown>,
): Promise<void> {
  const rows = await ctx.db
    .selectDistinct({ orgId: alertRules.orgId })
    .from(alertRules)
    .where(
      and(
        isNull(alertRules.disabledAt),
        sql`'recipe_promoted' = ANY(${alertRules.events})`,
      ),
    );
  for (const { orgId } of rows) {
    await emitAlertEvent(ctx, { orgId, event: 'recipe_promoted', detail });
  }
}

export const researchCycleHandler: WorkerHandler<'research:cycle'> = async (
  payload: ResearchCyclePayload,
  ctx: JobContext,
): Promise<ResearchCycleResult> => {
  const { table: prices } = loadPrices(ctx.pricesPath);
  // Live cycles are operator-enabled (POTION_RESEARCH_PROVIDER=live + real
  // provider keys); everything else runs the deterministic mock world.
  const provider: 'mock' | 'live' =
    process.env.POTION_RESEARCH_PROVIDER === 'live' ? 'live' : 'mock';
  const budgetCapUsd =
    provider === 'live'
      ? (payload.capUsd ?? RESEARCH_CYCLE_DEFAULT_LIVE_CAP_USD)
      : MOCK_CYCLE_BUDGET_CAP_USD;
  const seed = payload.seed ?? Math.floor(Math.random() * 2 ** 31);
  const trigger = payload.trigger ?? 'manual';

  // ---- candidate set ----
  let candidates: StrategyConfig[];
  if (payload.recipeHash !== undefined) {
    // Single-recipe evaluation (POST /api/recipes/:hash/evaluate).
    const rows = await ctx.db
      .select()
      .from(strategyConfigs)
      .where(eq(strategyConfigs.hash, payload.recipeHash));
    if (rows.length === 0) {
      throw new Error(`unknown recipe hash '${payload.recipeHash}' — register the config first`);
    }
    candidates = [rows[0]!.config];
  } else {
    const configRows = await ctx.db.select({ hash: strategyConfigs.hash }).from(strategyConfigs);
    const statusRows = await ctx.db
      .select({ hash: recipeStatus.strategyHash })
      .from(recipeStatus);
    const existingHashes = new Set<string>([
      ...configRows.map((r) => r.hash),
      ...statusRows.map((r) => r.hash),
    ]);
    // Eval-cache cells: hashes already evaluated at the CURRENT prices
    // version (stale rows are deliberately re-runnable — the staleness
    // engine owns that lifecycle).
    const evalRows = await ctx.db
      .selectDistinct({ hash: evalResults.strategyHash })
      .from(evalResults)
      .where(and(eq(evalResults.pricesVersion, prices.version), eq(evalResults.stale, false)));
    const evaluatedHashes = new Set<string>(evalRows.map((r) => r.hash));
    candidates = generateCandidatesExplained({
      registry: buildRegistry(prices),
      ...(payload.focusAlias !== undefined ? { focusAlias: payload.focusAlias } : {}),
      existingHashes,
      evaluatedHashes,
      seed,
      budget: DEFAULT_CANDIDATE_BUDGET,
    }).map((c) => c.config);
  }

  // ---- cycle row (the §15.3 research ledger) ----
  const cycle = await insertResearchCycle(ctx.db, {
    trigger,
    ...(payload.focusAlias !== undefined ? { focusAlias: payload.focusAlias } : {}),
    candidates,
    status: 'running',
    seed,
  });

  // Register every candidate: content-addressed strategy_configs row +
  // recipe_status 'candidate' (firstCycleId sticky on later cycles).
  const candidateHashes: string[] = [];
  for (const config of candidates) {
    const hash = strategyHash(config);
    candidateHashes.push(hash);
    await ctx.db.insert(strategyConfigs).values({ hash, config }).onConflictDoNothing();
    await upsertRecipeStatus(ctx.db, hash, 'candidate', cycle.id);
  }

  if (candidates.length === 0) {
    await updateResearchCycle(ctx.db, cycle.id, {
      status: 'completed',
      completedAt: new Date(),
    });
    return {
      cycleId: cycle.id,
      trigger,
      candidates: 0,
      candidateHashes,
      suitesRun: [],
      spendUsd: 0,
      provenance: 'unknown',
      promotions: [],
      stoppedEarly: false,
      stopReason: 'no new candidates — registry and eval cache already cover the template grammar',
      artifactKey: null,
    };
  }

  // ---- sweep over the standard v2 suite set (graceful stop at the cap) ----
  const suiteV2Ids = payload.suiteV2Ids ?? [...RESEARCH_V2_SUITE_IDS];
  const suitesRun: string[] = [];
  const clusterIds = new Set<string>();
  let spendUsd = 0;
  let provenance: ProviderMode | 'unknown' = 'unknown';
  let stoppedEarly = false;
  let stopReason: string | null = null;

  for (const suiteId of suiteV2Ids) {
    const suite = loadSuiteV2(suiteId);
    for (const item of suite.items) clusterIds.add(item.clusterId);
    const remaining = budgetCapUsd - spendUsd;
    const projected = projectRunCostUsd(candidates, suite.items, prices);
    if (projected > remaining + BUDGET_TOLERANCE) {
      stoppedEarly = true;
      stopReason =
        `suite '${suiteId}' projected $${projected.toFixed(4)} does not fit the remaining ` +
        `$${remaining.toFixed(4)} of the $${budgetCapUsd.toFixed(2)} cap — stopping gracefully ` +
        `(${suitesRun.length}/${suiteV2Ids.length} suites completed)`;
      break;
    }
    const summary: RunSummary = await runEval(
      {
        suiteIds: [],
        suiteV2Ids: [suiteId],
        strategies: candidates,
        budgetCapUsd: remaining,
        provider,
      },
      { db: ctx.dbHandle, pricesPath: ctx.pricesPath },
    );
    spendUsd += summary.spendUsd;
    provenance = summary.providerMode;
    suitesRun.push(suiteId);
  }

  await updateResearchCycle(ctx.db, cycle.id, {
    status: 'completed',
    spendUsd,
    provenance,
    completedAt: new Date(),
  });

  // ---- §15.4 promotion gate, per cluster ----
  // Publish ONLY from live-provenance evidence: the gate's heldout pairs are
  // live eval rows by construction (liveHeldoutPairs), so mock cycles —
  // which never produce live rows — structurally cannot promote; they
  // shortlist recipes into 'candidate' and stop (SPEC §15.3).
  const promotions: CyclePromotion[] = [];
  const thresholds = promotionThresholdsFromEnv();
  for (const clusterId of clusterIds) {
    const current = await loadCurrentFrontier(ctx.db, clusterId);
    const pool: StrategyConfig[] = [];
    const poolHashes = new Set<string>();
    for (const p of current?.points ?? []) {
      if (!poolHashes.has(p.strategyHash)) {
        poolHashes.add(p.strategyHash);
        pool.push(p.strategyConfig);
      }
    }
    for (const c of candidates) {
      const h = strategyHash(c);
      if (!poolHashes.has(h)) {
        poolHashes.add(h);
        pool.push(c);
      }
    }
    const aggregates = await aggregatesFromEvalResults(ctx.db, clusterId, pool, prices.version);
    if (aggregates.length === 0) continue;
    const points: FrontierPoint[] = computeFrontier(aggregates);
    const pointByHash = new Map(points.map((pt) => [pt.strategyHash, pt]));
    const incumbent = current ? highestQualityPoint(current.points) : null;

    for (const hash of candidateHashes) {
      const candidatePoint = pointByHash.get(hash);
      if (!candidatePoint) continue; // candidate didn't make the frontier
      if (candidatePoint.strategyHash === incumbent?.strategyHash) continue;

      let path: CyclePromotion['path'];
      let reason: string;
      if (incumbent === null) {
        // No incumbent: first live frontier ever for this cluster.
        const pairs = await liveHeldoutPairs(ctx, clusterId, hash, hash, prices.version);
        if (pairs.length === 0) continue; // still live-evidence-gated
        path = 'bootstrap';
        reason = 'first live-provenance frontier for cluster (no incumbent)';
      } else {
        const pairs = await liveHeldoutPairs(
          ctx,
          clusterId,
          hash,
          incumbent.strategyHash,
          prices.version,
        );
        const verdict = evaluatePromotion(pairs, {
          candidateCostPer1K: candidatePoint.costPer1K,
          incumbentCostPer1K: incumbent.costPer1K,
          seed,
          thresholds,
        });
        if (!verdict.promote) continue; // CI overlaps → stays 'candidate'
        path = verdict.path!;
        reason = verdict.reason;
      }

      // A candidate cleared the gate → publish the recomputed frontier as
      // the next version (saveFrontier chains parentId automatically), flip
      // lifecycle states, fan out the alert. One publish per cluster.
      const saved = await saveFrontier(
        ctx.db,
        clusterId,
        points,
        trigger === 'scan' ? 'new-model' : 'recompute',
        prices.version,
      );
      const newHashes = new Set(points.map((pt) => pt.strategyHash));
      for (const pt of points) {
        await upsertRecipeStatus(ctx.db, pt.strategyHash, 'frontier');
      }
      for (const prev of current?.points ?? []) {
        if (!newHashes.has(prev.strategyHash)) {
          await upsertRecipeStatus(ctx.db, prev.strategyHash, 'archived');
        }
      }
      await emitPromotionAlerts(ctx, {
        clusterId,
        strategyHash: hash,
        path,
        reason,
        frontierId: saved.id,
        frontierVersion: saved.version,
        cycleId: cycle.id,
      });
      promotions.push({
        clusterId,
        strategyHash: hash,
        path,
        reason,
        frontierId: saved.id,
        frontierVersion: saved.version,
      });
      break; // one publish per cluster per cycle
    }
  }

  const artifactKey = await writeJsonArtifact(
    ctx.artifacts,
    `research/cycle-${cycle.id}.json`,
    {
      cycleId: cycle.id,
      trigger,
      focusAlias: payload.focusAlias ?? null,
      candidates,
      candidateHashes,
      suiteV2Ids,
      suitesRun,
      spendUsd,
      provenance,
      seed,
      promotions,
      stoppedEarly,
      stopReason,
    },
  );

  return {
    cycleId: cycle.id,
    trigger,
    candidates: candidates.length,
    candidateHashes,
    suitesRun,
    spendUsd,
    provenance,
    promotions,
    stoppedEarly,
    stopReason,
    artifactKey,
  };
};

/** The default handler set, one per JobKind. */
// ---------------------------------------------------------------------------
// M5 #36 agent workloads (SPEC §14.2): traces:cluster — embed first user
// messages (REDACTED before anything leaves the org), bucket by tool-graph
// signature, greedy-cosine into agent-<slug> clusters, register them with
// exemplars so the SAME frontier pipeline serves them, synthesize redacted
// replay suites (v2 layout), and sweep new/extended suites on mock so agent
// clusters get their first frontier immediately. Re-runs are idempotent:
// cluster ids derive from the tool signature + deterministic ordinal, and
// suite items are keyed by a trace hash — existing items stay cached.
// ---------------------------------------------------------------------------

export const TRACES_CLUSTER_DEFAULT_SINCE_DAYS = 7;
export const TRACES_CLUSTER_DEFAULT_LIMIT = 500;
/** Same assignment threshold as packages/cluster's assigner (0.62). */
export const AGENT_CLUSTER_COSINE_THRESHOLD = 0.62;
/** Replay items kept per synthesized suite (oldest kept, newest appended). */
export const AGENT_SUITE_ITEM_CAP = 25;
/** Max exemplar rows written when a cluster is first registered. */
export const AGENT_EXEMPLAR_CAP = 8;

/** Redact payload text before it pools across orgs or lands in suites
 * (SPEC §14.2 "redact payloads, keep structure"). G1.1: delegates to the
 * platform redactor (@potion/core redactPii — the same pass now applied at
 * INGEST; this hop is defense-in-depth for repo-seeded/legacy rows) and
 * keeps the 2000-char truncation as an embedding budget. Deterministic. */
export function redactTraceText(text: string, maxLen = 2000): string {
  return redactPii(text).slice(0, maxLen);
}

function sha1Hex(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}

/** Org partition slug (G1.2): 6 hex of sha1(orgId) — SUITE_ID_RE-clean,
 * fixed-arity inside cluster ids, non-identifying on public surfaces. */
export function orgHashOf(orgId: string): string {
  return sha1Hex(orgId).slice(0, 6);
}

/** Tool-graph signature slug (SPEC §14.2): hash of the ORDERED tool-name
 * sequence; tool-free sessions share the 'chat' bucket. */
export function toolSignatureSlug(toolSequence: string[]): string {
  if (toolSequence.length === 0) return 'chat';
  return sha1Hex(toolSequence.join('>')).slice(0, 6);
}

/** Mirrors packages/cluster assigner's cosine (workers don't depend on it). */
function cosineSim(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function meanCentroid(vecs: number[][]): number[] {
  const dims = vecs[0]?.length ?? 0;
  const out = new Array<number>(dims).fill(0);
  for (const v of vecs) for (let i = 0; i < dims; i++) out[i]! += v[i]!;
  return out.map((x) => x / Math.max(1, vecs.length));
}

export interface AgentClusterOutcome {
  clusterId: string;
  slug: string;
  sessions: number;
  toolSequence: string[];
  created: boolean;
  suiteId: string;
  suiteVersion: string;
  itemsAdded: number;
  evalRunId: string | null;
}

export interface TracesClusterResult {
  sessionsSeen: number;
  clustersCreated: number;
  clustersUpdated: number;
  spendUsd: number;
  clusters: AgentClusterOutcome[];
}

export const tracesClusterHandler: WorkerHandler<'traces:cluster'> = async (
  payload: TracesClusterPayload,
  ctx: JobContext,
): Promise<TracesClusterResult> => {
  const embedder = ctx.embedder;
  if (embedder === undefined) {
    throw new Error('traces:cluster requires JobContext.embedder (platform embedder)');
  }
  const sinceDays = payload.sinceDays ?? TRACES_CLUSTER_DEFAULT_SINCE_DAYS;
  const since = new Date(Date.now() - sinceDays * 86_400_000);
  // G1.2: clustering is PER-ORG everywhere. An explicit orgId fetches with
  // the SQL predicate (no cross-tenant starvation of the scan window); the
  // nightly {} run loops distinct orgs so no tenant's volume starves another
  // and nothing ever pools.
  const orgIds =
    payload.orgId !== undefined ? [payload.orgId] : await listOrgIdsWithSpans(ctx.db, since);
  const sources: TraceClusterSource[] = [];
  for (const orgId of orgIds) {
    sources.push(
      ...(await listTracesForClustering(ctx.db, {
        orgId,
        since,
        limit: payload.limit ?? TRACES_CLUSTER_DEFAULT_LIMIT,
      })),
    );
  }

  const result: TracesClusterResult = {
    sessionsSeen: sources.length,
    clustersCreated: 0,
    clustersUpdated: 0,
    spendUsd: 0,
    clusters: [],
  };
  if (sources.length === 0) return result;

  // REDACT first, embed second — payload text never pools raw.
  const texts = sources.map((s) => redactTraceText(s.firstMessage ?? `session ${s.traceId}`));
  const vectors = await embedder.embed(texts);

  // Bucket by (org, tool-graph signature) — sorted for deterministic ids;
  // two tenants sharing a tool sequence NEVER share a bucket (G1.2).
  const bySlug = new Map<string, number[]>();
  sources.forEach((s, i) => {
    const slug = `${orgHashOf(s.orgId)}-${toolSignatureSlug(s.toolSequence)}`;
    const list = bySlug.get(slug) ?? [];
    list.push(i);
    bySlug.set(slug, list);
  });

  const { table: prices } = loadPrices(ctx.pricesPath);
  const registry = buildRegistry(prices);
  const judgeAlias = classRepresentative(registry, 'judge')?.alias ?? 'mock-judge';
  const suitesV2Dir = ctx.suitesV2Dir ?? SUITES_V2_DIR;
  const suiteStrategies = (['cheap', 'mid', 'strong'] as const)
    .map((cls) => classRepresentative(registry, cls))
    .filter((e): e is NonNullable<typeof e> => e !== null && e !== undefined)
    .map((e) => ({ type: 'single', model: e.alias }) as StrategyConfig);
  // De-dupe (mock registry may resolve one alias for several classes).
  const strategyByHash = new Map<string, StrategyConfig>();
  for (const cfg of suiteStrategies) strategyByHash.set(strategyHash(cfg), cfg);
  const strategies = [...strategyByHash.values()];

  for (const [slug, idxs] of [...bySlug.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    // Greedy cosine assignment against running-mean centroids.
    const groups: { members: number[]; centroid: number[] }[] = [];
    for (const i of idxs) {
      const v = vectors[i]!;
      let best = -1;
      let bestSim = -1;
      groups.forEach((g, gi) => {
        const sim = cosineSim(v, g.centroid);
        if (sim > bestSim) {
          bestSim = sim;
          best = gi;
        }
      });
      if (best >= 0 && bestSim >= AGENT_CLUSTER_COSINE_THRESHOLD) {
        const g = groups[best]!;
        g.members.push(i);
        g.centroid = meanCentroid(g.members.map((m) => vectors[m]!));
      } else {
        groups.push({ members: [i], centroid: v });
      }
    }

    for (const [gi, g] of groups.entries()) {
      // slug is already `<orgHash6>-<sigSlug>` (G1.2): the id partitions
      // frontiers/eval evidence/suite dirs for free, is SUITE_ID_RE-clean,
      // and carries no org identity on public surfaces.
      const clusterId = gi === 0 ? `agent-${slug}` : `agent-${slug}-${gi + 1}`;
      const members = g.members.map((m) => sources[m]!);
      const orgId = members[0]!.orgId; // one org per bucket by construction
      const toolSequence = members[0]!.toolSequence; // same slug ⇒ same sequence
      const suiteId = `${clusterId}-replays-v1`;
      const name = `agent: ${toolSequence.join(' → ') || 'chat'} (${slug})`;

      const existingCluster = await ctx.db
        .select({ id: clusters.id })
        .from(clusters)
        .where(eq(clusters.id, clusterId));
      const created = existingCluster.length === 0;
      if (created) {
        await ctx.db
          .insert(clusters)
          .values({
            id: clusterId,
            name,
            description:
              'Synthesized from traced agent sessions (redacted session replays) — ' +
              'M5 #36, SPEC §14.2. First-message embeddings + tool-graph signature.',
            exemplarCount: members.length,
            orgId,
          })
          .onConflictDoNothing();
      }
      // Exemplars: top up to the cap on EVERY run (pre-G1.2 they were only
      // written at creation and exemplarCount never updated — growth bug).
      const existingExemplars = await ctx.db
        .select({ id: clusterExemplars.id })
        .from(clusterExemplars)
        .where(eq(clusterExemplars.clusterId, clusterId));
      let room = AGENT_EXEMPLAR_CAP - existingExemplars.length;
      for (const m of members) {
        if (room <= 0) break;
        const srcIdx = sources.indexOf(m);
        await ctx.db
          .insert(clusterExemplars)
          .values({ clusterId, text: texts[srcIdx]!, embedding: vectors[srcIdx]! });
        room -= 1;
      }
      const totalExemplars = AGENT_EXEMPLAR_CAP - Math.max(0, room);
      await ctx.db
        .update(clusters)
        .set({ exemplarCount: totalExemplars })
        .where(eq(clusters.id, clusterId));

      // ---- synthesize the replay suite (G1.3: governed DB storage — no
      // worker-local files; org-attributed provenance row + time-windowed
      // items so trace retention governs the lifecycle). Merge/cap/version
      // semantics unchanged. NOTE: suite version is NOT part of the eval
      // cache key — per-item cache keys already make appends incremental.
      const rubric =
        `Score how well the assistant's response completes the user's request. The ` +
        `original session was an agent workflow` +
        `${toolSequence.length > 0 ? ` using tools: ${toolSequence.join(' → ')}` : ''}. ` +
        `Judge task completion and correctness only; ignore style. When a REFERENCE ` +
        `answer is provided, judge primarily by comparison against it. Redaction ` +
        `placeholders like <email>, <num>, <phone> stand for removed values and match ` +
        `any equivalent value.`;
      // G1.4 replay fidelity: multi-turn user context, a tool-transcript
      // system message when the session used tools, and the ORIGINAL
      // (redacted) final answer as the judge's reference — items degrade
      // gracefully to the single-turn reference-free shape when the trace
      // carried neither.
      const candidates = members.map((m) => {
        const srcIdx = sources.indexOf(m);
        const turnTexts =
          m.turns.length > 0
            ? m.turns.map((t) => redactTraceText(t))
            : [texts[srcIdx]!];
        const transcript = m.toolTranscript
          .map(
            (t) =>
              `${t.name}(${redactTraceText(t.args ?? '', 300)})` +
              (t.result !== undefined ? ` → ${redactTraceText(t.result, 300)}` : ''),
          )
          .join('; ');
        const prompt = [
          ...(transcript.length > 0
            ? [
                {
                  role: 'system' as const,
                  content: `Original session tool activity: ${transcript}`.slice(0, 2000),
                },
              ]
            : []),
          ...turnTexts.map((t) => ({ role: 'user' as const, content: t })),
        ];
        const reference =
          m.referenceAnswer !== null ? redactTraceText(m.referenceAnswer) : undefined;
        return {
          id: `${suiteId}-${sha1Hex(m.traceId).slice(0, 8)}`,
          clusterId,
          prompt,
          ...(reference !== undefined ? { reference } : {}),
          scoring: {
            kind: 'llm-judge' as const,
            rubric,
            judgeModel: judgeAlias,
            scale: [0, 1] as [number, number],
          },
          sourceTraceId: m.traceId,
        };
      });
      const manifest: SuiteManifest = {
        suiteId,
        clusterId,
        version: '1.0.0',
        source: {
          kind: 'authored',
          name: 'Potion trace-synthesized session replays (payloads redacted)',
          license: 'Proprietary (customer-derived, redacted) — M5 #36',
        },
        // 'items.jsonl' is the schema's file-pointer literal; in db storage
        // the real items live in derived_suite_items (this manifest is the
        // jsonb provenance record).
        items: 'items.jsonl',
        scoring: { allowed: ['llm-judge'] },
        createdAt: new Date().toISOString(),
      };
      const upsert = await upsertDerivedSuite(ctx.db, {
        suiteId,
        clusterId,
        orgId,
        manifest: manifest as unknown as Record<string, unknown>, // jsonb provenance record
        items: candidates,
        itemCap: AGENT_SUITE_ITEM_CAP,
      });
      const newItems = { length: upsert.itemsAdded };

      // ---- sweep new/extended suites on mock → first/updated frontier ----
      let evalRunId: string | null = null;
      if ((created || newItems.length > 0) && strategies.length > 0) {
        for (const [hash, config] of strategyByHash) {
          await ctx.db.insert(strategyConfigs).values({ hash, config }).onConflictDoNothing();
        }
        const summary: RunSummary = await runEval(
          {
            suiteIds: [],
            suiteV2Ids: [suiteId],
            strategies,
            budgetCapUsd: MOCK_CYCLE_BUDGET_CAP_USD,
            provider: 'mock',
            resume: true,
          },
          { db: ctx.dbHandle, pricesPath: ctx.pricesPath, suitesV2Dir },
        );
        evalRunId = summary.runId;
        result.spendUsd += summary.spendUsd;
        await ctx.db.insert(evalRuns).values({
          id: summary.runId,
          options: {
            suiteIds: [],
            suiteV2Ids: [suiteId],
            strategyHashes: [...strategyByHash.keys()],
            agentCluster: clusterId,
          },
          budgetCapUsd: MOCK_CYCLE_BUDGET_CAP_USD,
          provider: 'mock',
          status: 'completed',
          spendUsd: summary.spendUsd,
        });
        const aggregates = await aggregatesFromEvalResults(
          ctx.db,
          clusterId,
          strategies,
          prices.version,
        );
        if (aggregates.length > 0) {
          const points = computeFrontier(aggregates);
          await saveFrontier(ctx.db, clusterId, points, 'recompute', prices.version);
        }
      }

      if (created) result.clustersCreated += 1;
      else if (newItems.length > 0) result.clustersUpdated += 1;
      result.clusters.push({
        clusterId,
        slug,
        sessions: members.length,
        toolSequence,
        created,
        suiteId,
        suiteVersion: upsert.version,
        itemsAdded: newItems.length,
        evalRunId,
      });
    }
  }
  return result;
};

// ---------------------------------------------------------------------------
// M5 #36 (SPEC §14.3): traces:purge — nightly retention enforcement.
// retention_days > 0 → delete spans older than N days; 0 → "metadata only":
// redact the payload column (attrs) and keep span metadata. Idempotent.
// ---------------------------------------------------------------------------

export interface TracesPurgeResult {
  orgs: number;
  redacted: number;
  deleted: number;
  /** G1.3: derived-suite items purged under the same retention. */
  derivedItemsDeleted: number;
  derivedSuitesEmptied: number;
  perOrg: {
    orgId: string;
    retentionDays: number;
    redacted: number;
    deleted: number;
    itemsDeleted: number;
    suitesEmptied: number;
  }[];
}

/** G1.1: PII-redaction backfill over existing trace_spans (idempotent). */
export const tracesRedactHandler: WorkerHandler<'traces:redact'> = async (payload, ctx) => {
  const result = await backfillRedactSpans(ctx.db, payload.orgId);
  return result; // { scanned, updated }
};

export const tracesPurgeHandler: WorkerHandler<'traces:purge'> = async (
  payload: TracesPurgePayload,
  ctx: JobContext,
): Promise<TracesPurgeResult> => {
  const orgIds =
    payload.orgId !== undefined ? [payload.orgId] : await listOrgIdsWithSpans(ctx.db);
  const result: TracesPurgeResult = {
    orgs: 0,
    redacted: 0,
    deleted: 0,
    derivedItemsDeleted: 0,
    derivedSuitesEmptied: 0,
    perOrg: [],
  };
  for (const orgId of orgIds) {
    const days = await getOrgTraceRetentionDays(ctx.db, orgId);
    if (days === null) continue; // org vanished between fan-out and purge
    let redacted = 0;
    let deleted = 0;
    // G1.3: derived suites follow the SAME retention as spans — days=0
    // ("metadata only") empties the org's replay items but keeps the
    // provenance rows; days>0 purges items past the same cutoff. Frontiers/
    // eval_results built from purged items are NOT cascade-deleted (mock-only
    // + provenance-guarded; retirement policy is a recorded G1.6 decision).
    let derived: { itemsDeleted: number; suitesEmptied: number };
    if (days === 0) {
      redacted = await redactSpanAttrs(ctx.db, orgId);
      derived = await purgeDerivedSuiteItems(ctx.db, orgId, 'all');
    } else {
      const cutoff = new Date(Date.now() - days * 86_400_000);
      deleted = await deleteSpansOlderThan(ctx.db, orgId, cutoff);
      derived = await purgeDerivedSuiteItems(ctx.db, orgId, cutoff);
    }
    result.orgs += 1;
    result.redacted += redacted;
    result.deleted += deleted;
    result.derivedItemsDeleted += derived.itemsDeleted;
    result.derivedSuitesEmptied += derived.suitesEmptied;
    result.perOrg.push({ orgId, retentionDays: days, redacted, deleted, ...derived });
  }
  return result;
};

export const defaultHandlers: { [K in keyof JobPayloads]: WorkerHandler<K> } = {
  'eval:run': evalRunHandler,
  'sweep:run': sweepRunHandler,
  'staleness:scan': stalenessScanHandler,
  'shadow:judge': shadowJudgeHandler,
  'guarantee:evaluate': guaranteeEvaluateHandler,
  'alerts:dispatch': alertsDispatchHandler,
  'budget:evaluate': budgetEvaluateHandler,
  // ---- M4b #37 autoresearcher ----
  'research:scan': researchScanHandler,
  'research:cycle': researchCycleHandler,
  // ---- M5 #36 agent workloads ----
  'traces:cluster': tracesClusterHandler,
  'traces:purge': tracesPurgeHandler,
  'traces:redact': tracesRedactHandler,
};

/** Compute the strategy_configs hash for a config (re-export of core helper,
 * so the server can register strategies without importing core directly). */
export function hashStrategy(config: StrategyConfig): string {
  return strategyHash(config);
}
