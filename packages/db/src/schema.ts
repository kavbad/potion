// Drizzle pg-schema for the 12 Potion tables (SPEC §7), columns aligned with
// @potion/core types. One schema drives both drivers: PGlite (tests/dev) and
// node-postgres (local/prod via docker-compose).
import {
  bigserial,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type {
  ChatMessage,
  EvalResult,
  FrontierPoint,
  Policy,
  ScoringMethod,
  StrategyConfig,
  Usage,
  FrontierPointEvidence,
} from '@potion/core';

// ---------------------------------------------------------------------------
// Tenancy (M2 Wave 1, migration 0003, ROADMAP #13): every customer asset
// hangs off an org. api_keys/provider_keys/policies/request_logs carry
// org_id NOT NULL → orgs.id. Frontiers/clusters/taxonomy stay shared-GLOBAL
// by design — the routing evidence base is a platform asset, not tenant data.
// ---------------------------------------------------------------------------

/** Membership role within an org — the RBAC anchor Wave-2 auth (#14) builds on. */
export type Role = 'admin' | 'member' | 'viewer';
export const ROLES: readonly Role[] = ['admin', 'member', 'viewer'];

/** The seeded default org (migration 0003): backfill target + demo tenant. */
export const DEFAULT_ORG_ID = 'org_demo';

export const orgs = pgTable('orgs', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /** Leaderboard opt-in (M4, ROADMAP #34, migration 0012) — read by the
   * public leaderboard (ROADMAP #32). Default false: orgs stay private
   * unless they explicitly opt in. */
  publishToLeaderboard: boolean('publish_to_leaderboard').notNull().default(false),
  /** Trace retention (M5 #36, SPEC §14.3, migration 0015): spans older than
   * N days are purged nightly; 0 = metadata only (attrs redacted). */
  traceRetentionDays: integer('trace_retention_days').notNull().default(30),
});

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const memberships = pgTable(
  'memberships',
  {
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    role: text('role').$type<Role>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.userId] }),
    check('memberships_role_check', sql`role IN ('admin', 'member', 'viewer')`),
  ],
);

