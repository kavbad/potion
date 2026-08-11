// Local mirrors of the apps/server API shapes (SPEC §8). The dashboard talks
// to the server over HTTP only, so these stay dependency-free.

export type ProviderId = 'anthropic' | 'openai' | 'google' | 'openrouter' | 'mock';

export type Policy =
  | { type: 'max_quality'; costCeilingPer1K: number }
  | { type: 'min_cost'; qualityFloor: number }
  | { type: 'latency_bound'; p95Ms: number }
  /** G2.6: a quality floor AND a hard latency bound, cheapest among the
   * survivors. The bound EXCLUDES — it is an SLO the customer stated, not a
   * preference — so the UI's job is to show what that exclusion costs. */
  | { type: 'compound'; qualityFloor: number; p95Ms: number };

export type StrategyConfig =
  | { type: 'single'; model: string }
  | {
      type: 'cascade';
      stages: Array<{ model: string; escalateIf?: { confidenceBelow?: number } }>;
      confidenceMethod: string;
    }
  | { type: 'best-of-n'; model: string; n: number; judge: { model: string } }
  | { type: 'draft-verify'; draftModel: string; verifierModel: string }
  | { type: 'ensemble'; models: string[]; fusion: { method: string } }
  | {
      type: 'decompose';
      decomposerModel: string;
      routing: Record<string, string>;
      fusion?: { method: string };
    };

export type ProviderKeyStatus = 'active' | 'revoked' | 'rotating';

export interface ProviderKeyDto {
  id: string;
  provider: ProviderId;
  name: string;
  maskedKey: string;
  createdAt?: string;
  /** Custody is REAL (M2 #16): true when the key is active + custodied and
   * serves its org. */
  servingEnabled?: boolean;
  status?: ProviderKeyStatus;
  keyVersion?: number;
  lastValidatedAt?: string | null;
  /** e.g. 'aes-256-gcm-envelope'. */
  encryption?: string;
}

export interface KeysResponse {
  keys: ProviderKeyDto[];
}

/** One custody_audit row (M2 #16) — never carries key material. */
export interface KeyAuditEntryDto {
  id: string;
  actor: string;
  action: 'encrypt' | 'decrypt' | 'rotate' | 'revoke' | 'validate';
  metadata?: Record<string, unknown> | null;
  createdAt: string;
}

export interface KeyAuditResponse {
  keyId: string;
  audit: KeyAuditEntryDto[];
}

/** Provenance of an evidence point (M1a). 'unknown' == never recorded. */
export type PointProvenance = 'mock' | 'live' | 'unknown';

export interface FrontierClusterDto {
  clusterId: string;
  frontierId: string;
  version: number;
  pointCount: number;
  createdAt: string;
  /** Per-cluster provenance summary: points backed by live provider evidence
   * vs simulated (provider_mode 'mock'/'unknown'). */
  provenance: { live: number; simulated: number };
}

export interface FrontierListResponse {
  clusters: FrontierClusterDto[];
}

export interface FrontierPointDto {
  strategyHash: string;
  strategyConfig: StrategyConfig;
  quality: number;
  costPer1K: number;
  latencyP95: number;
  providerMode?: PointProvenance;
  dominated: boolean;
}

/** Which clock a latency number came off, over what evidence (G2.6). The two
 * sources measure different SPANS, so the badge says which. */
export interface LatencyEvidenceDto {
  source: 'serving' | 'harness';
  p95Ms: number;
  n: number;
  provisional: boolean;
  windowMin?: number;
  span: 'end-to-end' | 'strategy-only';
}

/** What a latency bound is costing, and what relaxing it would return (G2.6). */
export interface LatencyPremiumDto {
  binding: 'latency' | 'quality' | 'none';
  savingsPct: number;
  deltaCostPer1K: number;
  relaxLatencyToMs: number | null;
  relaxQualityToFloor: number | null;
}

/** The bound admitted no quality-qualifying point: the fastest QUALIFYING
 * point was served and the SLO was knowingly missed (G2.6). */
export interface LatencyViolationDto {
  boundMs: number;
  qualityFloor: number;
  servedP95Ms: number;
  servedStrategyHash: string;
  relaxLatencyToMs: number | null;
  relaxQualityToFloor: number | null;
}

export interface OperatingPointDto {
  strategyHash: string;
  strategyConfig: StrategyConfig;
  quality: number;
  costPer1K: number;
  latencyP95: number;
  policy: Policy;
  fallback: 0 | 1;
  latencyEvidence?: LatencyEvidenceDto | null;
  latencyPremium?: LatencyPremiumDto | null;
  latencyViolation?: LatencyViolationDto | null;
}

