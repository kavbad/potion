// packages/core — THE CONTRACT. Every other package imports these types.
// Aligned with SPEC.md §1. Changes here require orchestrator review.

export type ProviderId = 'anthropic' | 'openai' | 'google' | 'openrouter' | 'mock';

/**
 * Evidence provenance (M1a): was the number produced by the deterministic
 * mock providers or by a live provider API? Absence on a value object means
 * the provenance was never recorded — the db persists that explicitly as
 * 'unknown' (see packages/db drizzle/0002_provenance.sql) and readers must
 * treat it as NOT live evidence.
 */
export type ProviderMode = 'mock' | 'live';

export interface ModelRef {
  provider: ProviderId;
  model: string; // provider-native id or alias from prices.json
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
}

// ---- clustering ----
export type SeededClusterId =
  | 'code-gen'
  | 'code-review'
  | 'extraction'
  | 'summarization'
  | 'classification'
  | 'multi-step-reasoning'
  | 'creative'
  | 'rewrite-edit'
  | 'rag-answer'
  | 'agentic-tool-use';

export type ClusterId = SeededClusterId | 'general' | (string & {});

export interface TaskCluster {
  id: ClusterId;
  name: string;
  description: string;
  exemplarCount: number;
}

// ---- chat ----
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// ---- tool calling (M3 #25 OpenAI parity; ADDITIVE — all uses optional) ----
// OpenAI-shaped function-tool contract. `arguments` is the JSON-string the
// provider produced (NOT a parsed object) so passthrough is lossless.
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface Tool {
  type: 'function';
  function: {
    name: string;
    // `| undefined` so zod-parsed values assign cleanly under
    // exactOptionalPropertyTypes (zod .optional() infers `T | undefined`).
    description?: string | undefined;
    parameters?: Record<string, unknown> | undefined;
  };
}

export type ToolChoice =
  | 'none'
  | 'auto'
  | 'required'
  | { type: 'function'; function: { name: string } };

// ---- strategies (declarative configs) ----
export interface CascadeStage {
  model: string;
  escalateIf?: { confidenceBelow?: number };
}

export interface JudgeConfig {
  model: string;
  rubric?: string;
}

export interface FusionConfig {
  method: 'judge-pick' | 'concat-rank';
  judge?: JudgeConfig;
}

export type StrategyConfig =
  | { type: 'single'; model: string }
  | { type: 'cascade'; stages: CascadeStage[]; confidenceMethod: 'logprob' | 'self-report-calibrated' }
  | { type: 'best-of-n'; model: string; n: number; judge: JudgeConfig }
  | { type: 'draft-verify'; draftModel: string; verifierModel: string }
  | { type: 'ensemble'; models: string[]; fusion: FusionConfig }
  | { type: 'decompose'; decomposerModel: string; routing: Record<string, string>; fusion?: FusionConfig }
  // M3 #23 composite streaming (SPEC §12.6): stream startModel; when the first
  // token-batch confidence falls below upgradeIf.confidenceBelow, restart from
  // upgradeModel with the already-generated prefix as context.
  | { type: 'composite'; startModel: string; upgradeModel: string; upgradeIf: { confidenceBelow: number } };

// ---- eval ----
export type ScoringMethod =
  | { kind: 'exact'; field?: string }
  | { kind: 'code-exec'; language: 'javascript' | 'python'; tests: string }
  | { kind: 'field-match'; schema: Record<string, 'string' | 'number' | 'boolean' | 'array'> }
  | { kind: 'llm-judge'; rubric: string; judgeModel: string; scale: [number, number] };

export interface EvalItem {
  id: string;
  clusterId: ClusterId;
  prompt: ChatMessage[];
  reference?: unknown;
  scoring: ScoringMethod;
}

export interface EvalResult {
  runId: string;
  itemId: string;
  clusterId: ClusterId;
  strategyHash: string;
  strategyConfig: StrategyConfig;
  quality: number; // normalized 0..1
  scorer: string; // 'exact' | 'code-exec' | 'field-match' | 'llm-judge:<model>'
  judgeAgreement?: number;
  // Aggregated across all strategy stages PLUS scoring overhead: for
  // llm-judge items the judge call's tokens+cost are summed in (M1b — judge
  // spend is real provider spend). usage.latencyMs stays strategy-only;
  // scorer latency is deliberately not folded in.
  usage: Usage;
  latencyMs: { p50: number; p95: number; mean: number };
  modelVersions: Record<string, string>; // model alias -> resolved provider version
  pricesVersion: string;
  providerMode?: ProviderMode; // absent == 'unknown' (pre-M1a rows)
  cacheKey: string; // sha256(strategyHash + itemId + judgeVersion + pricesVersion)
  /** Tenant attribution (G1.6); absent = platform evidence. NOT part of the
   * cacheKey identity — safe only while org evidence comes exclusively from
   * org-partitioned item ids (agent-<orgHash6>-…); flagged for G1.7. */
  orgId?: string;
  createdAt: string; // ISO
}

/**
 * Schema-level provenance (G1.6, owner rule): the evidence a frontier point
 * rests on — "here's your frontier and here's why we believe each point".
 * Carried on StrategyAggregate AND FrontierPoint so it survives the
 * aggregate→point projection and carried-over points keep their ORIGINAL
 * links verbatim (a carried point honestly reports the rubric it was
 * actually scored under, even after a rubric supersession). Absent =
 * pre-G1.6 rows. cacheKeys may reference rows later retired to stale —
 * documented tombstones, never dangling deletes.
 */
