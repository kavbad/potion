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
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } }
  | { type: 'input_audio'; input_audio: { data: string; format: 'wav' | 'mp3' } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** Text. Content-part arrays are flattened to their text at the API edge
   * (2026-08-23); image parts are refused there until a vision frontier
   * exists. */
  content: string;
  /** Multimodal parts (G, 2026-08-23): when present they are the message's
   * true content, forwarded verbatim to the provider; `content` stays the
   * text view every text-only consumer (classifier, shape, sampling) reads. */
  parts?: ContentPart[];
  // ---- agentic turns (2026-08-23): forwarded verbatim to the provider ----
  /** An assistant turn that called tools (the second turn of every loop). */
  tool_calls?: ToolCall[];
  /** A tool-result turn (role 'tool'). */
  tool_call_id?: string;
  name?: string;
}

/** Sampling and format parameters a caller may set (OpenAI names). Forwarded
 * on single-model points; response_format and stop pin the request to
 * single points the way tools do (a combination cannot honor them). */
export interface SamplingParams {
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  seed?: number;
  user?: string;
  response_format?: { type: 'text' | 'json_object' } | { type: 'json_schema'; json_schema: Record<string, unknown> };
  parallel_tool_calls?: boolean;
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
  | { type: 'composite'; startModel: string; upgradeModel: string; upgradeIf: { confidenceBelow: number } }
  /**
   * MIXING PROGRAM rung 3 (2026-08-22): a mechanism as DATA. A small grammar —
   * call / check / if / vote / pick — run by one audited interpreter
   * (packages/strategies program.ts). New mechanisms are new programs, never
   * new code in production: static call and cost bounds are computed from
   * the tree before it runs, and the receipt names the program's hash.
   */
  | { type: 'program'; name: string; body: ProgramNode };

/** Program grammar. Every leaf `call` names a model, so the boot-time
 *  frontier↔registry check (which walks `model` keys) covers programs too. */
export type ProgramNode =
  /** One model call on the request; yields text + confidence (when exposed). */
  | { op: 'call'; model: string }
  /** Branch on a check over previously computed nodes. */
  | { op: 'if'; check: ProgramCheck; then: ProgramNode; else: ProgramNode }
  /** Majority over normalized answers of ≥3 nodes; ties → the first. */
  | { op: 'vote'; of: ProgramNode[] }
  /** Pick among nodes: by confidence (highest), or by a judge model's choice. */
  | { op: 'pick'; of: ProgramNode[]; by: { kind: 'confidence' } | { kind: 'judge'; model: string } };

export type ProgramCheck =
  /** The first two `of` nodes agree (normalized text equality). */
  | { kind: 'agree'; of: [ProgramNode, ProgramNode] }
  /** The node's confidence is at least `min` (false when no confidence). */
  | { kind: 'confidence'; of: ProgramNode; min: number }
  /** The node's text matches the pattern. */
  | { kind: 'regex'; of: ProgramNode; pattern: string }
  /** The node's text parses as JSON and, if given, has these top-level keys. */
  | { kind: 'json'; of: ProgramNode; requiredKeys?: string[] };

// ---- eval ----
export type ScoringMethod =
  | { kind: 'exact'; field?: string }
  | { kind: 'code-exec'; language: 'javascript' | 'python'; tests: string }
  | { kind: 'field-match'; schema: Record<string, 'string' | 'number' | 'boolean' | 'array'> }
  | { kind: 'llm-judge'; rubric: string; judgeModel: string; scale: [number, number] }
  /** MIXING M3 instrument (2026-08-23): the answer must be a tool call.
   * Full credit for the expected name with every expected argument present
   * and equal; half credit for the right name with different arguments;
   * zero for text or another tool. */
  | { kind: 'tool-call'; expect: { name: string; arguments?: Record<string, unknown> } };

export interface EvalItem {
  id: string;
  clusterId: ClusterId;
  prompt: ChatMessage[];
  /** Tools offered to the model for this item (forwarded as the request's
   * tools; MIXING M3). */
  tools?: Tool[];
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
  /** The instrument this cell was measured on (G, 2026-08-23): set by the
   * LEG, not inferred from the scorer — a vision suite scored by field-match
   * is still vision evidence. Absent = 'default' (or 'tools' when the scorer
   * is 'tool-call', the legacy derivation). */
  instrument?: 'default' | 'tools' | 'vision' | 'audio';
  judgeAgreement?: number;
  /** The producing stage's confidence (exp mean token logprob), when the
   *  provider exposed logprobs. The selector-training signal. */
  confidence?: number;
  confidenceMethod?: 'logprob';
  // Aggregated across all strategy stages PLUS scoring overhead: for
  // llm-judge items the judge call's tokens+cost are summed in (M1b — judge
  // spend is real provider spend). usage.latencyMs stays strategy-only;
  // scorer latency is deliberately not folded in.
  usage: Usage;
  /** The scorer's own spend (llm-judge), kept OUT of `usage` (2026-08-23):
   * usage is the serving truth the frontier's cost axis aggregates; this is
   * the measurement truth the run's budget adds back. Absent on legacy cells
   * (their usage is judge-inclusive and cannot be unsplit). */
  scorerUsage?: Usage;
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
  /** TRUE when this point was measured on items that carried tools (MIXING
   * M3): a combination may serve tool-carrying requests only with this. */
  toolsMeasured?: boolean;
  qualityCi95: number;
  /**
   * G2.6 latency provenance — the same discipline quality already carried, so
   * a latency-bounded selection is auditable, not merely asserted.
   *
   * A [lo, hi] PAIR rather than qualityCi95's half-width: the sampling
   * distribution of a p95 is asymmetric, and a half-width would assert a
   * symmetry that does not hold. `latencySeed` makes the interval
   * re-derivable from (latencies, seed, BOOTSTRAP_RESAMPLES).
   *
   * This is HARNESS-grade provenance — a spread over eval ITEMS, not a
   * distribution of one call under load. SERVING-grade latency is a property
   * of the operating point, not of the frontier, and rides separately as
   * LatencyEvidence. Do not "unify" the two: they measure different spans.
   */
  latencyN?: number;
  latencyP95Ci95?: [number, number];
  latencySeed?: number;
  suiteId?: string;
  suiteVersion?: string;
  /** The rubric the llm-judge evidence was scored under (0022 identity). */
  rubricHash?: string;
  /** judge_calibrations uuid backing trust in that rubric×judge. */
  calibrationId?: string;
  /**
   * Lab Step 5 (the F7 discipline at birth): sha256 over the canonical
   * items of the COMMITTED suite the evidence was evaluated against —
   * binds the point to what the instrument WAS, not to a filename whose
   * contents can drift. Stamped by the platform sweep; absent elsewhere.
   */
  suiteContentHash?: string;
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
  /** The instrument the points were measured on: 'default' | 'tools' | 'vision' | 'audio' (MIXING M3). Absent = 'default'. */
  instrument?: 'default' | 'tools' | 'vision' | 'audio';
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
  /** Verification SLA bound (G2.2): minutes an OPEN advisory may await its
   * contractual verdict before 'guarantee currently unverifiable' escalates
   * as its own notifiable condition (distinct from breach). Absent →
   * platform 240, applied at EVALUATION time only. The SLA clock starts at
   * advisory creation (standing decision). */
  verifySlaMin?: number | undefined;
  /** Auto-restore on recovery (G2.2): hierarchy mode only — a CONFIDENT
   * suite-verify recovery (retention CI95 LOWER ≥ floor, symmetric to the
   * breach test) on the rolled-back strategy auto-resolves the active
   * rollback. Legacy mode (no incumbent): honest surfaced no-op —
   * serve-side recovery on a rolled-back tuple is structurally
   * undetectable (its samples stop accumulating). Default false. */
  autoRestore?: boolean | undefined;
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
      /** Per-kind-of-work floors (2026-08-22): a cluster listed here is served
       * under its own floor; every other cluster uses qualityFloor. */
      clusterFloors?: Record<string, number> | undefined;
      shadow?: ShadowConfig | undefined;
      guarantee?: GuaranteeConfig | undefined;
    }
  | {
      type: 'latency_bound'; // then max quality
      p95Ms: number;
      shadow?: ShadowConfig | undefined;
      guarantee?: GuaranteeConfig | undefined;
    }
  /**
   * G2.6 — a COMPOUND policy: a quality floor AND a hard latency bound, with
   * cost as the remaining objective.
   *
   * The latency bound is a HARD CONSTRAINT (owner's call): a bound stated in a
   * guarantee is an SLO the customer declared, not a preference, so a point
   * whose measured p95 exceeds it is excluded — never traded off against cost.
   *
   * A distinct union member rather than an optional `p95Ms` on min_cost:
   * `policy.type` is what lands in request_logs.policy_type, the `policy=`
   * field of x-frontier-trace and incidents.detail, so an optional field would
   * make a latency-bounded policy indistinguishable from an unbounded one in
   * every audit surface — failing the "the consequence must be visible"
   * requirement at the first surface where it matters.
   */
  | {
      type: 'compound';
      qualityFloor: number;
      clusterFloors?: Record<string, number> | undefined;
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
