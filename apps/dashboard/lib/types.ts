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
  /** What measuring this org's workloads cost this month (billed to the org). */
  measurementUsd?: number;
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

// ---- Connect & auto-route (SERVING-ROADMAP S1) ----

/** One serving key, metadata only. The raw `pk_…` exists in no readable
 * form — only its sha256 is stored — so no field here can carry it. */
export interface ServingKeyDto {
  id: string;
  name: string;
  scopes: string | null;
  env: string | null;
  policyId: string | null;
  createdAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface ClusterReadinessDto {
  clusterId: string;
  name: string;
  description: string;
  /** A frontier exists AND survives the provenance guard for this server. */
  ready: boolean;
  frontierVersion: number | null;
  pointCount: number;
  provenance: 'live' | 'mock' | 'blocked';
}

export interface ConnectionResponse {
  baseUrl: string;
  endpoint: string;
  /** false = derived from the request, only trustworthy without a proxy. */
  baseUrlConfigured: boolean;
  policy: { id: string; name: string; config: Policy; description: string } | null;
  snippets: { url: string; curl: string; openaiNode: string } | null;
  servingKeys: ServingKeyDto[];
  serving: {
    providerMode: 'mock' | 'live';
    byok: boolean;
    byokProviders: string[];
    platformProviders: string[];
  };
  autoRouting: { ready: number; total: number; clusters: ClusterReadinessDto[] };
}

/** One request, with the routing decision it actually got — read back out of
 * the `x-frontier-trace` we returned to the caller, not re-derived. */
export interface RoutingActivityRow {
  ts: string;
  status: string | null;
  model: string | null;
  latencyMs: number | null;
  costUsd: number | null;
  clusterId: string | null;
  strategy: string | null;
  frontierVersion: number | null;
  policyType: string | null;
  /** null = no routing decision on this row (auth failures, budget refusals). */
  fallback: 0 | 1 | null;
  provenance: 'live' | 'mock' | 'blocked' | null;
  /** Requires BOTH a real frontier and a policy-selected point. Unknown ⇒ false. */
  routed: boolean;
}

export interface RoutingActivityResponse {
  requests: RoutingActivityRow[];
  summary: {
    returned: number;
    withRoutingDecision: number;
    routed: number;
    defaulted: number;
    clustersSeen: string[];
    byCluster: Record<string, number>;
  };
}

// ---- "What are you building?" (SERVING-ROADMAP S2) ----

export interface PlanPolicyOption {
  priority: 'cost' | 'quality' | 'speed';
  policy: Policy;
  description: string;
  /** The point selectPoint returns for this policy on this frontier TODAY. */
  point: {
    strategyHash: string;
    strategy: string;
    quality: number;
    costPer1K: number;
    latencyP95: number;
    /** G2.6: 'harness' latency is measured during EVALUATION (strategy-only
     *  span) and is provisional; 'serving' is measured on real requests,
     *  end-to-end. A from-scratch customer always sees harness-grade. */
    latencySource: 'serving' | 'harness';
    latencyProvisional: boolean;
    latencySpan: 'end-to-end' | 'strategy-only';
    providerMode: string;
    n: number | null;
    qualityCi95: number | null;
    /** Cost relative to the highest-quality measured strategy. Fraction. */
    savedVsBestQuality: number | null;
  } | null;
  /** Present exactly when point is null — shown, never hidden. */
  infeasible: string | null;
}

export interface PlanResponse {
  intent: {
    description: string;
    cluster: { clusterId: string; name: string; description: string; confidence: number };
    /** Gap to the runner-up. Near zero = a coin flip the user must see. */
    margin: number;
    alternatives: Array<{ clusterId: string; name: string; confidence: number }>;
    sampleBreakdown: Record<string, number> | null;
    sampleCount: number;
  };
  evidence: {
    measured: boolean;
    frontierVersion: number | null;
    provenance: 'live' | 'mock' | 'blocked';
    pointCount: number;
    /** 'harness' until this org has real serving traffic for this cluster. */
    latencySource: 'serving' | 'harness';
    /** Real row counts behind the frontier — what produced these numbers. */
    evaluations: number;
    strategies: number;
    items: number;
    /** Strategies measured then beaten outright. null = not knowable here. */
    dominatedAway: number | null;
    /** false = counts are a floor from surviving points, not the full campaign. */
    countsAreComplete: boolean;
  };
  options: PlanPolicyOption[];
  /** EVERY measured strategy on the frontier, not just the three a policy
   *  shape selects. Sorted best-quality first; the surface re-sorts. */
  frontier: Array<{
    strategyHash: string;
    strategy: string;
    quality: number;
    qualityCi95: number | null;
    costPer1K: number;
    latencyP95: number;
    latencyProvisional: boolean;
    n: number | null;
    providerMode: string;
    savedVsBestQuality: number | null;
    selectedBy: Array<'cost' | 'quality' | 'speed'>;
    /** Derived AND verified to select this row. null = cannot be isolated. */
    policy: Policy | null;
  }>;
  /** platform-measured = Potion's measurement of this WORKLOAD TYPE, not of
   *  the caller's own traffic, which does not exist yet. */
  basis: 'platform-measured' | 'unmeasured';
}
