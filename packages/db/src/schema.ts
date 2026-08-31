// Drizzle pg-schema for the 12 Potion tables (SPEC §7), columns aligned with
// @potion/core types. One schema drives both drivers: PGlite (tests/dev) and
// node-postgres (local/prod via docker-compose).
import { customType,
  bigint,
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
  RequestShape,
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
  /** Model-field semantics (external review 2026-08-25, migration 0058):
   * false (default) = 'potion-auto' routes, a known model name pins, an
   * unknown name 400s. true = migration mode — every label routes, chosen
   * explicitly in Settings · Controls. */
  routeAllModels: boolean('route_all_models').notNull().default(false),
  /**
   * S7 L2 (migration 0042): this org's traffic is excluded from demand
   * cells entirely — not counted, not summed, not staged. Checked at
   * OBSERVATION, so opted-out traffic never enters an accumulator at all.
   */
  demandLearningOptOut: boolean('demand_learning_opt_out').notNull().default(false),
  /**
   * S7 L4 (migration 0043): this org's unmet demand is measured FIRST when
   * the autonomous budget can afford one run. Ranking only — it never lowers
   * the k-anonymity gate, never attaches an org to a published cell, and
   * never influences routing.
   */
  learningPriority: boolean('learning_priority').notNull().default(false),
});

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const invites = pgTable('invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: text('org_id')
    .notNull()
    .references(() => orgs.id),
  email: text('email').notNull(),
  role: text('role').$type<Role>().notNull(),
  invitedBy: text('invited_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});
export type InviteRow = typeof invites.$inferSelect;

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

/**
 * THE MODEL REGISTRY (adopted by S5, migration 0040) — the catalog of every
 * model Potion knows it could call.
 *
 * Deliberately NOT the set it will route to. Only measured frontier points
 * are routable (dial honesty); this table has no opinion about measurement,
 * and conflating the two is exactly how "300 models" becomes a claim nobody
 * evaluated. Catalog ≠ frontier.
 *
 * This table pre-existed S5 and was DEAD — declared here, written and read
 * nowhere. S5 adopts it as the live registry, replacing prices.json, whose
 * discoveries used to be written back to a file that dies on redeploy and
 * never reaches the running process (loadPrices runs once at boot).
 * prices.json remains as the SEED for a fresh database.
 *
 * `pricesVersion` is per-row and stays that way: it keys eval-result cache
 * cells, so the registry's current version is the version of its newest row —
 * derivable, and it moves exactly when a scan adds something.
 */
export const models = pgTable('models', {
  alias: text('alias').primaryKey(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  inputPer1M: doublePrecision('input_per_1m').notNull(),
  outputPer1M: doublePrecision('output_per_1m').notNull(),
  pricesVersion: text('prices_version').notNull(),
  /** Catalog facts a scan can learn. ALL NULLABLE: absent means the provider
   *  did not report it, never a fabricated default — a guessed context window
   *  silently truncates a prompt, and a guessed tool flag routes a
   *  tool-calling request to a model that cannot do it. */
  contextLength: integer('context_length'),
  maxOutputTokens: integer('max_output_tokens'),
  supportsTools: boolean('supports_tools'),
  /** G: learned from vision-instrument evidence; NULL = unknown (excluded). */
  supportsVision: boolean('supports_vision'),
  /** P1-8: reasoning model, learned from serving evidence (reasoning tokens
   *  in usage, or an empty answer that exhausted its budget). NULL = unknown.
   *  Read at boot so the skip-below-budget guard survives a restart. */
  reasoning: boolean('reasoning'),
  /** 'seed' (committed prices.json) | 'scan' (discovered live). */
  source: text('source').notNull().default('seed'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
export type ModelRow = typeof models.$inferSelect;
export type NewModelRow = typeof models.$inferInsert;

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
  /** MIXING M3: 'tools' for cells scored on a tool call, else 'default'. */
  instrument: text('instrument').notNull().default('default'),
  judgeAgreement: doublePrecision('judge_agreement'),
  /** Producing stage's confidence (exp mean token logprob) when exposed. */
  confidence: doublePrecision('confidence'),
  confidenceMethod: text('confidence_method'),
  usage: jsonb('usage').$type<Usage>().notNull(),
  /** 2026-08-23: the judge's spend, split out of `usage` (serving vs measurement truth). */
  scorerUsage: jsonb('scorer_usage').$type<Usage>(),
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
  /** 'default' (text-judged suites) | 'tools' (items carrying tools; MIXING M3). */
  instrument: text('instrument').notNull().default('default'),
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
  /** Scope tokens ('+'/space separated). Closed vocabulary: 'serve'
   * (default) and 'admin'. G2.3 KEY ROLE SPLIT: the api-key ROLE derives
   * from this column at resolution (roleForApiKey, org-context.ts) —
   * 'serve+admin' resolves to role 'admin', everything else (incl.
   * malformed/unrecognized values) FAILS CLOSED to 'member'. */
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

/**
 * Who funded a served request (S3, migration 0039). The vocabulary is closed
 * on purpose: a third value would have to mean something for the invoice, and
 * inventing one silently is how a billing system starts guessing.
 */
export type PaidBy = 'platform' | 'byok';
export const PAID_BY_VALUES: readonly PaidBy[] = ['platform', 'byok'];

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
  /** Provider id on per-call job spend rows (0030, post-capstone metering) —
   * the reconcile against provider-billed reality is per provider. NULL on
   * serving rows (model implies it) and pre-0030 rows. */
  provider: text('provider'),
  /**
   * BILLING TRUTH (S3, migration 0039). Which key funded this request:
   * 'platform' (Potion's own — billable to the customer under usage
   * pricing) or 'byok' (the customer's own — their provider bills them).
   *
   * NULL means NOT RECORDED, and that reading must be preserved: pre-0039
   * rows, and requests that never reached execution (auth failures, budget
   * refusals), cost nobody anything. Defaulting NULL to 'platform' would
   * silently invoice traffic that was never served.
   */
  paidBy: text('paid_by').$type<PaidBy>(),
  /**
   * What this same request would have cost on the frontier's highest-quality
   * point — the counterfactual behind any "money saved" claim, modelled from
   * the price table at serve time using the request's REAL token counts.
   *
   * Recorded rather than derived because the comparison drifts: the price
   * table and the frontier both move, so next quarter's reconstruction would
   * answer a different question than the one the customer was actually
   * choosing between at the time.
   */
  baselineCostUsd: doublePrecision('baseline_cost_usd'),
  /** S2 (migration 0060): the model that actually answered — stamped at
   * serve time from the resolved strategy; NULL on pre-0060 rows. */
  servedModel: text('served_model'),
  /**
   * THE DEMAND SIGNAL (S7 L1, migration 0041). The assigner's own evidence
   * for the routing label beside it: cosine to the winning centroid, the
   * cluster that came second, and the gap between them. All three are
   * computed by `pickBest` on every request and were previously discarded.
   *
   * NULL means NOT RECORDED (pre-0041 rows, hinted clusters that skipped the
   * assigner entirely, requests that failed before classification). It must
   * never be defaulted to 0 — a zero confidence is precisely the reading
   * "nothing we serve fits this", which is the finding the column exists to
   * surface.
   */
  clusterConfidence: doublePrecision('cluster_confidence'),
  runnerUpCluster: text('runner_up_cluster'),
  clusterMargin: doublePrecision('cluster_margin'),
  /** TRUE when the served cluster was chosen by the quality-safe tiebreak
   * between two near-equal centroid matches (routing/ambiguity.ts). */
  clusterTiebreak: boolean('cluster_tiebreak'),
  /** Flywheel (0055): content-free structural fingerprint, stamped at serve
   * time — counts, buckets, hashed tool signature; NEVER request text. */
  taskShape: jsonb('task_shape').$type<Record<string, unknown>>(),
  /** Flywheel (0055): serving-path observations for this request. [] =
   * completed with nothing observed (recorded silence); NULL = row predates
   * instrumentation. The distinction is what makes the honesty term
   * computable. */
  implicitSignals: text('implicit_signals').array(),
  /** Flywheel (0056): the ANSWER's structure — length, tool calls, JSON
   * validity when JSON was requested, answering stage. Content-free. */
  answerShape: jsonb('answer_shape').$type<Record<string, unknown>>(),
  /** Flywheel (0056): per-org-salted one-way prompt fingerprint. Links
   * repeats within an org; links nothing across orgs; reverses to nothing. */
  promptFp: text('prompt_fp'),
  /** Flywheel (0056): hashed caller session (`user` param + org). */
  sessionFp: text('session_fp'),
  /**
   * Content-free request structure (`RequestShape`, core/shape.ts): turn
   * count, system flag, tool count, tool_choice MODE, stream flag, the
   * caller's declared output ceiling, and a coarse content-LENGTH bucket.
   * No message text, no tool names, no embedding — pinned by test, because
   * this is the field S7's cross-org aggregation reads.
   */
  shape: jsonb('shape').$type<RequestShape>(),
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
export type CustodyAction = 'encrypt' | 'decrypt' | 'rotate' | 'revoke' | 'validate' | 'issue';
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
    /** Serve-time counterfactual (migration 0059; recorded per request since
     * 0039): what the same traffic would have cost on the highest-quality
     * point. The base of pricing v2's verified-savings share. */
    baselineCostUsd: doublePrecision('baseline_cost_usd').notNull().default(0),
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
  (_t) => [check('incidents_kind_check', sql`kind IN ('quality_breach', 'rollback', 'advisory')`)],
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
export type ShareTokenKind = 'frontier' | 'report' | 'brief';
export const SHARE_TOKEN_KINDS: readonly ShareTokenKind[] = ['frontier', 'report', 'brief'];

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
  (_t) => [check('share_tokens_kind_check', sql`kind IN ('frontier', 'report', 'brief')`)],
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
  | 'recipe_promoted'
  // F7: the certified INSTRUMENT changed underneath a live certification —
  // a retention purge or a rubric restamp. Emitted with the certified and
  // live content hashes so the customer can see exactly what moved, and
  // paired with an automatic suite:certify enqueue: a scheduled purge must
  // never silently lapse a guarantee.
  | 'certification_invalidated'
  // G2.2 trust-hierarchy SLA conditions (TS-only widening, same contract):
  // guarantee_unverifiable — an OPEN advisory aged past its verifySlaMin
  //   without a contractual verdict (starved verification; distinct from
  //   breach, escalated once per advisory).
  // guarantee_restored — auto-restore lifted a rollback on a CONFIDENT
  //   suite-verified recovery (retention CI95 lower ≥ floor).
  // guarantee_recovery_unconfirmed — N consecutive NON-confident all-clears
  //   on a restore verify: uncertainty never auto-restores and never
  //   silently persists (owner refinement, 2026-08-08); human review.
  | 'guarantee_unverifiable'
  | 'guarantee_restored'
  | 'guarantee_recovery_unconfirmed'
  // G2.6: a COMPOUND policy's latency bound admits no quality-qualifying
  // point, so the fastest qualifying point is served and the SLO is knowingly
  // missed. Fires ONCE per episode, on the standing condition's raise — the
  // per-request labels are on the trace and the DTO. Same TS-only widening
  // (alert_rules.events is text[] with no DB CHECK), so no migration.
  | 'policy_infeasible'
  // R7 (2026-08-24): a newly published frontier version would change what
  // this org is served. Emitted per affected org with the buyer-readable
  // narrative from diffFrontiers, so silent improvement stays the DEFAULT
  // rather than the only option.
  | 'frontier_moved';
export const ALERT_EVENTS: readonly AlertEvent[] = [
  'quality_breach',
  'rollback',
  'budget_warning',
  'budget_exceeded',
  'breaker_open',
  'recipe_promoted',
  'guarantee_unverifiable',
  'guarantee_restored',
  'guarantee_recovery_unconfirmed',
  'policy_infeasible',
  'frontier_moved',
];

/** R0 (migration 0054): the org's payment identity. Card METADATA only —
 * a brand and last four for display; never a PAN. */
export const billingCustomers = pgTable('billing_customers', {
  orgId: text('org_id')
    .primaryKey()
    .references(() => orgs.id),
  customerId: text('customer_id').notNull(),
  transport: text('transport').notNull().default('ledger'),
  brand: text('brand'),
  last4: text('last4'),
  expMonth: integer('exp_month'),
  expYear: integer('exp_year'),
  status: text('status').notNull().default('none'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
export type BillingCustomerRow = typeof billingCustomers.$inferSelect;

/** R0 (migration 0054): one row per (org, period) charge attempt — what we
 * believed was owed, what we tried to collect, and what happened. */
export const invoiceCharges = pgTable('invoice_charges', {
  id: text('id').primaryKey(),
  orgId: text('org_id')
    .notNull()
    .references(() => orgs.id),
  period: text('period').notNull(),
  amountCents: integer('amount_cents').notNull(),
  currency: text('currency').notNull().default('usd'),
  status: text('status').notNull(),
  transport: text('transport').notNull(),
  externalId: text('external_id'),
  error: text('error'),
  invoiceJson: jsonb('invoice_json'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
export type InvoiceChargeRow = typeof invoiceCharges.$inferSelect;

/** R7 (migration 0053): a frozen frontier version per (org, cluster,
 * instrument). Present ⇒ serving reads that exact version instead of the
 * latest; absent ⇒ the historical "serve the newest" behavior. */
export const frontierPins = pgTable(
  'frontier_pins',
  {
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id),
    clusterId: text('cluster_id').notNull(),
    instrument: text('instrument').notNull().default('default'),
    frontierId: text('frontier_id').notNull(),
    frontierVersion: integer('frontier_version').notNull(),
    pinnedBy: text('pinned_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.orgId, t.clusterId, t.instrument] }) }),
);
export type FrontierPinRow = typeof frontierPins.$inferSelect;

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
  /** G2.2 (0026): the incident this notification concerns — TEXT, not an
   * FK (audit outlives source, the rule_id contract). NULL for
   * incident-less events (budget_*, breaker_open, recipe_promoted). */
  incidentId: text('incident_id'),
  /** The SLA clock start the EMITTER bound (standing decision: advisory
   * created_at on the hierarchy path; incident created_at on legacy paths;
   * rollback created_at for restore/recovery events). NULL = not SLA-bound. */
  clockStartAt: timestamp('clock_start_at', { withTimezone: true }),
  /** now() − clock_start_at at the SUCCESSFUL POST, clamped ≥ 0 (clock
   * skew). NULL on failure — an undelivered notification has no latency. */
  latencyMs: doublePrecision('latency_ms'),
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
  /**
   * G2.8 (0028) — seeded bootstrap CI95 on each correlation, stored as a
   * [lo, hi] PAIR (the sampling distribution of a correlation is asymmetric;
   * a half-width would assert a symmetry that does not hold). Read THESE, not
   * the point estimate, when deciding whether a judge clears the 0.8 bar: an
   * interval straddling the bar means the run was not powered to answer the
   * question. NULL on pre-0028 rows, on corpora below
   * CORRELATION_CI_MIN_PAIRS, and on indeterminate (constant-truth) rows.
   */
  pearsonCi95: jsonb('pearson_ci95').$type<[number, number]>(),
  spearmanCi95: jsonb('spearman_ci95').$type<[number, number]>(),
  /** Seed behind both intervals — with the stored `pairs`, the CI is exactly
   * re-derivable. Double precision, not integer: seeds are uint32 and would
   * overflow int4. */
  correlationSeed: doublePrecision('correlation_seed'),
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

// ---- suite certifications (post-capstone item 3, migration 0031) ----
// Decision 2: a derived suite is certified for guarantee use only if the
// incumbent retains its own baseline when FRESH-re-evaluated against it —
// the capstone's 0.2000 incumbent self-retention is the failure this gates.
// Subject is (org, suite, suite VERSION): re-derivation invalidates by key.
// Lifecycle mirrors cluster_rubrics; 'pending' is reserved vocabulary (the
// job measures and writes certified/failed directly; refusals are 'failed'
// rows with evidence.refused = true — REFUSED, NOT MEASURED).
/** F7 adds 'invalidated': the instrument moved underneath a measurement
 * nobody repeated. Distinct from 'superseded', which means a newer
 * MEASUREMENT replaced this one — different fact, different remedy. */
export type SuiteCertificationStatus =
  | 'pending'
  | 'certified'
  | 'failed'
  | 'superseded'
  | 'invalidated';

export const suiteCertifications = pgTable('suite_certifications', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  orgId: text('org_id')
    .notNull()
    .references(() => orgs.id),
  clusterId: text('cluster_id').notNull(),
  suiteId: text('suite_id').notNull(),
  suiteVersion: text('suite_version').notNull(),
  /** F7: sha256 over the id-sorted item roster (prompt, reference, scoring) at
   * certification time — the identity of what was actually vouched for. NULL =
   * certified before F7; the gate treats that as NOT certified, fail-closed. */
  suiteContentHash: text('suite_content_hash'),
  /** NULL on refused-before-designation rows (no incumbent to measure). */
  incumbentHash: text('incumbent_hash'),
  incumbentDesignationId: uuid('incumbent_designation_id'),
  providerMode: text('provider_mode').notNull().default('mock'),
  status: text('status').$type<SuiteCertificationStatus>().notNull(),
  statusReason: text('status_reason'),
  /** The measurement: {selfRetentionMean, floor, items, executed, perItem,
   * providerMode, runId, suiteVersion, judgeModel, executedSpendUsd,
   * metering} — or {refused: true, kind} for recorded refusals. */
  evidence: jsonb('evidence').$type<Record<string, unknown>>(),
  spendUsd: doublePrecision('spend_usd').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
});

export type SuiteCertificationRow = typeof suiteCertifications.$inferSelect;
export type NewSuiteCertification = typeof suiteCertifications.$inferInsert;

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

/**
 * Durable suite-verify verdicts (0029, post-G2.8). One row per verify, EVERY
 * outcome (the eight 0029 outcomes plus 'mode-mismatch' from the post-capstone
 * metering item) — a verdict is a measurement and measurements are kept
 * regardless of direction. Pre-0029 an all-clear with no advisory wrote
 * NOTHING, which is why G2.8's contradictory 1.0645 could never be
 * root-caused. `retention` carries the full block incl. pairEvidence (the
 * ordered per-item list) so two verdicts can be diffed. Supersession is
 * rubric-style: corrections are NEW rows; priors keep superseded_by +
 * supersede_reason and stay readable.
 */
export const guaranteeVerdicts = pgTable(
  'guarantee_verdicts',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id),
    policyId: text('policy_id').notNull(),
    clusterId: text('cluster_id').notNull(),
    suiteId: text('suite_id'),
    suiteVersion: text('suite_version'),
    candidateHash: text('candidate_hash').notNull(),
    incumbentHash: text('incumbent_hash'),
    incumbentDesignationId: text('incumbent_designation_id'),
    providerMode: text('provider_mode').notNull().default('unknown'),
    pricesVersion: text('prices_version'),
    outcome: text('outcome').notNull(),
    retention: jsonb('retention').$type<Record<string, unknown>>(),
    unpairable: jsonb('unpairable')
      .$type<Array<{ itemId: string; has: 'candidate' | 'incumbent' }>>()
      .notNull()
      .default([]),
    detail: text('detail'),
    runId: text('run_id'),
    spendUsd: doublePrecision('spend_usd').notNull().default(0),
    rubricHash: text('rubric_hash'),
    calibrationId: text('calibration_id'),
    advisoryIncidentId: text('advisory_incident_id'),
    verdictIncidentId: text('verdict_incident_id'),
    supersededBy: uuid('superseded_by'),
    supersedeReason: text('supersede_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('guarantee_verdicts_tuple_idx').on(t.orgId, t.policyId, t.clusterId, t.createdAt)],
);

export type GuaranteeVerdictRow = typeof guaranteeVerdicts.$inferSelect;
export type NewGuaranteeVerdict = typeof guaranteeVerdicts.$inferInsert;

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

// ---- job execution ledger (F10, migration 0032) ----
// The dedupe ledger for job DELIVERIES. Production retries 3× and BullMQ
// redelivers stalled jobs after a crash; handlers were not idempotent, so a
// throw after the spend re-ran everything. Two verdicts for one tuple are
// legitimate when a human asked twice, so dedupe cannot key on the evidence
// — only the job id distinguishes a retry from a deliberate re-run.
// Shape follows budget_events (0011): claim with ON CONFLICT DO NOTHING and
// act only if you won.
export const jobExecutions = pgTable(
  'job_executions',
  {
    jobId: text('job_id').primaryKey(),
    jobKind: text('job_kind').notNull(),
    /** Nullable: platform jobs carry no org. */
    orgId: text('org_id'),
    attempt: integer('attempt').notNull().default(1),
    claimedAt: timestamp('claimed_at', { withTimezone: true }).notNull().defaultNow(),
    /** NULL = a prior attempt claimed the job and never finished. */
    completedAt: timestamp('completed_at', { withTimezone: true }),
    result: jsonb('result').$type<unknown>(),
    outcome: text('outcome'),
  },
  (t) => ({ kindIdx: index('job_executions_kind_idx').on(t.jobKind, t.claimedAt) }),
);

export type JobExecutionRow = typeof jobExecutions.$inferSelect;
export type NewJobExecution = typeof jobExecutions.$inferInsert;

/**
 * Migration ledger (F12). Bootstrapped directly by `migrate()` — it cannot be
 * a migration file, since it is what decides which files run. Declared here
 * so operators and tests can read it as a table like any other.
 */
export const schemaMigrations = pgTable('schema_migrations', {
  filename: text('filename').primaryKey(),
  appliedAt: timestamp('applied_at', { withTimezone: true }).notNull().defaultNow(),
  /** true = accepted as already-applied on a pre-ledger database WITHOUT
   * being executed (see BASELINE_THROUGH). */
  baselined: boolean('baselined').notNull().default(false),
});

/**
 * F12 attribution audit (0033). One row per piece of evidence that was found
 * attributed to the org owning its cluster — the fingerprint of the boot-time
 * re-attribution.
 *
 * Deliberately NO foreign key to orgs: this is an operator record about a
 * data-integrity incident, and it must outlive the org whose attribution it
 * describes (a row that vanishes when you delete the org cannot tell you what
 * happened before the deletion). It holds org IDs and timestamps only — no
 * prompts, completions, or customer content — so it is not in scope for the
 * TRUE-CASCADE erasure guarantee.
 */
export const evidenceAttributionAudit = pgTable('evidence_attribution_audit', {
  id: serial('id').primaryKey(),
  tableName: text('table_name').notNull(),
  rowKey: text('row_key').notNull(),
  clusterId: text('cluster_id'),
  claimedOrgId: text('claimed_org_id').notNull(),
  rowCreatedAt: timestamp('row_created_at', { withTimezone: true }),
  orgCreatedAt: timestamp('org_created_at', { withTimezone: true }),
  /** 'reset-to-platform' = provably impossible, org_id set back to NULL.
   *  'ambiguous-review'  = indistinguishable from legitimate ownership; the
   *                        row was NOT modified. An operator decides. */
  disposition: text('disposition').notNull(),
  notedAt: timestamp('noted_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * DEMAND CELLS (S7 L2, migration 0042) — served traffic, generalized and
 * anonymized into something Potion may learn from across customers.
 *
 * The split into three tables IS the privacy design: staging and
 * contributors are private accumulator state, `demandCells` is the only
 * table anything else reads. A cell reaches the published table only after
 * ≥K distinct orgs have fed it (core/demand.ts `isPublishable`), so a
 * published row describes a market, never a customer.
 */
export const demandCellStaging = pgTable('demand_cell_staging', {
  cellKey: text('cell_key').primaryKey(),
  bucket: text('bucket').notNull(),
  bucketKind: text('bucket_kind').$type<DemandBucketKind>().notNull(),
  shapeClass: text('shape_class').notNull(),
  weekStart: text('week_start').notNull(),
  requests: bigint('requests', { mode: 'number' }).notNull().default(0),
  confidenceSum: doublePrecision('confidence_sum').notNull().default(0),
  confidenceCount: bigint('confidence_count', { mode: 'number' }).notNull().default(0),
  confidenceMin: doublePrecision('confidence_min'),
  /** Running SUM of embeddings — jsonb, not `vector`: a sum is not a point
   * in the space and must not be searchable as if it were. */
  centroidSum: jsonb('centroid_sum').$type<number[]>(),
  centroidCount: bigint('centroid_count', { mode: 'number' }).notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Which orgs fed which cell. PRIVATE — presence only, and it never leaves
 * the aggregator: the published row carries a COUNT. */
export const demandCellContributors = pgTable(
  'demand_cell_contributors',
  {
    cellKey: text('cell_key').notNull(),
    orgId: text('org_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.cellKey, t.orgId] })],
);

export type DemandBucketKind = 'cluster' | 'unassigned';

export const demandCells = pgTable(
  'demand_cells',
  {
    cellKey: text('cell_key').primaryKey(),
    /** Taxonomy cluster id, or an `lsh:xxxx` unassigned region. */
    bucket: text('bucket').notNull(),
    bucketKind: text('bucket_kind').$type<DemandBucketKind>().notNull(),
    shapeClass: text('shape_class').notNull(),
    weekStart: text('week_start').notNull(),
    requests: bigint('requests', { mode: 'number' }).notNull(),
    orgCount: integer('org_count').notNull(),
    /** NULL when nothing in the cell measured a fit (all traffic arrived
     * cluster-hinted). NULL is "not measured"; 0 would be "fits nothing we
     * serve", which is a finding rather than an absence. */
    confidenceMean: doublePrecision('confidence_mean'),
    /** The WORST fit in the cell — the mean hides the tail, and the tail is
     * where "we have never measured anything for this" shows up. */
    confidenceMin: doublePrecision('confidence_min'),
    /** How many of the cell's requests carried a measured fit. */
    confidenceCount: bigint('confidence_count', { mode: 'number' }).notNull().default(0),
    centroid: vector('centroid', { dimensions: 384 }),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('demand_cells_week_kind_idx').on(t.weekStart, t.bucketKind)],
);

export type DemandCellStagingRow = typeof demandCellStaging.$inferSelect;
export type DemandCellRow = typeof demandCells.$inferSelect;

/**
 * AUTONOMOUS LEARNING LEDGER (S7 L4, migration 0043).
 *
 * The hand-written ledger row, written by the job. Every live campaign in
 * this project is ledgered projected-vs-actual under an explicit risk
 * acceptance; L4 replaces the per-run human with a standing daily cap, and
 * this table is what keeps the rest of that discipline intact — including
 * the part a hand-written row never carried: the demand that justified the
 * spend.
 */
export type LearningRunStatus = 'planned' | 'running' | 'completed' | 'failed' | 'refused';

export const learningRuns = pgTable(
  'learning_runs',
  {
    id: text('id').primaryKey(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    status: text('status').$type<LearningRunStatus>().notNull(),
    /** The demand cell that justified the run (demand_cells.cell_key). */
    cellKey: text('cell_key'),
    clusterId: text('cluster_id'),
    /** core/coverage.ts CoverageReason. */
    gapReason: text('gap_reason'),
    gapScore: doublePrecision('gap_score'),
    /** The narrowing handed to the sweep, so the candidate set is
     * reconstructable from the ledger alone. */
    capabilityFilter: jsonb('capability_filter').$type<{
      tools?: boolean;
      minContextTokens?: number;
    }>(),
    /** The cap this run was authorized to spend — written BEFORE it ran. */
    projectedUsd: doublePrecision('projected_usd').notNull(),
    /** NULL until the run lands. A row with no actual is a run that died. */
    actualUsd: doublePrecision('actual_usd'),
    pointsPublished: integer('points_published'),
    detail: text('detail'),
  },
  (t) => [index('learning_runs_started_idx').on(t.startedAt)],
);

export type LearningRunRow = typeof learningRuns.$inferSelect;
export type NewLearningRun = typeof learningRuns.$inferInsert;

export type SchemaMigrationRow = typeof schemaMigrations.$inferSelect;
export type EvidenceAttributionAuditRow = typeof evidenceAttributionAudit.$inferSelect;

/**
 * Lab runtime (Step 3, migration 0035). Operator ruling: schema-ADDITIVE
 * core under rule 2 — no guarantee code path reads these; the additive
 * contract protects guarantee SEMANTICS. All three are org-FK tables so the
 * F5 cascade meta-test covers them from birth.
 */
export const labRuns = pgTable('lab_runs', {
  id: text('id').primaryKey(),
  orgId: text('org_id')
    .notNull()
    .references(() => orgs.id),
  /** Spec content hash (Step 2) — the resume identity gate. */
  harnessHash: text('harness_hash').notNull(),
  harnessName: text('harness_name').notNull(),
  /** The spec AS RUN, frozen. Replay/fork read this copy, never a file. */
  spec: jsonb('spec').notNull(),
  state: text('state')
    .$type<
      | 'pending'
      | 'running'
      | 'awaiting-human'
      | 'completed'
      | 'failed'
      | 'killed-budget'
      | 'killed-operator'
    >()
    .notNull(),
  stateReason: text('state_reason'),
  /** X4: the parent run when this row is a fan-out helper; NULL = root. */
  parentRunId: text('parent_run_id'),
  /** X3: advisory judgment {overall, criteria[], rationale, judgeTrace, estCostUsd, calibrated:false} or a typed miss. */
  judge: jsonb('judge'),
  /** Last checkpointed step — steps <= cursor are never re-executed (F10 at
   * the run level: a resume must not re-buy step N's tokens). */
  cursorSeq: integer('cursor_seq').notNull().default(0),
  /** Fencing token: bumped per claim; every invocation write is guarded
   * `WHERE invocation_seq = mine`, so zombie writes are rejected. */
  invocationSeq: integer('invocation_seq').notNull().default(0),
  /** Lease: a dead winner's claim is reclaimable after this instant. */
  claimExpiresAt: timestamp('claim_expires_at', { withTimezone: true }),
  pendingQuestion: text('pending_question'),
  pendingAnswer: text('pending_answer'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const labRunSteps = pgTable(
  'lab_run_steps',
  {
    runId: text('run_id')
      .notNull()
      .references(() => labRuns.id, { onDelete: 'cascade' }),
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id),
    seq: integer('seq').notNull(),
    kind: text('kind').$type<'model' | 'tool' | 'check-in'>().notNull(),
    /** Verbatim step record — secret-scanned BEFORE write (fail-closed). */
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.seq] })],
);

export const labHarnessMemory = pgTable(
  'lab_harness_memory',
  {
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id),
    harnessHash: text('harness_hash').notNull(),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.harnessHash, t.key] })],
);

/** Lab Step 7: felt-sample cache — repeated dial positions cost nothing.
 * Org-scoped (rule-2 additive, the 0035 pattern); erased by
 * deleteOrgCascade; F5 meta-test covers the cascade at birth. */
export const labFeltSamples = pgTable(
  'lab_felt_samples',
  {
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id),
    probeHash: text('probe_hash').notNull(),
    policyHash: text('policy_hash').notNull(),
    frontierId: text('frontier_id').notNull(),
    strategyHash: text('strategy_hash').notNull(),
    frontierVersion: integer('frontier_version').notNull(),
    provenance: text('provenance').notNull(),
    output: text('output').notNull(),
    costUsd: doublePrecision('cost_usd'),
    latencyMs: integer('latency_ms').notNull(),
    completionId: text('completion_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.probeHash, t.policyHash, t.frontierId] })],
);

export type LabFeltSampleRow = typeof labFeltSamples.$inferSelect;

/** Lab Step 8: harness catalog (0037) — org-scoped, cascade-covered; runs
 * freeze their own spec copy, so catalog edits never touch run records. */
export const labHarnesses = pgTable(
  'lab_harnesses',
  {
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id),
    harnessHash: text('harness_hash').notNull(),
    name: text('name').notNull(),
    specText: text('spec_text').notNull(),
    sidecar: jsonb('sidecar').notNull(),
    clusterId: text('cluster_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.harnessHash] })],
);


/** L-G1 (Lab direction v2, 2026-08-26): the trust record — the CURRENT
 * permission per (harness, action class), with provenance. Evidence is
 * computed from records, never stored as a scalar. The write asymmetry is
 * the product: tightening is automatic, loosening requires an accepted
 * graduation proposal (enforced at the repo/API layer). */
export type LabGrantState = 'supervised' | 'autonomous' | 'blocked';
export type LabRiskTier = 'reversible-read' | 'reversible-act' | 'irreversible-act' | 'never-graduates';
export const labActionGrants = pgTable(
  'lab_action_grants',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    harnessHash: text('harness_hash').notNull(),
    actionClass: text('action_class').notNull(),
    riskTier: text('risk_tier').$type<LabRiskTier>().notNull(),
    state: text('state').$type<LabGrantState>().notNull().default('supervised'),
    /** Mandatory sampling for autonomous classes — floored, never 0:
     * unaudited autonomy is unmeasured autonomy. Supervised = 1. */
    auditRate: doublePrecision('audit_rate').notNull().default(1),
    stateReason: text('state_reason'),
    grantedAt: timestamp('granted_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /** suite_certifications id when a graduation rode a certification. */
    certificationId: text('certification_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('lab_action_grants_identity_idx').on(t.orgId, t.harnessHash, t.actionClass)],
);
export type LabActionGrantRow = typeof labActionGrants.$inferSelect;

/** R1 (Router direction, 2026-08-27): the org's compiled router, minted as
 * versioned artifacts. `document` is the full assembled router (policy +
 * assignments + provenance); `routerHash` is its stable content hash (the
 * volatile display fields — bound latency — are excluded from hashing).
 * Append-only; lazily minted on read when the hash moves. */
export const routerVersions = pgTable(
  'router_versions',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    routerHash: text('router_hash').notNull(),
    document: jsonb('document').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('router_versions_identity_idx').on(t.orgId, t.version)],
);
export type RouterVersionRow = typeof routerVersions.$inferSelect;

/** O1 (Onboarding, 2026-08-27): the org's product description interpreted
 * into a workload mix — "we think you're building X". One row per org;
 * `source` records whether a model extraction or the deterministic
 * fallback (single-cluster assigner) produced the mix. */
export const routerInterpretations = pgTable('router_interpretations', {
  orgId: text('org_id')
    .primaryKey()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  description: text('description').notNull(),
  summary: text('summary').notNull(),
  mix: jsonb('mix').$type<Array<{ clusterId: string; share: number }>>().notNull(),
  source: text('source').notNull().default('model'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
export type RouterInterpretationRow = typeof routerInterpretations.$inferSelect;

/** P1 (the clock): armed/paused state of a standing mission, bound to one
 * content-addressed harness version. The scheduler's dedup is
 * last_window_key: at most one check per cadence window, ever. */
// X1 (2026-08-28): the per-run file workspace — code-produced files persist
// across steps/legs and become the run's downloadable artifacts. Content is
// inline bytea (sizes capped far below object-storage territory); base64 in
// TS (drizzle customType below) so no driver-specific buffer handling leaks
// upward.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

/** X8: live-steering queue — operator guidance for a running run, consumed
 * by the loop at its next model step (stamped on that step for replay). */
export const labRunSteers = pgTable('lab_run_steers', {
  id: text('id').primaryKey(),
  orgId: text('org_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  runId: text('run_id').notNull(),
  text: text('text').notNull(),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  consumedSeq: integer('consumed_seq'),
});
export type LabRunSteerRow = typeof labRunSteers.$inferSelect;

export const labCustomConnectors = pgTable(
  'lab_custom_connectors',
  {
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    connectorId: text('connector_id').notNull(),
    displayName: text('display_name').notNull(),
    endpointUrl: text('endpoint_url').notNull(),
    serverName: text('server_name').notNull().default('unknown'),
    /** Pinned at registration: [{name, description, inputSchema}] — capped,
     * custody-scanned, admin-approved. The runtime serves THIS surface. */
    tools: jsonb('tools').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.connectorId] })],
);

export const labDigests = pgTable('lab_digests', {
  orgId: text('org_id')
    .primaryKey()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  lastWindowKey: text('last_window_key').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const labRunFiles = pgTable(
  'lab_run_files',
  {
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    runId: text('run_id').notNull(),
    name: text('name').notNull(),
    mime: text('mime').notNull().default('application/octet-stream'),
    size: integer('size').notNull(),
    sha256: text('sha256').notNull(),
    content: bytea('content').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.runId, t.name] })],
);

export const labMissions = pgTable(
  'lab_missions',
  {
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    harnessHash: text('harness_hash').notNull(),
    state: text('state').$type<'armed' | 'paused'>().notNull().default('paused'),
    cadenceCron: text('cadence_cron').notNull(),
    armedBy: text('armed_by').notNull(),
    armedAt: timestamp('armed_at', { withTimezone: true }).notNull().defaultNow(),
    lastWindowKey: text('last_window_key'),
    lastNote: text('last_note'),
    /** P5: sha256 of the webhook inlet secret (plaintext shown once at arm). */
    hookTokenHash: text('hook_token_hash'),
    /** P5: per-url feed hashes + stamps: {url: {hash, checkedAt, firedAt}}. */
    feedState: jsonb('feed_state').notNull().default({}),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.harnessHash] })],
);
export type LabMissionRow = typeof labMissions.$inferSelect;

export type LabHarnessRow = typeof labHarnesses.$inferSelect;

/** Lab Step 10: superpower grants (0038) — the first REVERSIBLE secret
 * store. token_envelope / refresh_envelope are @potion/custody envelopes
 * (never plaintext); the route-facing repo (repos/lab-grants.ts) NEVER
 * selects them, and the only decrypt path (openGrantToken) is fenced to
 * the worker. Org-scoped, cascade-covered at birth (F5 meta-test). */
export const labSuperpowerGrants = pgTable(
  'lab_superpower_grants',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id),
    connectorId: text('connector_id').notNull(),
    superpowerId: text('superpower_id').notNull(),
    scopesGranted: jsonb('scopes_granted').$type<string[]>().notNull(),
    tokenEnvelope: text('token_envelope').notNull(),
    refreshEnvelope: text('refresh_envelope'),
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
    status: text('status').$type<'active' | 'expired' | 'revoked'>().notNull(),
    grantedBy: text('granted_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('lab_superpower_grants_org_connector').on(t.orgId, t.connectorId)],
);

export type LabSuperpowerGrantRow = typeof labSuperpowerGrants.$inferSelect;

export type LabRunRow = typeof labRuns.$inferSelect;
export type LabRunStepRow = typeof labRunSteps.$inferSelect;
export type LabRunState = LabRunRow['state'];

// ---- the learning period (migration 0045) ----
export const orgIncumbents = pgTable('org_incumbents', {
  orgId: text('org_id').primaryKey().references(() => orgs.id, { onDelete: 'cascade' }),
  models: jsonb('models').notNull().default([]),
  other: text('other'),
  samplingConsent: boolean('sampling_consent').notNull().default(false),
  sampleCapPerCluster: integer('sample_cap_per_cluster').notNull().default(40),
  designatedAt: timestamp('designated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const learningProposals = pgTable(
  'learning_proposals',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    clusterId: text('cluster_id').notNull(),
    suiteId: text('suite_id').notNull(),
    incumbentModel: text('incumbent_model').notNull(),
    incumbentHash: text('incumbent_hash').notNull(),
    incumbentQuality: doublePrecision('incumbent_quality').notNull(),
    incumbentCostPer1K: doublePrecision('incumbent_cost_per_1k'),
    servingHash: text('serving_hash').notNull(),
    servingModel: text('serving_model').notNull(),
    servingQuality: doublePrecision('serving_quality').notNull(),
    servingCostPer1K: doublePrecision('serving_cost_per_1k'),
    retention: jsonb('retention').notNull(),
    suggestedFloor: doublePrecision('suggested_floor').notNull(),
    projectedSaving: doublePrecision('projected_saving'),
    items: integer('items').notNull(),
    spendUsd: doublePrecision('spend_usd').notNull().default(0),
    status: text('status').notNull().default('proposed'),
    statusReason: text('status_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    appliedPolicyId: text('applied_policy_id'),
  },
  (t) => [index('learning_proposals_org_idx').on(t.orgId, t.createdAt)],
);