// ---------------------------------------------------------------------------
// Auth (M2 Wave 2, migration 0004, ROADMAP #14): magic-link sign-in + user
// sessions. Raw tokens are NEVER stored — sha256 hashes only (token_hash).
// A session is pinned to the org the user signed into; the role comes from
// memberships via resolveOrgContext's session path.
// ---------------------------------------------------------------------------

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  /** sha256 of the raw `ps_…` bearer/cookie token — the raw token is never
   * stored. Globally unique: it IS the session's lookup identity. */
  tokenHash: text('token_hash').notNull().unique(),
  /** The org this session is pinned to (chosen at verify time). */
  orgId: text('org_id')
    .notNull()
    .references(() => orgs.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  /** Set on logout; null while the session is live. */
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

export const magicLinks = pgTable('magic_links', {
  /** sha256 of the raw `ml_…` token — primary key (single-use lookup). */
  tokenHash: text('token_hash').primaryKey(),
  /** Email, not user_id: a link can target a not-yet-provisioned user
   * (first-signup auto-provision + invite flows both verify by email). */
  email: text('email').notNull(),
  /** Org the resulting session is pinned to (inviter's org for invites, the
   * user's own org for sign-in links). */
  orgId: text('org_id')
    .notNull()
    .references(() => orgs.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  /** Set at consume time — single-use enforcement (atomic UPDATE … WHERE
   * consumed_at IS NULL in consumeMagicLink). */
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const clusters = pgTable('clusters', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  exemplarCount: integer('exemplar_count').notNull().default(0),
  /** G1.2 (0020): NULL = platform (taxonomy + grandfathered pre-G1.2 agent
   * rows); non-NULL = the owning org. Ownership checks read this column;
   * new agent clusters are also id-partitioned (agent-<orgHash6>-<slug>). */
  orgId: text('org_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const clusterExemplars = pgTable('cluster_exemplars', {
  id: serial('id').primaryKey(),
  clusterId: text('cluster_id')
    .notNull()
    .references(() => clusters.id),
  text: text('text').notNull(),
  embedding: vector('embedding', { dimensions: 384 }),
});

export const models = pgTable('models', {
  alias: text('alias').primaryKey(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  inputPer1M: doublePrecision('input_per_1m').notNull(),
  outputPer1M: doublePrecision('output_per_1m').notNull(),
  pricesVersion: text('prices_version').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const strategyConfigs = pgTable('strategy_configs', {
  hash: text('hash').primaryKey(),
  config: jsonb('config').$type<StrategyConfig>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const evalItems = pgTable('eval_items', {
  id: text('id').primaryKey(),
  clusterId: text('cluster_id').notNull(),
  prompt: jsonb('prompt').$type<ChatMessage[]>().notNull(),
  reference: jsonb('reference'),
  scoring: jsonb('scoring').$type<ScoringMethod>().notNull(),
});

export const evalRuns = pgTable('eval_runs', {
  id: text('id').primaryKey(),
  options: jsonb('options').notNull(),
  budgetCapUsd: doublePrecision('budget_cap_usd').notNull(),
  provider: text('provider').notNull().default('mock'),
  status: text('status').notNull().default('pending'),
  /** Tenant attribution (G1.6); NULL = platform run. */
  orgId: text('org_id').references(() => orgs.id),
  spendUsd: doublePrecision('spend_usd').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const evalResults = pgTable('eval_results', {
  cacheKey: text('cache_key').primaryKey(),
  runId: text('run_id').notNull(),
  itemId: text('item_id').notNull(),
  clusterId: text('cluster_id').notNull(),
  strategyHash: text('strategy_hash').notNull(),
  strategyConfig: jsonb('strategy_config').$type<StrategyConfig>().notNull(),
  quality: doublePrecision('quality').notNull(),
  scorer: text('scorer').notNull(),
  judgeAgreement: doublePrecision('judge_agreement'),
  usage: jsonb('usage').$type<Usage>().notNull(),
  latencyMs: jsonb('latency_ms').$type<EvalResult['latencyMs']>().notNull(),
  modelVersions: jsonb('model_versions').$type<Record<string, string>>().notNull(),
  pricesVersion: text('prices_version').notNull(),
  /** Evidence provenance (M1a, migration 0002): 'mock' | 'live' | 'unknown'.
   * 'unknown' == never recorded; treated as simulated everywhere. */
  providerMode: text('provider_mode').notNull().default('unknown'),
  /** M1a staleness engine: true when prices/judge/model versions drifted. */
  /** Tenant attribution (G1.6); NULL = platform evidence. NOT part of the
   * cacheKey identity (org item ids are org-partitioned — G1.7 flag). */
  orgId: text('org_id').references(() => orgs.id),
  stale: boolean('stale').notNull().default(false),
  createdAt: text('created_at').notNull(), // ISO, matches core EvalResult
});

export const frontiers = pgTable('frontiers', {
  id: text('id').primaryKey(),
  clusterId: text('cluster_id').notNull(),
  version: integer('version').notNull(),
  parentId: text('parent_id'),
  trigger: text('trigger').notNull(), // 'manual' | 'new-model' | 'recompute'
  points: jsonb('points').$type<FrontierPoint[]>().notNull(),
  /** Tenant scope (G1.6); NULL = platform. Unique (org, cluster, version)
   * NULLS NOT DISTINCT — the saveFrontier race fix. Chains are scope-exact. */
  orgId: text('org_id').references(() => orgs.id),
  pricesVersion: text('prices_version').notNull(),
  createdAt: text('created_at').notNull(), // ISO, matches core Frontier
});

export const frontierPoints = pgTable('frontier_points', {
  id: serial('id').primaryKey(),
  frontierId: text('frontier_id')
    .notNull()
    .references(() => frontiers.id),
  clusterId: text('cluster_id').notNull(),
  strategyHash: text('strategy_hash').notNull(),
  strategyConfig: jsonb('strategy_config').$type<StrategyConfig>().notNull(),
  quality: doublePrecision('quality').notNull(),
  costPer1K: doublePrecision('cost_per_1k').notNull(),
  latencyP95: doublePrecision('latency_p95').notNull(),
  /** Evidence provenance (M1a, migration 0002): 'mock' | 'live' | 'unknown'. */
  orgId: text('org_id').references(() => orgs.id),
  /** G1.6 provenance mirror (owner rule): the same evidence object that
   * rides in frontiers.points jsonb, SQL-queryable for audit. */
  evidence: jsonb('evidence').$type<FrontierPointEvidence>(),
  providerMode: text('provider_mode').notNull().default('unknown'),
});

export const policies = pgTable('policies', {
  id: text('id').primaryKey(),
  /** Tenant scope (M2 #13): every policy belongs to exactly one org. */
  orgId: text('org_id')
    .notNull()
    .references(() => orgs.id),
  name: text('name').notNull(),
  config: jsonb('config').$type<Policy>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const apiKeys = pgTable('api_keys', {
  id: text('id').primaryKey(),
  /** key_hash stays GLOBALLY unique: it is the identity anchor for bearer
   * auth (token → row → org). One raw key = one org. */
  keyHash: text('key_hash').notNull().unique(),
  name: text('name').notNull(),
  /** Tenant scope (M2 #13): every api key belongs to exactly one org. */
  orgId: text('org_id')
    .notNull()
    .references(() => orgs.id),
  policyId: text('policy_id').references(() => policies.id),
  // ---- lifecycle (M2 Wave 2, ROADMAP #15, migration 0005) ----
  /** Space-separated scopes. Minimal v1 vocabulary: 'serve' (default —
   * /v1/chat/completions only) and 'serve+admin' (adds key-lifecycle admin
   * mutations via requireRole). Enforcement documented in
   * apps/server/src/auth.ts (API_KEY_ADMIN_SCOPE). */
  scopes: text('scopes').notNull().default('serve'),
  /** 'live' (default) | 'test' — a label: test keys serve identically but are
   * badgeable in the dashboard/billing exports. */
  env: text('env').$type<ApiKeyEnv>().notNull().default('live'),
  /** Set on revoke — the auth hot path 401s revoked keys. */
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  /** Optional hard expiry — the auth hot path 401s expired keys. */
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  // Per-key rate-limit overrides (M2 Wave 2, ROADMAP #17, migration 0006).
  // NULL = platform default (10 req/s, 10k req/day, 1 MiB body — see
  // apps/server/src/middleware/ratelimit.ts DEFAULT_RATE_LIMIT).
  rateRps: integer('rate_rps'),
  dailyCap: integer('daily_cap'),
  maxBodyKb: integer('max_body_kb'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const requestLogs = pgTable('request_logs', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
  /** Tenant scope (M2 #13). Unauthenticated requests (bad/missing key, 400s
   * before auth) have no tenant; they are recorded under DEFAULT_ORG_ID so
   * the NOT NULL invariant holds (documented in apps/server chat route). */
  orgId: text('org_id')
    .notNull()
    .references(() => orgs.id),
  apiKeyId: text('api_key_id'),
  clusterId: text('cluster_id'),
  strategyHash: text('strategy_hash'),
  frontierVersion: integer('frontier_version'),
  policyType: text('policy_type'),
  /** M4 #30 (SPEC §13.1, migration 0009): the policy row that SERVED the
   * request — the api key's bound policy by default, or the X-Potion-Policy
   * per-request override when present. Correlation label only (no FK):
   * log rows outlive policy rows. */
  policyId: text('policy_id'),
  model: text('model'),
  usage: jsonb('usage').$type<Usage>(),
  latencyMs: doublePrecision('latency_ms'),
  status: text('status'),
  /** Chat completion id (chatcmpl-…) — correlation label, not an FK (G2.1):
   * joins quality_samples.request_id so quality meets spend/latency. NULL on
   * pre-G2.1 rows and pre-generation failures. */
  completionId: text('completion_id'),
  trace: text('trace'),
});

/**
 * Provider keys with REAL custody (Phase 5 additive migration 0001; custody
 * added in M2 Wave 2 / ROADMAP #16, migration 0005). The raw key is held as
 * an AES-256-GCM envelope ciphertext (per-key data key wrapped by the master
 * key — see apps/server/src/custody/); the masked display form and a sha256
 * dedup hash sit alongside. Pre-0005 rows have ciphertext NULL — legacy
 * masked-only refs that can never serve.
 */
export type ProviderKeyStatus = 'active' | 'revoked' | 'rotating';
export const PROVIDER_KEY_STATUSES: readonly ProviderKeyStatus[] = [
  'active',
  'revoked',
  'rotating',
];

/** api_keys.env label (migration 0005). */
export type ApiKeyEnv = 'live' | 'test';
export const API_KEY_ENVS: readonly ApiKeyEnv[] = ['live', 'test'];

export const providerKeys = pgTable(
  'provider_keys',
  {
    id: text('id').primaryKey(),
    /** Tenant scope (M2 #13): every provider-key ref belongs to one org. */
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id),
    provider: text('provider').notNull(),
    name: text('name').notNull(),
    maskedKey: text('masked_key').notNull(),
    /** sha256 dedup hash — unique PER ORG (migration 0003), not globally:
     * two orgs may register the same raw key; custody is per-org (#16). */
    keyHash: text('key_hash').notNull(),
    // ---- custody + lifecycle (M2 Wave 2 #16, migration 0005) ----
    /** Envelope ciphertext ('v1.<base64url JSON>' — see custody/envelope.ts).
     * NEVER plaintext; NULL on legacy masked-only rows. */
    ciphertext: text('ciphertext'),
    /** Bumped on every raw-key rotation (POST /api/keys/:id/rotate). */
    keyVersion: integer('key_version').notNull().default(1),
    /** Only 'active' rows with a ciphertext are eligible for serving. */
    status: text('status').$type<ProviderKeyStatus>().notNull().default('active'),
    /** Set by POST /api/keys/:id/validate (test call through the provider). */
    lastValidatedAt: timestamp('last_validated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('provider_keys_org_key_hash_key').on(t.orgId, t.keyHash)],
);

/**
 * Custody audit trail (M2 Wave 2, ROADMAP #16, migration 0005) — append-only:
 * every encrypt (register), decrypt (serving path), rotate, revoke and
 * validate writes a row. metadata NEVER carries key material.
 */
export type CustodyAction = 'encrypt' | 'decrypt' | 'rotate' | 'revoke' | 'validate';
export const CUSTODY_ACTIONS: readonly CustodyAction[] = [
  'encrypt',
  'decrypt',
  'rotate',
  'revoke',
  'validate',
];

export const custodyAudit = pgTable('custody_audit', {
  id: text('id').primaryKey(),
  orgId: text('org_id')
    .notNull()
    .references(() => orgs.id),
  /** Who acted: a user id, an api-key id, or a system actor
   * ('system:serve', 'system:master-rotation'). */
  actor: text('actor').notNull(),
  action: text('action').$type<CustodyAction>().notNull(),
  /** Nullable (master rotation writes a summary row); plain text, no FK, so
   * deleting a provider key never breaks the trail. */
  providerKeyId: text('provider_key_id'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Daily usage rollup (M2 Wave 2, ROADMAP #18, migration 0006) — the
 * billing/usage source of truth at (org, UTC day, cluster) grain. Populated
 * ONLY by the idempotent batch job aggregateUsage() (repos/usage.ts) — the
 * chat path never writes here (documented there: batch keeps the serve path
 * simple and side-effect-free; realtime write-through is a later decision).
 */
export const usageDaily = pgTable(
  'usage_daily',
  {
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id),
    /** UTC calendar day 'YYYY-MM-DD' (text — see migration 0006). */
    day: text('day').notNull(),
    /** 'unassigned' when the request never resolved a cluster. */
    clusterId: text('cluster_id').notNull(),
    requests: integer('requests').notNull().default(0),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    /** Customer-facing cost (pricing v1 pass-through: == platformCostUsd;
     * the configurable margin applies at invoice time). */
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    /** Our price-table cost of served usage (request_logs.usage.costUsd). */
    platformCostUsd: doublePrecision('platform_cost_usd').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.day, t.clusterId] })],
);

/**
 * Shadow-mode evidence (M3, ROADMAP #21, SPEC §12.4, migration 0007) — one
 * row per shadow-candidate execution, written AFTER the primary response was
 * sent (fire-and-forget from the chat path; never on the latency path).
 * Org-scoped tenant data. quality is NULL only while a queued shadow:judge
 * job is pending (live mode); the in-process deterministic scorer always
 * writes a value.
 */
export const shadowResults = pgTable('shadow_results', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  orgId: text('org_id')
    .notNull()
    .references(() => orgs.id),
  /** Chat completion id (chatcmpl-…) — correlation label, not an FK. */
  requestId: text('request_id'),
  clusterId: text('cluster_id').notNull(),
  primaryHash: text('primary_hash').notNull(),
  candidateHash: text('candidate_hash').notNull(),
  candidateModel: text('candidate_model').notNull(),
  quality: doublePrecision('quality'),
  costUsd: doublePrecision('cost_usd').notNull(),
  latencyMs: integer('latency_ms').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Quality-guarantee samples (M3, ROADMAP #22, SPEC §12.5, migration 0008) —
 * one row per SAMPLED served answer, written AFTER the primary response was
 * sent (fire-and-forget; never on the latency path). Org-scoped tenant data.
 * strategy_hash is the SERVING strategy; the rolling breach evaluation
 * windows on (orgId, strategyHash, createdAt). No cluster column by
 * contract — the cluster travels in incidents.detail.
 */
export const qualitySamples = pgTable('quality_samples', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  orgId: text('org_id')
    .notNull()
    .references(() => orgs.id),
  /** Chat completion id (chatcmpl-…) — correlation label, not an FK. */
  requestId: text('request_id'),
  strategyHash: text('strategy_hash').notNull(),
  // G0.3 evidence keys (0017, additive): breach windows are STRICTLY keyed
  // (org, policy, cluster, strategy) — NULL-key rows (pre-G0.3) are not
  // evidence.
  clusterId: text('cluster_id'),
  policyId: text('policy_id'),
  quality: doublePrecision('quality').notNull(),
  // G0.1 judge evidence (0016, additive; stub-era rows carry NULLs):
  /** Scorer label, e.g. 'llm-judge:judge-class'. */
  scorer: text('scorer'),
  /** Judge model alias that produced the score. */
  judgeModel: text('judge_model'),
  /** The judge call's provider spend (also metered via request_logs). */
  judgeCostUsd: doublePrecision('judge_cost_usd'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Guarantee incidents (M3, ROADMAP #22, SPEC §12.5, migration 0008) —
 * webhook-ready incident trail. kind='rollback': the org's operating point
 * for detail.clusterId moved detail.fromStrategy → detail.toStrategy; the
 * LATEST UNRESOLVED rollback incident IS the serving-path operating-point
 * override (resolving it restores policy routing). kind='quality_breach':
 * alert-only. Cooldown (one incident per (org, cluster, strategy) per
 * window) is enforced by the evaluator via detail.clusterId/fromStrategy.
 */
/** 'advisory' (G2.1 trust hierarchy): a serve-leg floor-crossing tripwire —
 * durable/dedupable/resolvable but NEVER contractual and NEVER a rollback
 * source (readers filter by kind). Only suite-verify evidence escalates it
 * into 'quality_breach'/'rollback'. */
export type IncidentKind = 'quality_breach' | 'rollback' | 'advisory';
export const INCIDENT_KINDS: readonly IncidentKind[] = ['quality_breach', 'rollback', 'advisory'];

export const incidents = pgTable(
  'incidents',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id),
    kind: text('kind').$type<IncidentKind>().notNull(),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (_t) => [check('incidents_kind_check', sql`kind IN ('quality_breach', 'rollback')`)],
);

/**
 * Share tokens (M4, ROADMAP #31, SPEC §13.3, migration 0009) — one row per
 * minted read-only share link. The RAW token (`st_…`) is returned once at
 * mint time and NEVER stored; token_hash (sha256) is the public-endpoint
 * lookup identity. kind='frontier' → payload.clusterId renders /share/f/;
 * kind='report' → payload.windowDays renders /share/r/. redact_names strips
 * org-identifying fields from the public payload (default true). revoked_at
 * kills the link (404, no existence oracle). Org-scoped tenant data.
 */
export type ShareTokenKind = 'frontier' | 'report';
export const SHARE_TOKEN_KINDS: readonly ShareTokenKind[] = ['frontier', 'report'];

export const shareTokens = pgTable(
  'share_tokens',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id),
    kind: text('kind').$type<ShareTokenKind>().notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    /** sha256 of the raw `st_…` token — globally unique, the raw token is
     * never stored (same discipline as sessions/magic-links). */
    tokenHash: text('token_hash').notNull().unique(),
    redactNames: boolean('redact_names').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (_t) => [check('share_tokens_kind_check', sql`kind IN ('frontier', 'report')`)],
);

/**
 * Alert rules (M4, ROADMAP #33, SPEC §13.5, migration 0010) — org
 * notification targets. target_url may embed a secret; it lives ONLY here
 * (alert_deliveries never copies it; the dispatcher redacts query strings
 * in logs/errors). disabledAt soft-disables (NULL = enabled).
 */
export type AlertRuleKind = 'webhook' | 'slack';
export const ALERT_RULE_KINDS: readonly AlertRuleKind[] = ['webhook', 'slack'];

/** The alert event vocabulary (SPEC §13.5). quality_breach/rollback come
 * from guarantee incidents; budget_* from the budget:evaluate worker;
 * breaker_open from the readiness-layer breaker transition hook. */
export type AlertEvent =
  | 'quality_breach'
  | 'rollback'
  | 'budget_warning'
  | 'budget_exceeded'
  | 'breaker_open'
  // M4b #37 (SPEC §15.4): an autoresearcher promotion published a new
  // frontier version. Pure TS addition — alert_rules.events is text[] with
  // no DB-level CHECK, so no migration is needed for the wider vocabulary.
  | 'recipe_promoted';
export const ALERT_EVENTS: readonly AlertEvent[] = [
  'quality_breach',
  'rollback',
  'budget_warning',
  'budget_exceeded',
  'breaker_open',
  'recipe_promoted',
];

export const alertRules = pgTable(
  'alert_rules',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id),
    kind: text('kind').$type<AlertRuleKind>().notNull(),
    targetUrl: text('target_url').notNull(),
    events: text('events').array().$type<AlertEvent[]>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
  },
  (_t) => [check('alert_rules_kind_check', sql`kind IN ('webhook', 'slack')`)],
);

/**
 * Alert delivery audit (M4 #33, migration 0010) — one row per
 * (dispatch, rule) outcome. ruleId is TEXT by contract and deliberately
 * NOT an FK: the audit outlives the rule. NEVER carries target_url.
 */
export type AlertDeliveryStatus = 'delivered' | 'failed';

export const alertDeliveries = pgTable('alert_deliveries', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  ruleId: text('rule_id').notNull(),
  event: text('event').notNull(),
  status: text('status').$type<AlertDeliveryStatus>().notNull(),
  attempts: integer('attempts').notNull().default(0),
  /** Query-string-redacted failure detail (never the raw target_url). */
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
});

/**
 * Budgets (M4, ROADMAP #35, SPEC §13.7, migration 0011) — one row per org.
 * hardStop=false (soft cap, default) NEVER blocks serving; hardStop=true
 * fails closed at the cap (serving path, 60s MTD cache per org).
 */
export const budgets = pgTable('budgets', {
  orgId: text('org_id')
    .primaryKey()
    .references(() => orgs.id),
  monthlyCapUsd: doublePrecision('monthly_cap_usd').notNull(),
  hardStop: boolean('hard_stop').notNull().default(false),
  warnPct: integer('warn_pct').notNull().default(80),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Budget-event dedup ledger (M4 #35, migration 0011) — documented choice
 * (SPEC §13.7 allows alert_deliveries or a ledger): one row per
 * (org, kind, UTC day); the budget:evaluate worker inserts ON CONFLICT DO
 * NOTHING and emits the alert only when the insert landed.
 */
export type BudgetEventKind = 'budget_warning' | 'budget_exceeded';
export const BUDGET_EVENT_KINDS: readonly BudgetEventKind[] = [
  'budget_warning',
  'budget_exceeded',
];

export const budgetEvents = pgTable(
  'budget_events',
  {
    orgId: text('org_id').notNull(),
    kind: text('kind').$type<BudgetEventKind>().notNull(),
    /** UTC day 'YYYY-MM-DD' — the dedup grain. */
    day: text('day').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.kind, t.day] }),
    check('budget_events_kind_check', sql`kind IN ('budget_warning', 'budget_exceeded')`),
  ],
);

/**
 * Auth-event trail (M4, ROADMAP #34, SPEC §13.6, migration 0012) —
 * append-only record of auth-side actions (login/logout/invite via
 * magic-link or OIDC). Together with custody_audit (key lifecycle) and
 * incidents (guarantee) it feeds the unified org-scoped audit export
 * (/api/audit/export.jsonl). actor is the ACTOR'S EMAIL (human-readable in
 * exports); ip + request_id correlate with the observability request id
 * (M3 #26). detail NEVER contains credentials or tokens.
 */
export type AuthEventKind = 'login' | 'logout' | 'invite';
export const AUTH_EVENT_KINDS: readonly AuthEventKind[] = ['login', 'logout', 'invite'];
export type AuthEventMethod = 'magic_link' | 'oidc';
export const AUTH_EVENT_METHODS: readonly AuthEventMethod[] = ['magic_link', 'oidc'];

export const authEvents = pgTable(
  'auth_events',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id),
    kind: text('kind').$type<AuthEventKind>().notNull(),
    method: text('method').$type<AuthEventMethod>().notNull(),
    /** The acting user's email (the invitee's email for kind='invite'). */
    actor: text('actor').notNull(),
    ip: text('ip'),
    /** Fastify request id (inbound x-request-id honored) — correlation
     * label with the observability logs/metrics. */
    requestId: text('request_id'),
    detail: jsonb('detail').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (_t) => [
    check('auth_events_kind_check', sql`kind IN ('login', 'logout', 'invite')`),
    check('auth_events_method_check', sql`method IN ('magic_link', 'oidc')`),
  ],
);

// ---------------------------------------------------------------------------
// M4b #37 autoresearcher (SPEC §15.6, migration 0014_research): the
// platform-level research loop. research_cycles is the audit ledger of every
// candidate-generation+sweep run (its spend_usd is the RESEARCH ledger —
// separate from the M1b live cap); recipe_status is the lifecycle state of
// every known recipe (strategy hash): candidate → frontier → archived.
// Both are platform-GLOBAL (like frontiers/strategy_configs), never
// org-scoped: discovered recipes publish frontier versions all orgs inherit.
/** SPEC §15.6 trigger vocabulary. */
export type ResearchCycleTrigger = 'scan' | 'manual' | 'schedule';
export const RESEARCH_CYCLE_TRIGGERS: readonly ResearchCycleTrigger[] = [
  'scan',
  'manual',
  'schedule',
];
export type ResearchCycleStatus = 'queued' | 'running' | 'completed' | 'failed';
/** SPEC §15.1 recipe lifecycle. */
export type RecipeStatus = 'candidate' | 'frontier' | 'archived';
export const RECIPE_STATUSES: readonly RecipeStatus[] = ['candidate', 'frontier', 'archived'];

export const researchCycles = pgTable(
  'research_cycles',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    trigger: text('trigger').$type<ResearchCycleTrigger>().notNull(),
    /** The new-model alias a scan-triggered cycle focuses on (NULL = broad
     * manual/schedule cycle). */
    focusAlias: text('focus_alias'),
    /** The generated candidate configs swept this cycle (StrategyConfig[]). */
    candidates: jsonb('candidates').$type<StrategyConfig[]>().notNull().default([]),
    status: text('status').$type<ResearchCycleStatus>().notNull().default('queued'),
    /** Live USD spent by this cycle (its own ledger, SPEC §15.3 — NOT the
     * M1b cap). Mock cycles stay 0. */
    spendUsd: doublePrecision('spend_usd').notNull().default(0),
    /** Tenant scope (G1.8); NULL = platform cycle. Org cycles sweep the
     * org's derived suites and never mutate the platform recipe library. */
    orgId: text('org_id').references(() => orgs.id),
    /** Provenance of the cycle's evidence: 'mock' | 'live' | 'unknown'. */
    provenance: text('provenance').notNull().default('unknown'),
    /** mulberry32 seed for the promotion-gate paired bootstrap (SPEC §15.4)
     * — recorded so every promotion decision is exactly reproducible. */
    seed: integer('seed'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (_t) => [
    check('research_cycles_trigger_check', sql`trigger IN ('scan', 'manual', 'schedule')`),
    check('research_cycles_status_check', sql`status IN ('queued', 'running', 'completed', 'failed')`),
  ],
);

export const recipeStatus = pgTable(
  'recipe_status',
  {
    /** Content hash of the StrategyConfig (strategy_configs.hash). TEXT by
     * contract and deliberately NOT an FK: status rows may outlive config
     * rows (archival). */
    strategyHash: text('strategy_hash').primaryKey(),
    status: text('status').$type<RecipeStatus>().notNull().default('candidate'),
    /** The cycle that first surfaced this recipe (NULL = pre-M4b config). */
    firstCycleId: uuid('first_cycle_id'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (_t) => [
    check('recipe_status_status_check', sql`status IN ('candidate', 'frontier', 'archived')`),
  ],
);

// ---------------------------------------------------------------------------
// M5 #36 (SPEC §14.1): agent-trace spans. Org-scoped (payloads may contain
// customer data); idempotent on (orgId, traceId, spanId). attrs is the only
// payload column — retention mode 0 redacts it and keeps metadata (§14.3).
// ---------------------------------------------------------------------------
export const traceSpans = pgTable(
  'trace_spans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id),
    traceId: text('trace_id').notNull(),
    spanId: text('span_id').notNull(),
    parentId: text('parent_id'),
    name: text('name').notNull(),
    model: text('model'),
    usage: jsonb('usage').notNull().default({}),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    attrs: jsonb('attrs').notNull().default({}),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('trace_spans_idempotent').on(t.orgId, t.traceId, t.spanId),
    index('trace_spans_org_ts_idx').on(t.orgId, t.ts),
    index('trace_spans_trace_idx').on(t.orgId, t.traceId),
  ],
);


// Row types for repositories.
export type OrgRow = typeof orgs.$inferSelect;
export type NewOrg = typeof orgs.$inferInsert;
export type UserRow = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type MembershipRow = typeof memberships.$inferSelect;
export type NewMembership = typeof memberships.$inferInsert;
export type SessionRow = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type MagicLinkRow = typeof magicLinks.$inferSelect;
export type NewMagicLink = typeof magicLinks.$inferInsert;
export type FrontierRow = typeof frontiers.$inferSelect;
export type ClusterRow = typeof clusters.$inferSelect;
export type StrategyConfigRow = typeof strategyConfigs.$inferSelect;
export type EvalResultRow = typeof evalResults.$inferSelect;
export type RequestLogRow = typeof requestLogs.$inferSelect;
export type NewRequestLog = typeof requestLogs.$inferInsert;
export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
export type PolicyRow = typeof policies.$inferSelect;
export type NewPolicy = typeof policies.$inferInsert;
export type ProviderKeyRow = typeof providerKeys.$inferSelect;
export type NewProviderKey = typeof providerKeys.$inferInsert;
export type CustodyAuditRow = typeof custodyAudit.$inferSelect;
export type NewCustodyAudit = typeof custodyAudit.$inferInsert;
export type UsageDailyRow = typeof usageDaily.$inferSelect;
export type NewUsageDaily = typeof usageDaily.$inferInsert;
export type ShadowResultRow = typeof shadowResults.$inferSelect;
export type NewShadowResult = typeof shadowResults.$inferInsert;
export type QualitySampleRow = typeof qualitySamples.$inferSelect;
export type NewQualitySample = typeof qualitySamples.$inferInsert;
export type IncidentRow = typeof incidents.$inferSelect;
export type NewIncident = typeof incidents.$inferInsert;
export type ShareTokenRow = typeof shareTokens.$inferSelect;
export type NewShareToken = typeof shareTokens.$inferInsert;
export type AlertRuleRow = typeof alertRules.$inferSelect;
export type NewAlertRule = typeof alertRules.$inferInsert;
export type AlertDeliveryRow = typeof alertDeliveries.$inferSelect;
export type NewAlertDelivery = typeof alertDeliveries.$inferInsert;
export type BudgetRow = typeof budgets.$inferSelect;
export type NewBudget = typeof budgets.$inferInsert;
export type BudgetEventRow = typeof budgetEvents.$inferSelect;
export type AuthEventRow = typeof authEvents.$inferSelect;
export type NewAuthEvent = typeof authEvents.$inferInsert;

export type ResearchCycleRow = typeof researchCycles.$inferSelect;
export type NewResearchCycle = typeof researchCycles.$inferInsert;
export type RecipeStatusRow = typeof recipeStatus.$inferSelect;
export type NewRecipeStatus = typeof recipeStatus.$inferInsert;
export type TraceSpanRow = typeof traceSpans.$inferSelect;
export type NewTraceSpan = typeof traceSpans.$inferInsert;

// ---- judge calibrations (G0.2, migration 0018) ----
// Judge-trust evidence: one row per calibration of ONE judge against
// deterministic ground truth. judge_resolved_model uses the eval cache key's
// judgeVersion resolution so records stale in lockstep with eval rows.
/** Content-free calibration pair: item, truth score, per-judge scores. */
export interface CalibrationPairEvidence {
  itemId: string;
  truth: number;
  scores: Record<string, number>;
}

export const judgeCalibrations = pgTable('judge_calibrations', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  clusterId: text('cluster_id'),
  suiteId: text('suite_id'),
  judgeModel: text('judge_model').notNull(),
  judgeResolvedModel: text('judge_resolved_model').notNull(),
  answererModel: text('answerer_model').notNull(),
  pricesVersion: text('prices_version').notNull(),
  providerMode: text('provider_mode').notNull().default('unknown'),
  n: integer('n').notNull(),
  pearsonVsTruth: doublePrecision('pearson_vs_truth'),
  /** Rank correlation (0019): large spearman-pearson gap = monotone-scale
   * distortion, recoverable by recalibration; NULL on pre-0019 rows. */
  spearmanVsTruth: doublePrecision('spearman_vs_truth'),
  judgeAgreement: doublePrecision('judge_agreement'),
  meanAbsErr: doublePrecision('mean_abs_err'),
  flagged: boolean('flagged').notNull(),
  spendUsd: doublePrecision('spend_usd').notNull().default(0),
  pairs: jsonb('pairs').$type<CalibrationPairEvidence[]>().notNull().default([]),
  /** Identity of the rubric the judge was calibrated UNDER (0022) — a rubric
   * edit is a different judge harness and must never inherit old trust
   * evidence. NULL = pre-0022 rows (rubric unrecorded). */
  rubricHash: text('rubric_hash'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type JudgeCalibrationRow = typeof judgeCalibrations.$inferSelect;
export type NewJudgeCalibration = typeof judgeCalibrations.$inferInsert;

// ---- derived suites (G1.3, migration 0021) ----
// Trace-synthesized suites in governed storage: org-attributed provenance
// rows + time-windowed items (source_trace_id/created_at) so trace retention
// governs their lifecycle. Authored suites stay repo files (agent- prefix is
// the discriminator).
export const derivedSuites = pgTable('derived_suites', {
  suiteId: text('suite_id').primaryKey(),
  clusterId: text('cluster_id').notNull(),
  orgId: text('org_id')
    .notNull()
    .references(() => orgs.id),
  manifest: jsonb('manifest').notNull(),
  version: text('version').notNull().default('1.0.0'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const derivedSuiteItems = pgTable(
  'derived_suite_items',
  {
    suiteId: text('suite_id')
      .notNull()
      .references(() => derivedSuites.suiteId, { onDelete: 'cascade' }),
    itemId: text('item_id').notNull(),
    clusterId: text('cluster_id').notNull(),
    prompt: jsonb('prompt').$type<ChatMessage[]>().notNull(),
    reference: jsonb('reference'),
    scoring: jsonb('scoring').$type<ScoringMethod>().notNull(),
    sourceTraceId: text('source_trace_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.suiteId, t.itemId] })],
);

export type DerivedSuiteRow = typeof derivedSuites.$inferSelect;
export type NewDerivedSuite = typeof derivedSuites.$inferInsert;
export type DerivedSuiteItemRow = typeof derivedSuiteItems.$inferSelect;
export type NewDerivedSuiteItem = typeof derivedSuiteItems.$inferInsert;

// ---- cluster rubrics (G1.5, migration 0022) ----
// Per-cluster generated rubrics with a review lifecycle. Only 'approved' is
// ever IN FORCE (partial unique index: at most one per cluster); everything
// else is a visible draft/record. status_reason carries the WHY as data
// (owner rule: customer-derived artifacts always ship with status + evidence
// attached; rejected rubrics stay listed with their failure reason).
export type ClusterRubricStatus = 'pending' | 'approved' | 'rejected' | 'superseded';

export const clusterRubrics = pgTable('cluster_rubrics', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  orgId: text('org_id')
    .notNull()
    .references(() => orgs.id),
  clusterId: text('cluster_id').notNull(),
  suiteId: text('suite_id').notNull(),
  rubricText: text('rubric_text').notNull(),
  rubricHash: text('rubric_hash').notNull(),
  status: text('status').$type<ClusterRubricStatus>().notNull().default('pending'),
  statusReason: text('status_reason'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  generatorModel: text('generator_model').notNull(),
  providerMode: text('provider_mode').notNull().default('mock'),
  exemplarCount: integer('exemplar_count').notNull().default(0),
  /** Soft ref to judge_calibrations.id — NULL = uncalibrated (reason in
   * status_reason), still reviewable: the human accepts the risk knowingly. */
  calibrationId: uuid('calibration_id'),
  spendUsd: doublePrecision('spend_usd').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type ClusterRubricRow = typeof clusterRubrics.$inferSelect;
export type NewClusterRubric = typeof clusterRubrics.$inferInsert;

// ---- cluster incumbents (G2.1, migration 0025) ----
// The org's DESIGNATED INCUMBENT strategy per cluster — the baseline every
// retention verdict and derived floor rests on. At most one ACTIVE per
// (org, cluster) (partial unique); redesignation supersedes transactionally
// (the cluster_rubrics lifecycle shape). No silent defaults anywhere: an
// undesignated cluster reports "retention unavailable" and stays on the
// labeled legacy absolute-floor path.
export type ClusterIncumbentStatus = 'active' | 'superseded';

export const clusterIncumbents = pgTable('cluster_incumbents', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  orgId: text('org_id')
    .notNull()
    .references(() => orgs.id),
  clusterId: text('cluster_id').notNull(),
  strategyHash: text('strategy_hash').notNull(),
  status: text('status').$type<ClusterIncumbentStatus>().notNull().default('active'),
  statusReason: text('status_reason'),
  designatedAt: timestamp('designated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type ClusterIncumbentRow = typeof clusterIncumbents.$inferSelect;
export type NewClusterIncumbent = typeof clusterIncumbents.$inferInsert;

export const schema = {
  orgs,
  users,
  memberships,
  sessions,
  magicLinks,
  clusters,
  clusterExemplars,
  models,
  strategyConfigs,
  evalItems,
  evalRuns,
  evalResults,
  frontiers,
  frontierPoints,
  apiKeys,
  policies,
  requestLogs,
  providerKeys,
  custodyAudit,
  usageDaily,
  shadowResults,
  qualitySamples,
  incidents,
  shareTokens,
  alertRules,
  alertDeliveries,
  budgets,
  budgetEvents,
  authEvents,
  researchCycles,
  recipeStatus,
  traceSpans,
  // Declared below this object historically but part of the schema (G1.6
  // fix-in-passing — introspection over `schema` was blind to them):
  judgeCalibrations,
  derivedSuites,
  derivedSuiteItems,
  clusterRubrics,
  clusterIncumbents,
};

export type Schema = typeof schema;
