// Worker job kinds + payloads (SPEC §12.2). Payloads travel through the queue
// as plain JSON; orgId is carried on every job enqueued via the server so job
// reads stay org-scoped (the worker itself is org-agnostic).
import type { Policy, StrategyConfig } from '@potion/core';
import type { AlertEvent } from '@potion/db';

export type JobKind =
  | 'eval:run'
  | 'sweep:run'
  | 'staleness:scan'
  | 'shadow:judge'
  | 'guarantee:evaluate'
  | 'alerts:dispatch'
  | 'budget:evaluate'
  // ---- M4b #37 autoresearcher (SPEC §15.2/§15.3) ----
  | 'research:scan'
  | 'research:cycle'
  // ---- M5 #36 agent workloads (SPEC §14.2/§14.3) ----
  | 'traces:cluster'
  | 'traces:purge'
  | 'traces:redact'
  // ---- G1.5 automated scorer construction ----
  | 'rubric:generate'
  // ---- G1.7 live capped org evals ----
  | 'frontier:live-sweep'
  // ---- Lab Step 5: platform-scope live sweep (taxonomy clusters) ----
  | 'frontier:platform-sweep'
  // ---- Lab Step 8: trial-run executor (legs until terminal/awaiting) ----
  | 'lab:run'
  // ---- Lab Step 10: best-effort provider-side grant revocation ----
  | 'lab:grant-revoke'
  // ---- G2.7 operator org deletion ----
  | 'org:delete'
  // ---- G2.1 trust hierarchy: contractual suite re-eval ----
  | 'guarantee:suite-verify'
  // ---- Post-capstone item 3: suite-validity certification (Decision 2) ----
  | 'suite:certify'
  | 'learning:period'
  // ---- S7 L4: the autonomous probe (demand → capped measurement) ----
  | 'learning:probe';

export const JOB_KINDS: readonly JobKind[] = [
  'eval:run',
  'sweep:run',
  'staleness:scan',
  'shadow:judge',
  'guarantee:evaluate',
  'alerts:dispatch',
  'budget:evaluate',
  'research:scan',
  'research:cycle',
  'traces:cluster',
  'traces:purge',
  'traces:redact',
  'rubric:generate',
  'frontier:live-sweep',
  'frontier:platform-sweep',
  'lab:run',
  'lab:grant-revoke',
  'org:delete',
  'guarantee:suite-verify',
  'suite:certify',
  'learning:period',
  'learning:probe',
] as const;

export interface EvalRunPayload {
  suiteIds: string[];
  /** strategy_configs hashes; configs are loaded from the db at run time. */
  strategyHashes: string[];
  /** Budget cap in USD (harness preflight-enforced). Default: 10. */
  capUsd?: number;
  /** Org that enqueued the job (scoping metadata; server-injected). */
  orgId?: string;
}

export interface SweepRunPayload {
  suiteIds: string[];
  strategies: StrategyConfig[];
  capUsd: number;
  orgId?: string;
}

export interface StalenessScanPayload {
  orgId?: string;
}

export interface ShadowJudgePayload {
  shadowResultId: string;
  orgId?: string;
}

/**
 * Quality-guarantee evaluation (M3 #22 → G0.1, SPEC §12.5) — ADDITIVE
 * JobKind. Two modes, both CONTENT-FREE (G0.1: scoring happens on the
 * server via a real llm-judge call BEFORE this job is enqueued — raw
 * prompts/answers never transit the queue):
 *   per-target — orgId + clusterId + strategyHash + policy: evaluate the
 *     rolling breach window for one (org, cluster, strategy, policy).
 *   sweep — fields absent: re-evaluate every guarantee-carrying policy
 *     against its org's recently sampled strategies (clusters are recovered
 *     from the current frontier's points).
 */
export interface GuaranteeEvaluatePayload {
  orgId?: string;
  /** G0.3: evidence is keyed (org, policy, cluster, strategy). */
  policyId?: string;
  clusterId?: string;
  strategyHash?: string;
  /** The governing policy (carries the guarantee config); sweep mode loads
   * guarantee-carrying policies from the db instead. */
  policy?: Policy;
}