export interface FrontierResponse {
  frontier: {
    id: string;
    clusterId: string;
    version: number;
    pricesVersion: string;
    createdAt: string;
    points: FrontierPointDto[];
  };
  operatingPoint: OperatingPointDto | null;
}

export interface WorkloadAssignmentDto {
  index: number;
  prompt: string;
  clusterId: string;
  confidence: number;
}

export interface WorkloadResponse {
  total: number;
  breakdown: Record<string, number>;
  avgConfidence: number;
  assignments: WorkloadAssignmentDto[];
}

export interface PolicyResponse {
  policy: { id: string; name: string; config: Policy };
  boundKeyId: string | null;
  apiKey?: string;
}

export interface SnippetResponse {
  policy: Policy;
  url: string;
  curl: string;
  openaiNode: string;
}

export interface ApiError {
  error: { message: string; type: string };
}

// ---- usage & billing (M2 Wave 2, ROADMAP #17/#18) ----

export interface UsageClusterSliceDto {
  clusterId: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  platformCostUsd: number;
}

/** group_by=day row: one day + its per-cluster breakdown. */
export interface UsageDayRowDto {
  day: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  platformCostUsd: number;
  clusters: UsageClusterSliceDto[];
}

/** group_by=cluster row: whole-window totals per cluster + avg $/1K. */
export interface UsageClusterRowDto extends UsageClusterSliceDto {
  avgCostPer1K: number;
}

export interface UsageByDayResponse {
  orgId: string;
  from: string;
  to: string;
  groupBy: 'day';
  rows: UsageDayRowDto[];
}

export interface UsageByClusterResponse {
  orgId: string;
  from: string;
  to: string;
  groupBy: 'cluster';
  rows: UsageClusterRowDto[];
}

export interface UsageTotalsDto {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  platformCostUsd: number;
}

export interface UsageCurrentResponse {
  orgId: string;
  today: { day: string } & UsageTotalsDto;
  mtd: { from: string; to: string } & UsageTotalsDto;
}

// ---- savings report (M3 #21 shadow mode, SPEC §12.4) ----

export interface SavingsAlternativeDto {
  strategyHash: string;
  label: string;
  projectedSpendUsd: number;
  projectedQuality: number;
  deltaUsd: number;
  sampleSize: number;
  confidence: 'low' | 'medium' | 'high';
}

export interface SavingsReportDto {
  orgId: string;
  from: string;
  to: string;
  actualSpendUsd: number;
  alternatives: SavingsAlternativeDto[];
}

// ---- quality guarantee (M3 #22, SPEC §12.5) ----

export interface GuaranteeConfigDto {
  minQuality: number;
  windowMin: number;
  sampleRate: number;
  action: 'rollback' | 'alert';
  /** G0.1: judge model alias override (absent → platform default). */
  judgeModel?: string;
  /** G0.3: evidence floor override (absent → platform 5; hard minimum 5). */
  minSamples?: number;
}

/** Judge-trust evidence per policy (G0.2). */
export interface JudgeCalibrationDto {
  judgeModel: string;
  pearsonVsTruth: number | null;
  n: number;
  flagged: boolean;
  providerMode: string;
  createdAt: string;
}

export interface IncidentDto {
  id: string;
  kind: 'quality_breach' | 'rollback';
  detail: {
    clusterId?: string;
    fromStrategy?: string;
    toStrategy?: string;
    toFrontierVersion?: number;
    targetSource?: 'previous-version' | 'current-version';
    rollingQuality?: number;
    minQuality?: number;
    windowMin?: number;
    samples?: number;
    intendedAction?: string;
    reason?: string;
    // G0.3 statistical evidence (CI-based breach decisions):
    policyId?: string;
    ci95?: [number, number];
    seed?: number;
    resamples?: number;
    minSamples?: number;
  } & Record<string, unknown>;
  createdAt: string;
  resolvedAt: string | null;
}

export interface GuaranteePolicyStatusDto {
  policyId: string;
  guarantee: GuaranteeConfigDto;
  rollingQuality: number | null;
  samples: number;
  breaches: IncidentDto[];
  judgeCalibration?: JudgeCalibrationDto | null;
}

export interface GuaranteeStatusDto {
  orgId: string;
  policies: GuaranteePolicyStatusDto[];
  /** G2.1: active incumbent designations (absent on pre-G2.1 servers). */
  incumbents?: Array<{ clusterId: string; strategyHash: string; designatedAt: string }>;
  openAdvisories?: number;
}

// ---- G2.1 guarantee report (trust hierarchy; retention headline) ----

