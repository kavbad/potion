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
  | 'frontier:live-sweep';

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