export interface JobPayloads {
  'eval:run': EvalRunPayload;
  'sweep:run': SweepRunPayload;
  'staleness:scan': StalenessScanPayload;
  'shadow:judge': ShadowJudgePayload;
  'guarantee:evaluate': GuaranteeEvaluatePayload;
  'alerts:dispatch': AlertsDispatchPayload;
  'budget:evaluate': BudgetEvaluatePayload;
  'research:scan': ResearchScanPayload;
  'research:cycle': ResearchCyclePayload;
  // ---- M5 #36 agent workloads (SPEC §14) ----
  'traces:cluster': TracesClusterPayload;
  'traces:purge': TracesPurgePayload;
  'traces:redact': TracesRedactPayload;
  'rubric:generate': RubricGeneratePayload;
  'frontier:live-sweep': FrontierLiveSweepPayload;
  'frontier:platform-sweep': FrontierPlatformSweepPayload;
  'lab:run': LabRunJobPayload;
  'lab:grant-revoke': LabGrantRevokePayload;
  'org:delete': OrgDeletePayload;
  'guarantee:suite-verify': GuaranteeSuiteVerifyPayload;
  'suite:certify': SuiteCertifyPayload;
  'learning:period': LearningPeriodPayload;
  'learning:probe': LearningProbePayload;
}

/**
 * S7 L4 — measure the demand nobody has measured yet.
 *
 * Ranks published demand cells against live measured evidence, takes the
 * worst gap a platform sweep can close, and runs that sweep under a cap
 * drawn from the operator's standing daily authorization. Every run writes
 * its own ledger row (projected before, actual after), including refusals.
 *
 * With `POTION_AUTONOMOUS_LEARNING_DAILY_USD` unset the job still runs and
 * still plans; it refuses to spend. That is the "propose, don't buy" mode.
 */
export interface LearningProbePayload {
  /** Plan and ledger it as 'planned', but do not execute. */
  dryRun?: boolean;
  /** Override the per-run cap DOWNWARD only; the daily cap still binds. */
  capUsd?: number;
  /** Passed through to the sweep when the pool exceeds its width ceiling. */
  maxAnswerers?: number;
  /** Only consider demand at or after this ISO week start. */
  sinceWeek?: string;
}

/**
 * Agent-session clustering (M5 #36, SPEC §14.2): embed first-user-messages
 * (redacted), bucket by tool-graph signature, greedy-cosine into `agent-*`
 * clusters, register them (+ exemplars) so the SAME frontier pipeline can
 * serve them, synthesize redacted replay suites, and run the first mock
 * sweep per new cluster. Nightly + on-demand (POST /api/traces/cluster).
 */
export interface TracesClusterPayload {
  /** Restrict to one org (default: all orgs with spans in the window). */
  orgId?: string;
  /** Lookback window in days (default 7). */
  sinceDays?: number;
  /** Max sessions to cluster (default 500). */
  limit?: number;
}

/**
 * Trace retention purge (M5 #36, SPEC §14.3): nightly. Per org:
 * trace_retention_days > 0 → delete spans older than N days; 0 → redact
 * attrs (metadata only). Idempotent.
 */
export interface TracesPurgePayload {
  /** Restrict to one org (default: every org holding spans). */
  orgId?: string;
}

/** G1.1 PII-redaction backfill: re-run the platform redactor over existing
 * span attrs (pre-ingest-redaction rows). Idempotent — a second run updates
 * 0 rows. orgId narrows to one org (admin route forces the caller's). */
export interface TracesRedactPayload {
  orgId?: string;
}

/**
 * Alert dispatch (M4 #33, SPEC §13.5) — one job per emitted alert EVENT.
 * The handler resolves the org's ENABLED rules subscribed to `event` and
 * POSTs each one (webhook JSON / slack {text}); per-rule outcomes land in
 * alert_deliveries (target_url NEVER copied — query strings redacted in
 * errors).
 */