export interface FrontierPointEvidence {
  /** eval_results cache keys (content-addressed evidence ids) aggregated. */
  cacheKeys: string[];
  /** Distinct eval run ids the rows came from. */
  runIds: string[];
  n: number;
  qualityCi95: number;
  suiteId?: string;
  suiteVersion?: string;
  /** The rubric the llm-judge evidence was scored under (0022 identity). */
  rubricHash?: string;
  /** judge_calibrations uuid backing trust in that rubric×judge. */
  calibrationId?: string;
}

export interface StrategyAggregate {
  clusterId: ClusterId;
  strategyHash: string;
  strategyConfig: StrategyConfig;
  qualityMean: number;
  qualityCi95: number;
  n: number;
  costPer1K: number; // USD per 1000 requests
  latencyP50: number;
  latencyP95: number;
  pricesVersion: string;
  providerMode?: ProviderMode; // absent == 'unknown'
  evidence?: FrontierPointEvidence; // G1.6; absent = pre-provenance
}

// ---- pareto ----
export interface FrontierPoint {
  clusterId: ClusterId;
  strategyHash: string;
  strategyConfig: StrategyConfig;
  quality: number;
  costPer1K: number;
  latencyP95: number;
  providerMode?: ProviderMode; // absent == 'unknown' (treated as simulated)
  evidence?: FrontierPointEvidence; // G1.6; absent = pre-provenance
}

export interface Frontier {
  id: string;
  clusterId: ClusterId;
  version: number;
  parentId: string | null;
  trigger: 'manual' | 'new-model' | 'recompute';
  points: FrontierPoint[];
  pricesVersion: string;
  /** Tenant scope (G1.6): undefined/null = platform frontier. Version
   * chains are SCOPE-EXACT — an org's first frontier is v1/parent-null,
   * never chained off the platform frontier. */
  orgId?: string | null;
  createdAt: string;
}

export interface FrontierDiff {
  clusterId: ClusterId;
  fromVersion: number;
  toVersion: number;
  appeared: FrontierPoint[];
  vanished: FrontierPoint[];
  dominatedBy: { point: FrontierPoint; dominatedBy: FrontierPoint }[];
  narrative: string[]; // plain-English sentences
}

// ---- policies ----
/**
 * Shadow-mode configuration (M3 #21, SPEC §12.4) — ADDITIVE optional member
 * on every Policy variant. After the primary response is sent, a sampled
 * request (per-request: Math.random() < sampleRate) re-executes up to 2
 * candidate strategies asynchronously and records the outcome in
 * shadow_results (migration 0007). The primary latency path is untouched.
 *   candidates: 'frontier' = the OTHER points on the cluster's current
 *               frontier; string[] = explicit strategyHashes (resolved via
 *               the serving frontier's points, then strategy_configs).
 */
export interface ShadowConfig {
  sampleRate: number; // 0..1, per-request sampling probability
  candidates: 'frontier' | string[];
}

/**
 * Quality guarantee (M3 #22, SPEC §12.5) — ADDITIVE optional member on every
 * Policy variant. When present, a sample (per-request: sampleRate) of SERVED
 * answers is quality-scored after the response is sent (fire-and-forget,
 * migration 0008 quality_samples). The rolling mean over `windowMin` minutes
 * is evaluated per serving strategy: below `minQuality` (with ≥5 samples —
 * less is insufficient evidence) the configured `action` fires once per
 * (org, cluster, strategy) per window:
 *   'rollback' — the org's operating point for the cluster moves to the
 *                PREVIOUS frontier version's equivalent point (or the
 *                next-higher-quality point on the current version when no
 *                previous version exists) + an incidents row kind='rollback';
 *   'alert'    — an incidents row kind='quality_breach', routing unchanged.
 */
export interface GuaranteeConfig {
  minQuality: number; // 0..1 rolling-mean floor
  windowMin: number; // rolling window length in minutes
  sampleRate: number; // 0..1, per-request sampling probability
  action: 'rollback' | 'alert';
  /** Judge model alias for sampled-answer scoring (G0.1); absent → platform
   * default (judge-class live / mock-judge mock). */
  judgeModel?: string | undefined;
  /** Minimum window evidence before a breach may fire (G0.3); absent →
   * platform floor (5). Hard minimum 5 — raise only. */
  minSamples?: number | undefined;
  /** Judge completion cap for sampled-answer scoring (G2.1); absent → 128.
   * Verbose judges truncate at 128 → parse fail → quality 0 → silent
   * floor-dragging; orgs with wordy judge models raise this. */
  judgeMaxTokens?: number | undefined;
  /** Contractual retention floor (G2.1): breach iff CI95 upper of
   * serving/incumbent retention on the derived suite < this. Absent → 0.9
   * platform default, applied at EVALUATION time only (minSamples
   * precedent). Scale-free by construction — the incumbent's measured
   * score is the denominator — so it survives "never absolute floors". */
  retentionFloor?: number | undefined;
}

export type Policy =
  | {
      type: 'max_quality';
      costCeilingPer1K: number;
      // `| undefined` so zod-parsed values assign cleanly under
      // exactOptionalPropertyTypes (zod .optional() infers `T | undefined`).
      shadow?: ShadowConfig | undefined;
      guarantee?: GuaranteeConfig | undefined;
    }
  | {
      type: 'min_cost';
      qualityFloor: number;
      shadow?: ShadowConfig | undefined;
      guarantee?: GuaranteeConfig | undefined;
    }
  | {
      type: 'latency_bound'; // then max quality
      p95Ms: number;
      shadow?: ShadowConfig | undefined;
      guarantee?: GuaranteeConfig | undefined;
    };

// ---- prices ----
export interface PriceEntry {
  alias: string;
  provider: ProviderId;
  model: string;
  inputPer1M: number;
  outputPer1M: number;
}

export interface PriceTable {
  version: string;
  updatedAt: string;
  entries: PriceEntry[];
}