export interface RetentionHeadlineDto {
  verdict: 'all-clear' | 'contractual-breach';
  mean: number;
  ci95: [number, number];
  floor: number;
  pairs: number;
  excludedPairs: number;
  seed: number;
  confidence: 'low' | 'medium' | 'high';
  providerMode: string;
  at: string;
  incidentId: string;
}

export interface VerificationStateDto {
  state: 'verified' | 'pending' | 'unverifiable' | 'none';
  openAdvisoryAgeMin: number | null;
  verifyAttempts: number;
  lastAttempt: { at: string; outcome: string; detail: string | null } | null;
  escalatedAt: string | null;
  verifySlaMin: number;
}

export interface GuaranteeReportEntryDto {
  policyId: string;
  clusterId: string;
  retention: RetentionHeadlineDto | null;
  retentionUnavailableReason: string | null;
  /** Suite-certification state (Decision 2). The server has always sent
   * this; the DTO type had drifted without it. Null for non-agent clusters. */
  certification: {
    certified: boolean;
    selfRetentionMean: number | null;
    reason: string | null;
  } | null;
  /** G2.2 (absent on pre-G2.2 servers). */
  verification?: VerificationStateDto;
  incumbent: { clusterId: string; strategyHash: string; designatedAt: string } | null;
  derivedFloor: { floor: number; provenance: { n: number; mean: number; ci95: [number, number]; windowMin: number; incumbentHash: string } } | null;
  openAdvisories: IncidentDto[];
  incidents: Array<IncidentDto & { leg: 'serve' | 'suite' | 'legacy' }>;
  qualitySeries: Array<{ day: string; mean: number | null; samples: number }>;
}

export interface GuaranteeReportDto {
  orgId: string;
  from: string;
  to: string;
  entries: GuaranteeReportEntryDto[];
  legacyPath: boolean;
  generatedAt: string;
}

// ---- M4b #37 recipe library (the autoresearcher's accumulated asset) ----

export type RecipeStatus = 'candidate' | 'frontier' | 'archived';

/** Provenance of a recipe's eval evidence. 'live' may badge LIVE; 'mock',
 * 'mixed' and 'unknown' must badge SIMULATED (mock evidence is never
 * presented as live). */
export type RecipeProvenance = 'live' | 'mock' | 'mixed' | 'unknown';

export interface RecipeCycleRef {
  id: string;
  trigger: string;
  focusAlias: string | null;
  createdAt: string;
}

export interface RecipeDto {
  hash: string;
  config: StrategyConfig;
  label: string;
  status: RecipeStatus;
  provenance: RecipeProvenance;
  lineage: {
    evalCount: number;
    runIds: string[];
    clusters: string[];
    firstSeen: string | null;
    lastSeen: string | null;
    cycles: RecipeCycleRef[];
  };
  registeredAt: string;
}

export interface RecipesResponse {
  recipes: RecipeDto[];
}

export interface ResearchCycleDto {
  id: string;
  trigger: 'scan' | 'manual' | 'schedule';
  focusAlias: string | null;
  status: 'queued' | 'running' | 'completed' | 'failed';
  candidates: number;
  spendUsd: number;
  provenance: string;
  seed: number | null;
  createdAt: string;
  completedAt: string | null;
}

export interface ResearchCyclesResponse {
  cycles: ResearchCycleDto[];
}

// ---- M4b #32 public leaderboard ----

export interface LeaderboardEntry {
  clusterId: string;
  clusterName: string;
  strategyHash: string;
  strategyLabel: string;
  costPer1K: number;
  quality: number;
  verificationRunId: string | null;
  frontierVersion: number;
  verifiedAt: string | null;
}

export interface LeaderboardResponse {
  status: 'ok' | 'awaiting_live_verification';
  message?: string;
  entries: LeaderboardEntry[];
  adoptingOrgs: string[];
}

// M5 (#36): trace rollup + waterfall DTOs (mirrors apps/server/src/routes/traces.ts).
export interface TraceSession {
  traceId: string;
  spanCount: number;
  totalCostUsd: number;
  models: string[];
  startedAt: string;
  endedAt: string;
  loops: Array<{ signature: string; count: number }>;
  looping: boolean;
  metadataOnly: boolean;
}
export interface TracesResponse {
  orgId: string;
  sessions: TraceSession[];
}
export interface TraceSpanDetail {
  spanId: string;
  parentId: string | null;
  name: string;
  model: string | null;
  usage: Record<string, unknown>;
  costUsd: number;
  ts: string;
  attrs: Record<string, unknown>;
}
export interface TraceWaterfallResponse {
  traceId: string;
  totalCostUsd: number;
  spans: TraceSpanDetail[];
}
export interface TraceRetentionResponse {
  orgId: string;
  traceRetentionDays: number;
}