export interface AlertsDispatchPayload {
  orgId: string;
  event: AlertEvent;
  /** Event detail (incident detail / budget numbers / breaker key). */
  detail?: Record<string, unknown>;
  /** G2.2: the incident this notification concerns (audit correlation;
   * absent for incident-less events — budget_*, breaker_open,
   * recipe_promoted). */
  incidentId?: string;
  /**
   * G2.2: the SLA clock start the EMITTER binds (ISO). STANDING DECISION,
   * verbatim: "SLA clocks start at advisory creation; notification latency
   * is measured to the contractual verdict." Per-event semantics:
   *   quality_breach/rollback (suite leg)  → the ADVISORY's createdAt when
   *     one is attached (the binding above), else the verdict incident's;
   *   quality_breach/rollback (legacy)     → the breach incident's createdAt;
   *   guarantee_unverifiable               → the advisory's createdAt (the
   *     clock keeps running while verification starves);
   *   guarantee_restored / guarantee_recovery_unconfirmed → the rollback
   *     incident's createdAt (latency = time-to-restore);
   *   budget_* / breaker_open / recipe_promoted → absent (latency NULL).
   * Measured at the SUCCESSFUL POST; on the memory queue a long job ahead
   * of the dispatch inflates it — that is HONEST end-to-end latency.
   */
  clockStartAt?: string;
}

/**
 * Budget evaluation (M4 #35, SPEC §13.7) — the nightly autopilot sweep.
 * Per org with a budget row: last-7-day vs trailing-30-day z-score anomaly,
 * MTD linear forecast vs cap, warn_pct crossing, cap exceeded. Deduped per
 * (org, kind, UTC day) via the budget_events ledger; emits alerts:dispatch
 * jobs for fresh events. orgId set → that org only.
 */
export interface BudgetEvaluatePayload {
  orgId?: string;
}

/**
 * New-model detection (M4b #37, SPEC §15.2): diff a provider's /models
 * listing against the prices.json registry, append new entries (per-token
 * pricing × 1e6), then enqueue one research:cycle per new alias (cap 3 per
 * scan). 'mock' (default) reads the deterministic mockModels() fixture —
 * zero network, CI-safe; 'openrouter' does a live GET /models and needs
 * OPENROUTER_API_KEY in the worker's env.
 */
export interface ResearchScanPayload {
  source?: 'mock' | 'openrouter';
  orgId?: string;
}

/**
 * One autoresearcher cycle (M4b #37, SPEC §15.3): generate candidates
 * (template grammar × class-pruned registry, ≤20), sweep them over the
 * standard v2 suite set into the content-addressed eval cache, then run the
 * §15.4 promotion gate per cluster. Live cycles (POTION_RESEARCH_PROVIDER=
 * live, operator-enabled) are budget-capped at capUsd (default $5.00) with
 * spend ledgered on the cycle row — the research ledger is SEPARATE from
 * the M1b cap. Mock cycles are uncapped and can SHORTLIST (candidate state)
 * but never PROMOTE (promotion is live-provenance only, §15.4).
 */
export interface ResearchCyclePayload {
  /** New-model alias a scan-triggered cycle focuses on. */
  focusAlias?: string;
  /** v2 suite ids to sweep; default RESEARCH_V2_SUITE_IDS. */
  suiteV2Ids?: string[];
  /** Live-cycle spend cap (default $5.00, SPEC §15.3). */
  capUsd?: number;
  /** Narrow the cycle to ONE registered strategy_configs hash
   * (POST /api/recipes/:hash/evaluate). */
  recipeHash?: string;
  /** Origin recorded on the cycle row (default 'manual'). */
  trigger?: 'scan' | 'manual' | 'schedule';
  /** mulberry32 seed for the promotion-gate bootstrap (recorded on the row;
   * random when omitted). */
  seed?: number;
  orgId?: string;
}

/**
 * Per-cluster rubric generation (G1.5, admin-triggered only — never in the
 * nightly loop): one capped LLM call over the cluster's redacted exemplars
 * produces a CANDIDATE rubric (status 'pending'), which is probe-calibrated
 * against constructed truth from the suite's G1.4 references and metered as
 * request_logs status='rubric_gen'. Nothing is IN FORCE until a human
 * approves it (POST /api/rubrics/:id/approve). POTION_RUBRIC_PROVIDER=live
 * env-gates live generation; the default mock path is deterministic with
 * provider_mode='mock' persisted (honest provenance).
 */
export interface RubricGeneratePayload {
  orgId: string;
  clusterId: string;
  /** Live spend cap (default $1.00). */
  capUsd?: number;
  /** Probe-derangement seed (default: derived from the suite id). */
  seed?: number;
}

/**
 * Live capped eval sweep of one org's derived replay suite (G1.7):
 * env-gated (POTION_EVAL_PROVIDER=live — REFUSES otherwise, never degrades
 * to mock: a "live sweep" that mocks is the false-live pattern), org-budget
 * hard-stop checked FAIL-CLOSED before any spend, strategies/judge = live
 * class representatives (mock excluded), spend metered as request_logs
 * status='eval_live' (customer-attributable via the usage rollup), and the
 * resulting all-live org frontier becomes servable through the G1.6
 * org-preferred read + provenance guard. Admin-triggered only.
 */
/**
 * G2.1 trust hierarchy — the CONTRACTUAL leg. Enqueued when the advisory
 * serve leg trips (or manually): re-evaluate the SERVING strategy and the
 * org's DESIGNATED INCUMBENT on the derived suite and render the retention
 * verdict from suite evidence only. Runs in the env's provider mode with
 * providerMode-stamped verdicts (mock deployments render mock-labeled
 * verdicts; modes structurally cannot mix in the pairing).
 */
export interface GuaranteeSuiteVerifyPayload {
  orgId: string;
  /** The guarantee-carrying policy row (config + retentionFloor source). */
  policyId: string;
  clusterId: string;
  /** The strategy whose retention is on trial. */
  servingStrategyHash: string;
  /** Eval spend cap (live mode; default $5, live-sweep precedent). */
  capUsd?: number;
  /** The open advisory this verify resolves (threaded by the sweep retry
   * pass AND the manual route since G2.2). */
  advisoryIncidentId?: string;
  /** G2.2 auto-restore: the active rollback incident this verify may lift
   * on CONFIDENT recovery (retention CI95 lower ≥ floor). Set only by the
   * sweep's auto-restore pass. */
  restoreForIncidentId?: string;
}

/**
 * Post-capstone item 3 (Decision 2): certify a derived suite for guarantee
 * use by FRESH-re-evaluating the org's designated incumbent against it and
 * comparing self-retention to the certification floor. Every outcome —
 * certified, failed, or a recorded refusal — writes a durable
 * suite_certifications row at the handler's chokepoint. Admin-triggered.
 */
export interface SuiteCertifyPayload {
  /** Required: /api/jobs/:id reads are org-gated on payload.orgId. */
  orgId: string;
  clusterId: string;
  /** Address a SPECIFIC suite generation (e.g. `-replays-v1` for the
   * session-vs-step comparability leg). Default: the cluster's current
   * suite via derivedSuiteIdFor. Must belong to the cluster. */
  suiteId?: string;
  /** Live spend cap; default derives from item count (suite-verify rule,
   * 1 strategy). */
  capUsd?: number;
}

export interface FrontierLiveSweepPayload {
  orgId: string;
  clusterId: string;
  /** Live spend cap (default $5). */
  capUsd?: number;
  /** Judge completion budget (default 768 — G1.1 finding). */
  judgeMaxTokens?: number;
  /** Answer output ceiling (default 1600 — G1.1: best answers hit 1501). */
  maxOutputTokens?: number;
  seed?: number;
}

/**
 * Lab Step 5: live sweep of ONE taxonomy cluster at PLATFORM scope. No
 * orgId — that absence is the point: evidence lands org-NULL (the platform
 * default `aggregatesFromEvalResults` reads), cache keys carry no org
 * segment, and the published frontier joins the platform chain every
 * fallback-riding org inherits. Spend (request_logs is NOT NULL on org)
 * meters under the reserved PLATFORM_OPS_ORG_ID — spend attribution and
 * evidence attribution are deliberately different things (the F12 line).
 * Env-gated (POTION_EVAL_PROVIDER=live, refuses, never degrades); capUsd
 * REQUIRED — no default: platform spend is operator money and only an
 * explicitly approved number authorizes it. Operator-triggered only.
 */
/**
 * Lab Step 8: execute a trial run's legs until terminal or awaiting-human.
 * Custody: each invocation mints an EPHEMERAL run-scoped serve key (raw
 * never persisted; hash via the existing key machinery; policy-bound to
 * the harness's materialized brain row) and revokes it before returning —
 * including on the fence/reclaim path, where any surviving key from a
 * zombie invocation is revoked on entry (review outcome 1).
 */
export interface LabRunJobPayload {
  orgId: string;
  runId: string;
  /** Present on answer-resume enqueues. */
  answer?: string;
}

/**
 * Lab Step 10: after the /revoke route marks a grant 'revoked' (the local
 * source of truth, immediate), this job makes the BEST-EFFORT provider-side
 * revocation call — the only place outside lab:run that opens a grant, and
 * it opens a row already typed 'revoked' purely to kill the token upstream.
 * Failure is recorded in the job result, never retried into a storm, and
 * never un-revokes anything.
 */
export interface LabGrantRevokePayload {
  orgId: string;
  connectorId: string;
}

export interface FrontierPlatformSweepPayload {
  /** Taxonomy cluster (org_id NULL); org-owned clusters are refused. */
  clusterId: string;
  /** REQUIRED live spend cap for this cluster leg. Absent → refusal. */
  capUsd: number;
  /** Deterministic sample: first N items sorted by item id (byte-stable →
   * stable cache keys; a later full run pays only for the remainder). */
  sampleN?: number;
  /** Judge completion budget (default 768 — the org sweep's knob). */
  judgeMaxTokens?: number;
  /** Answer output ceiling (default 1600 — uniform across candidates:
   * per-candidate ceilings would change what is being measured). */
  maxOutputTokens?: number;
  /**
   * S6 width knob: how many reachable answerer models this leg may measure.
   * Absent → PLATFORM_SWEEP_MAX_ANSWERERS. The sweep evaluates EVERY
   * reachable answerer up to this ceiling (deterministic price order), and
   * reports any it dropped rather than silently measuring less.
   */
  maxAnswerers?: number;
  /**
   * S7 L4: restrict the answerer pool to models that can actually serve the
   * demand this sweep is closing.
   *
   * Class membership answers "how good and how expensive"; it says nothing
   * about whether a model can take a tool definition or hold a 60k prompt.
   * A sweep launched to close a `no_tool_capable_point` gap that measured
   * tool-incapable models would spend real money and leave the gap exactly
   * where it was — while reporting new measured points, which is worse than
   * not running.
   *
   * UNKNOWN CAPABILITY IS EXCLUDED, never assumed: models.supports_tools and
   * context_length are nullable because a provider may not report them.
   */
  capabilityFilter?: {
    /** Keep only models KNOWN to support tool calling. */
    tools?: boolean;
    /** Keep only models whose KNOWN context window is at least this. */
    minContextTokens?: number;
  };
  /**
   * Observatory AUDITION (OBSERVATORY.md §2, rung 3): measure ONLY these
   * answerer aliases on this cluster. The previous frontier's incumbents still
   * join by right (carry-forward), re-aggregating from cache at $0, so the
   * candidate is compared against the real frontier — but nothing else is
   * paid for. Empty intersection with the reachable pool → refusal, never a
   * silent no-op that reports success.
   */
  auditionModels?: string[];
  /**
   * Observatory canary / dry measurement: measure and return points but
   * NEVER save a frontier version. Default true.
   */
  publish?: boolean;
  /** Observatory canary: salt the eval cache key so cells re-execute. */
  cacheSalt?: string;
  /** Per-attempt provider timeout (ms). Absent → PLATFORM_SWEEP_TIMEOUT_MS. */
  providerTimeoutMs?: number;
  /** Retry attempts past the first. Absent → PLATFORM_SWEEP_MAX_RETRIES. */
  providerMaxRetries?: number;
  /** MIXING M3 (2026-08-23): measure on a suite other than the cluster's
   * default — the tool-calling suite, whose items carry tools. Points
   * measured on it carry evidence.toolsMeasured. */
  suiteOverride?: { kind: 'v1' | 'v2'; suiteId: string };
  /** MIXING M3: combinations to measure alongside the singles, verbatim —
   * the tools filter and audition mode otherwise measure singles only. */
  extraShapes?: StrategyConfig[];
  /** MIXING M3: the instrument this leg measures on; its aggregates,
   * previous frontier and published frontier all live under it. */
  instrument?: 'default' | 'tools' | 'vision';
}

/**
 * TRUE-CASCADE org deletion (G2.7, operator-triggered only): deletes the
 * org and EVERYTHING derived from it — evidence rows and tombstones
 * included, per the deletion-semantics carve-out (operational purge stays
 * stale-never-delete; org-level deletion knowingly sacrifices
 * explainability). Refuses org_demo. Idempotent.
 */
export interface OrgDeletePayload {
  orgId: string;
}

/** The learning period (2026-08-22): one org, or every org with sampled requests. */
export interface LearningPeriodPayload {
  orgId?: string;
}
