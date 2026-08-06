# SPEC.md — Potion (FRONTIER) Model Mixing Platform MVP

Single source of truth. Subagents implement to these contracts exactly. No unilateral interface changes.
Stack (fixed): pnpm workspaces · TypeScript strict E2E · Node 20 · Fastify · Postgres 16 + Drizzle + pgvector
(PGlite driver in tests/dev, node-pg in local/prod) · BullMQ+Redis (in-process driver in tests/dev) ·
Next.js 15 App Router + Tailwind + recharts · raw-fetch provider SDKs · Vitest.

## 0. Monorepo layout

```
potion/
  package.json            # workspaces: packages/*, apps/*; scripts: build test typecheck lint verify demo:*
  pnpm-workspace.yaml
  tsconfig.base.json      # strict, NodeNext, composite project references
  .eslintrc.cjs / eslint flat config, .gitignore, docker-compose.yml
  prices.json             # versioned price table (see §5)
  tasks/{todo.md,lessons.md}
  packages/
    core/                 # types + pure utils. NO deps beyond zod. Everything imports this.
    db/                   # drizzle schema, migrations, dual driver (pglite | node-pg), repositories
    providers/            # Provider iface + anthropic/openai/google/openrouter/mock + prices loader
    strategies/           # 6 strategy interpreters over StrategyConfig
    cluster/              # embedder iface, centroids, assignment, seed taxonomy loader
    harness/              # eval runner: cache, resume, budget cap, scorers, judge, CLI
    pareto/               # dominance, frontier compute/version/diff, recompute planner
    queue/                # Queue iface + bullmq driver + in-process driver
  apps/
    server/               # Fastify /v1/chat/completions + dashboard API + policies + trace header
    dashboard/            # Next.js 15
```

Dependency direction (acyclic): `core` ← all. `db,providers,queue` ← core. `strategies` ← core,providers.
`cluster` ← core,db,providers. `harness` ← core,db,strategies,providers. `pareto` ← core,db,harness(types only).
`apps/server` ← all packages. `apps/dashboard` ← server HTTP API only.

Internal imports via workspace protocol: `"@potion/core": "workspace:*"`. Every package:
`src/index.ts` public surface; `pnpm build` (tsc) → `dist/`; `pnpm test` (vitest); typecheck strict.

## 1. packages/core — THE CONTRACT

```ts
// ---- ids & refs ----
export type ProviderId = 'anthropic' | 'openai' | 'google' | 'openrouter' | 'mock';
export interface ModelRef { provider: ProviderId; model: string; }  // model = provider-native id or alias from prices.json
export interface Usage { inputTokens: number; outputTokens: number; costUsd: number; latencyMs: number; }

// ---- clustering ----
export type SeededClusterId =
  | 'code-gen' | 'code-review' | 'extraction' | 'summarization' | 'classification'
  | 'multi-step-reasoning' | 'creative' | 'rewrite-edit' | 'rag-answer' | 'agentic-tool-use';
export type ClusterId = SeededClusterId | 'general' | (string & {});
export interface TaskCluster { id: ClusterId; name: string; description: string; exemplarCount: number; }

// ---- chat ----
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; }

// ---- strategies (declarative configs; zod schemas exported as StrategyConfigSchema) ----
export interface CascadeStage { model: string; escalateIf?: { confidenceBelow?: number }; }
export interface JudgeConfig { model: string; rubric?: string; }
export interface FusionConfig { method: 'judge-pick' | 'concat-rank'; judge?: JudgeConfig; }
export type StrategyConfig =
  | { type: 'single'; model: string }
  | { type: 'cascade'; stages: CascadeStage[]; confidenceMethod: 'logprob' | 'self-report-calibrated' }
  | { type: 'best-of-n'; model: string; n: number; judge: JudgeConfig }
  | { type: 'draft-verify'; draftModel: string; verifierModel: string }
  | { type: 'ensemble'; models: string[]; fusion: FusionConfig }
  | { type: 'decompose'; decomposerModel: string; routing: Record<string, string>; fusion?: FusionConfig };
// Every config may carry optional `id` at runtime; canonical hashing ignores `id` field ordering.
export function strategyHash(cfg: StrategyConfig): string;  // sha256 of canonical JSON (stable key order)

// ---- eval ----
export type ScoringMethod =
  | { kind: 'exact'; field?: string }
  | { kind: 'code-exec'; language: 'javascript' | 'python'; tests: string }
  | { kind: 'field-match'; schema: Record<string, 'string' | 'number' | 'boolean' | 'array'> }
  | { kind: 'llm-judge'; rubric: string; judgeModel: string; scale: [number, number] };
export interface EvalItem { id: string; clusterId: ClusterId; prompt: ChatMessage[]; reference?: unknown; scoring: ScoringMethod; }
export interface EvalResult {
  runId: string; itemId: string; clusterId: ClusterId;
  strategyHash: string; strategyConfig: StrategyConfig;
  quality: number;                 // normalized 0..1
  scorer: string;                  // 'exact' | 'code-exec' | 'field-match' | 'llm-judge:<model>'
  judgeAgreement?: number;
  usage: Usage;                    // aggregated across all stages
  latencyMs: { p50: number; p95: number; mean: number };
  modelVersions: Record<string, string>;  // model alias -> resolved provider version
  pricesVersion: string;
  cacheKey: string;                // sha256(strategyHash + itemId + judgeVersion + pricesVersion)
  createdAt: string;               // ISO
}
export interface StrategyAggregate {   // per (runId?, strategyHash, clusterId) rollup fed to pareto
  clusterId: ClusterId; strategyHash: string; strategyConfig: StrategyConfig;
  qualityMean: number; qualityCi95: number; n: number;
  costPer1K: number;               // USD per 1000 requests
  latencyP50: number; latencyP95: number;
  pricesVersion: string;
}

// ---- pareto ----
export interface FrontierPoint {
  clusterId: ClusterId; strategyHash: string; strategyConfig: StrategyConfig;
  quality: number; costPer1K: number; latencyP95: number;
}
export interface Frontier {
  id: string; clusterId: ClusterId; version: number; parentId: string | null;
  trigger: 'manual' | 'new-model' | 'recompute';
  points: FrontierPoint[]; pricesVersion: string; createdAt: string;
}
export interface FrontierDiff {
  clusterId: ClusterId; fromVersion: number; toVersion: number;
  appeared: FrontierPoint[]; vanished: FrontierPoint[];
  dominatedBy: { point: FrontierPoint; dominatedBy: FrontierPoint }[];
  narrative: string[];             // plain-English sentences
}

// ---- policies ----
export type Policy =
  | { type: 'max_quality'; costCeilingPer1K: number }
  | { type: 'min_cost'; qualityFloor: number }
  | { type: 'latency_bound'; p95Ms: number };   // then max quality
export function selectPoint(policy: Policy, frontier: Frontier): FrontierPoint | null;

// ---- prices ----
export interface PriceEntry { alias: string; provider: ProviderId; model: string; inputPer1M: number; outputPer1M: number; }
export interface PriceTable { version: string; updatedAt: string; entries: PriceEntry[]; }
export function costUsd(u: { inputTokens: number; outputTokens: number }, e: PriceEntry): number;
```

zod schemas for every public type above (StrategyConfig, Policy, EvalItem, PriceTable at minimum).
`selectPoint` semantics: max_quality → feasible = costPer1K ≤ ceiling, pick max quality, tie→lower cost;
min_cost → feasible = quality ≥ floor, pick min cost, tie→higher quality; latency_bound → feasible =
latencyP95 ≤ p95Ms, pick max quality. Empty feasible → null (caller falls back per server rule §8).

## 2. packages/providers

```ts
export interface CompleteRequest {
  model: string;                     // alias resolved via PriceTable, or native id
  messages: ChatMessage[];
  params?: { temperature?: number; maxTokens?: number; seed?: number; logprobs?: boolean };
}
export interface CompleteResponse {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
  latencyMs: number;
  logprobConfidence?: number;        // mean token logprob → exp, when provider exposes it
  modelVersion: string;              // resolved concrete version
}
export interface Provider {
  id: ProviderId;
  complete(req: CompleteRequest): Promise<CompleteResponse>;
  embed?(texts: string[]): Promise<number[][]>;   // providers without embeddings leave undefined
}
export interface ProviderFactoryOptions { apiKeys?: Partial<Record<ProviderId, string>>; timeoutMs?: number; maxRetries?: number; prices: PriceTable; }
export function createProviders(opts: ProviderFactoryOptions): Record<ProviderId, Provider>;
```

- Retry: exponential backoff (250ms base, ×2, jitter ±20%, default 3 retries) on 429/5xx/network; never retry 4xx (except 429). Timeout default 60s, AbortController.
- **Mock provider**: deterministic. Seeded by `params.seed ?? hash(prompt)`. Fixture transcripts in
  `packages/providers/src/mock/fixtures.ts`; generates text tagged `[mock:<model>]`, usage derived from
  token estimates (chars/4), latency from per-model latency profile (deterministic, e.g. haiku-class 300ms,
  frontier-class 1800ms), `logprobConfidence` deterministic in [0.5,0.99] from seed. Also mock `embed`
  → deterministic 384-dim vectors (seeded PRNG from text hash) — must be *semantically clustered*:
  fixtures embed exemplar-like texts near their cluster centroid (see §4 contract with cluster pkg).
- Cost accounting: `costOf(response, priceEntry)`; prices loader `loadPrices(path?)` with staleness
  warning when `updatedAt` > 30 days old (console.warn + return flag).
- Live providers: raw fetch to official endpoints; OpenRouter = OpenAI-compatible shape with `HTTP-Referer`.
  All live paths gated on presence of API key; constructing without key throws only on first call, not import.

## 3. packages/strategies

```ts
export interface StageTrace { stage: string; model: string; text: string; usage: Usage; confidence?: number; decision?: string; }
export interface StrategyResult { text: string; trace: StageTrace[]; usage: Usage; }
export interface ExecContext {
  providers: Record<ProviderId, Provider>; prices: PriceTable;
  resolve(model: string): { provider: Provider; entry: PriceEntry };   // alias → provider+price
  seed?: number; stream?: (token: string) => void;                     // stream only honored by 'single'
}
export function execute(strategy: StrategyConfig, messages: ChatMessage[], ctx: ExecContext): Promise<StrategyResult>;
```

Interpreters (no classes, pure functions; one file per type):
- `single`: one call; streams via ctx.stream if provided.
- `cascade`: stage 0 call → confidence (logprob if available else calibrated self-report: model asked to
  append `CONFIDENCE: 0.xx` then stripped; calibration = linear map fitted in fixtures) → escalateIf.
- `best-of-n`: n parallel calls (seeded n variants), judge picks index via rubric prompt.
- `draft-verify`: draft model answers; verifier model checks+corrects; final = verifier output.
- `ensemble`: parallel calls to all models; fusion per FusionConfig (default judge-pick).
- `decompose`: decomposer emits JSON subtasks `[{"kind": "...", "prompt": "..."}]`; each routed via
  `routing[kind]` (fallback routing['*']); fusion merges.
Cost: sum of stage costs via prices; tests must match hand-computed totals to the cent.

## 4. packages/cluster

- `taxonomy.json`: 10 seeded clusters, each `{id, name, description, exemplars: string[25+]}`.
- `ClusterAssigner`:
```ts
export interface Assignment { clusterId: ClusterId; confidence: number; }  // confidence = cosine to centroid; < threshold(0.62) → 'general'
export interface ClusterAssigner { assign(text: string): Promise<Assignment>; assignBatch(texts: string[]): Promise<Assignment[]>; }
export function createAssigner(embedder: { embed(t: string[]): Promise<number[][]> }, centroids: Map<ClusterId, number[]>, threshold?: number): ClusterAssigner;
```
- Centroid = mean of exemplar embeddings, L2-normalized. Script `build-centroids.ts` persists to db table.
- Mock embedder contract (with §2): embedding(text) = centroidVector(seedCluster(text)) + small seeded
  noise (‖noise‖ ≤ 0.15), where seedCluster is inferred by keyword matching in the mock fixtures
  (e.g. "function/python/bug"→code-gen, "extract/json"→extraction, "summarize/tl;dr"→summarization…).
  This lets Gate 2 measure real assigner logic with deterministic embeddings; accuracy target ≥85%.

## 5. packages/harness

- Suites: `suites/<clusterId>.jsonl` of EvalItem; 30–50 items per cluster for ≥ 2 gate clusters
  (code-gen, extraction), ≥ 12 items for the rest (v1 breadth, expandable).
  - M1a provenance split: the mock-corpus-derived gate suites are quarantined in
    `suites/simulated/` (TEST/CI SIMULATION ONLY; runner requires `simulatedOk`);
    authored suites carry a `// provenance:` header line (loader skips `//` lines).
- Runner:
```ts
export interface RunOptions { suiteIds: string[]; strategies: StrategyConfig[]; budgetCapUsd: number; provider?: 'mock' | 'live'; resume?: boolean; }
export interface RunSummary { runId: string; aggregates: StrategyAggregate[]; spendUsd: number; }
export function runEval(opts: RunOptions): Promise<RunSummary>;
```
- Preflight: projected spend = Σ items×strategies×estCost(item, strategy); refuse if > budgetCapUsd.
- Cache: content-addressed by EvalResult.cacheKey in `eval_results`; resume skips hits.
- Scorers: exact (normalized string), field-match (JSON parse + per-field compare, score = matched/total),
  code-exec (node `node:vm` sandbox for javascript, 2s timeout, no io), llm-judge (pinned judge from
  prices alias `judge-class`; mock judge deterministic by seed).
- Calibration mode `runJudgeCalibration(items)`: two judge models double-score 30 items → agreement
  (Pearson on 0..1 scores) report; flag < 0.8.
- CLI: `packages/harness/src/cli.ts` → `pnpm harness -- --suite code-gen --strategy ... --cap 5`.

## 6. packages/pareto

```ts
export function isDominated(p: FrontierPoint, others: FrontierPoint[]): FrontierPoint | null; // quality maximize, cost & latency minimize
export function computeFrontier(aggs: StrategyAggregate[]): FrontierPoint[];
export function diffFrontiers(from: Frontier, to: Frontier): FrontierDiff;
export function planRecompute(newModel: PriceEntry, existing: PriceTable): StrategyConfig[]; // solo + shortlist: cheap-cascade-stage, judge, draft
```
- Persistence: `saveFrontier(db, clusterId, points, trigger)` → versioned row (version = max+1, parentId chain).

## 7. packages/db & packages/queue

- db: Drizzle pg-schema for 12 tables: `clusters, cluster_exemplars, models, strategy_configs, eval_items,
  eval_runs, eval_results, frontiers, frontier_points, api_keys, policies, request_logs` (columns per
  core types; `embedding vector(384)` on cluster_exemplars; JSONB for configs). `createDb()` selects
  PGlite when `DATABASE_URL` absent/`pglite://`, else node-pg. Migration runner runs `drizzle/` SQL at boot.
  Thin typed repositories only where reused (frontiers, eval results, policies, request logs).
- queue:
```ts
export interface Queue { enqueue(name: string, payload: unknown): Promise<string>; registerHandler(name: string, fn: (payload: any) => Promise<void>): void; close(): Promise<void>; }
export function createQueue(kind: 'memory' | 'bullmq', redisUrl?: string): Queue;
```
`memory` = in-process FIFO (default in tests/dev); `bullmq` used when REDIS_URL set.

## 8. apps/server

Fastify 5. Routes:
- `POST /v1/chat/completions` — OpenAI-compatible (zod-validated subset: model, messages, stream,
  temperature, max_tokens). Auth: `Authorization: Bearer <api_key>` → policies row.
  Pipeline: assign cluster (<30ms; embedding cache keyed by sha256(first 512 chars)) → load current
  frontier for cluster → `selectPoint(policy)` → fallback if null: highest-quality point → execute via
  strategies → response with header `x-frontier-trace: cluster=<id>;strategy=<hash8>;frontier=v<n>;policy=<type>`.
  `stream:true` + single strategy → SSE; composite → 200 JSON + header `x-latency-contract: non-streamed`.
  Every request logged to `request_logs`.
- Dashboard API: `POST /api/keys`, `POST /api/workloads` (JSONL upload → cluster breakdown),
  `GET /api/frontiers/:clusterId`, `POST /api/policies`, `GET /api/endpoint-snippet`.
- Overhead budget: platform-added p95 < 80ms at 50 RPS (mock providers), measured by `test/load.ts`.

## 9. apps/dashboard

Next.js 15 App Router + Tailwind + recharts. Pages: `/` (connect keys), `/workload` (upload + cluster
breakdown), `/frontiers` (per-cluster plot: x = $/1K req, y = quality with plain-language ticks
"poor/fair/good/excellent", point size = p95 latency, dominated region shaded, "you are here" marker),
`/policy` (picker → endpoint URL + curl/openai-sdk snippet). Talks to apps/server API only.

## 10. Root files

- `docker-compose.yml`: postgres:16 + pgvector/pgvector image, redis:7; volumes; healthchecks.
- `prices.json`: `{version:"2026-08-04", updatedAt, entries:[…]}` — aliases: `haiku-class, sonnet-class,
  opus-class, gpt-mini-class, gpt-frontier-class, gemini-flash-class, gemini-pro-class, judge-class,
  frontier-class, cheap-class, mock-*` (mock entries $0). Real prices = best-known public list prices;
  staleness warning handles drift.
- `scripts/demo-mock-e2e.ts` (Gate 0), `scripts/demo-customer.ts` (DoD demo), `scripts/smoke-live.ts`.
- README.md (≤15-min quickstart), FRONTIER.md (buyer-facing).

## 11. Verification

`pnpm verify` = build + typecheck + lint + test across workspace. Gate proofs pasted into tasks/todo.md.
All tests run with zero network and zero services (PGlite + memory queue + mock provider).

## 12. M3 contracts (production-grade)

All M3 features are additive, env-gated where they add runtime deps, and default-OFF-compatible:
an M2 deployment upgrading to M3 with no config change must behave identically.

### 12.1 Provider resilience (#24) — packages/providers

```ts
export type ProviderErrorKind = 'rate_limit' | 'timeout' | 'server_5xx' | 'client_4xx' | 'network' | 'unknown';
export class ProviderError extends Error { kind: ProviderErrorKind; retryable: boolean; status?: number; provider: ProviderId; model?: string; }
export interface BreakerPolicy { failureThreshold: number; cooldownMs: number; halfOpenProbes: number; }
export interface ResiliencePolicy {
  retries: number;                 // retryable errors only; default 3
  backoff: { baseMs: number; maxMs: number; jitter: 'full' | 'none' };  // default 250/8000/full
  timeoutMs: number;               // per-attempt; default 60_000
  breaker?: BreakerPolicy;         // per (provider,model); omitted = no breaker
  hedgeAfterMs?: number;           // duplicate in-flight call after N ms, first result wins, loser aborted
}
export function resilient(p: Provider, policy?: Partial<ResiliencePolicy>): Provider;
export function failoverChain(providers: Provider[], policy?: Partial<ResiliencePolicy>): Provider; // try in order
export type BreakerState = 'closed' | 'open' | 'half-open';
export function breakerStates(): Record<string, BreakerState>;      // metrics hook
export function chaosProvider(opts: { failRate: number; kinds?: ProviderErrorKind[]; hangMs?: number; seed?: number }): Provider; // fault-injection, mock-only
```
- Classification rule: retryable = rate_limit | timeout | server_5xx | network; client_4xx (except 429) never retried.
- Breaker opens after `failureThreshold` consecutive failures, stays open `cooldownMs`, then `halfOpenProbes` successes close it.
- Hedge: AbortController cancels loser; usage/cost counted for the winner only (+`hedged: true` trace flag).
- `createProviders` output is wrapped by `resilient` with defaults — preserves §2 retry semantics (250ms base ×2 ±20% ≈ full-jitter equivalent).
- Zero plaintext key logging: errors must never include request headers.

Implementation notes (#24, additive clarifications — contract above unchanged):
- `CompleteRequest` gains optional `signal?: AbortSignal` so the wrapper can thread per-attempt timeout / hedge-loser cancellation to providers that honor it (chaosProvider does; §2 transports keep their own AbortController). `CompleteResponse` gains optional `hedged?: boolean` (the trace flag).
- The §2 `ProviderError` class is extended (not replaced): `kind`/`retryable`/`model?` added, subclasses (`ProviderAuthError`/`ProviderRateLimitError`/`ProviderTimeoutError`) preserved for `instanceof` consumers. Kind is explicit or derived from `status` (429 → rate_limit, 5xx → server_5xx, other 4xx → client_4xx).
- Breaker-open fast-rejects surface as `ProviderError` with `breakerOpen: true` (kind 'unknown', non-retryable) so `failoverChain` can distinguish them; `breakerStates()` keys are `${providerId}:${model}`.
- When `resilient`/`failoverChain` wrap a NON-ProviderError throw, the raw message is never interpolated into the new error message (it may echo request material); it is preserved on `cause` only.
- `resetBreakers()` is exported as a test hook for the module-level breaker registry.

### 12.2 Queue, workers, artifacts (#28) — packages/queue, packages/workers

> Clarification (m3-queue-workers): the artifact store ships as its own package,
> **packages/artifacts** (`@potion/artifacts`), rather than inside packages/queue.

```ts
// packages/queue — extends existing createQueue
export function createQueue(kind: 'memory' | 'bullmq', opts?: { redisUrl?: string }): PotionQueue;
// Same PotionQueue interface for both drivers. BullMQ driver: connection via redisUrl
// (default env REDIS_URL=redis://localhost:6379); jobs survive restarts; retries w/ backoff 3×.

// packages/workers
export type JobKind = 'eval:run' | 'sweep:run' | 'staleness:scan' | 'shadow:judge';
export interface JobPayloads { /* eval:run = {suiteIds, strategyHashes, capUsd?}; sweep:run = {suiteIds[], strategies[], capUsd}; staleness:scan = {}; shadow:judge = {shadowResultId} */ }
export function runWorker(opts: { queue: PotionQueue; db: Db; handlers?: Partial<Record<JobKind, Handler>> }): Promise<WorkerHandle>;
// apps/server gains: POST /api/evals → { jobId } (enqueue, 202); GET /api/jobs/:id → { state, progress, result? }
export interface ArtifactStore { put(key: string, body: Buffer | NodeJS.ReadableStream): Promise<void>; getUrl(key: string): Promise<string>; exists(key: string): Promise<boolean>; }
export function createArtifactStore(kind: 'local' | 's3', opts?: { dir?: string; bucket?: string; prefix?: string; endpoint?: string }): ArtifactStore;
// local → dir (default ./artifacts); s3 → S3-compatible (MinIO ok), env S3_ENDPOINT/S3_BUCKET/S3_ACCESS_KEY/S3_SECRET_KEY.
```
- BullMQ tests use an in-process Redis stub (ioredis-mock) — hermetic, no container required.
- docker-compose gains `minio` (+ `minio-mc` bucket init) and `redis` already present.
- Harness/sweep artifacts (JSON) written through ArtifactStore when configured; local default keeps M2 behavior.

### 12.3 Observability (#26) — packages/observability

```ts
export interface ObservabilityOptions { serviceName: string; otlpEndpoint?: string; metrics?: boolean; }
export function initObservability(opts: ObservabilityOptions): ObservabilityHandle; // no-op unless otlpEndpoint or metrics
export interface ObservabilityHandle { shutdown(): Promise<void>; meter: Metrics; }
export interface Metrics {
  incRequest(route: string, status: number, durationMs: number): void;
  observeProviderCall(p: { provider: string; model: string; durationMs: number; costUsd: number; error?: string }): void;
  observeFrontierDecision(d: { clusterId: string; strategyHash: string; fallback: boolean; provenance: string }): void;
  setBreakerState(key: string, state: BreakerState): void;
  observeShadow?(s: { clusterId: string; sampled: boolean }): void;   // #21
}
```
- Fastify plugin `observabilityPlugin` wires request counters + GET /metrics (Prometheus text) when `metrics:true`.
- pino structured logging with `x-request-id` correlation (honors inbound header, else uuid); provider calls log model+duration+cost, never payloads/keys.
- OTel: `@opentelemetry/sdk-node` lazy-imported only when `otlpEndpoint` set — dependency is optional.

### 12.4 Shadow mode + savings report (#21) — apps/server, packages/db, apps/dashboard

```ts
// Policy gains optional shadow config (core type extension, backward-compatible):
export interface ShadowConfig { sampleRate: number; candidates: 'frontier' | string[] } // string[] = strategyHashes
// Serving: primary response path UNCHANGED. When sampled (sampleRate, per-request):
// after response sent, each candidate strategy executes async via resilient providers;
// ALL shadow errors swallowed (logged + metric only). Shadow never affects latency SLO of primary.
// Migration 0007_shadow: shadow_results(id, org_id, request_id, cluster_id, primary_hash, candidate_hash,
//   candidate_model, quality, cost_usd, latency_ms, created_at) + indexes (org_id, created_at).
export interface SavingsReport {
  orgId: string; from: string; to: string;
  actualSpendUsd: number;
  alternatives: Array<{ strategyHash: string; label: string; projectedSpendUsd: number; projectedQuality: number; deltaUsd: number; sampleSize: number; confidence: 'low' | 'medium' | 'high' }>;
}
// GET /api/reports/savings?from&to → SavingsReport (org-scoped). confidence: low <30, medium <200, high ≥200 samples.
```
- Dashboard `/reports` page: actual vs projected spend chart, per-alternative table, CSV export.
- Shadow quality: mock = deterministic scorer; live = `shadow:judge` job via queue (#28) when available, else in-process scorer.

### 12.5 Quality guarantee + auto-rollback (#22) — apps/server, packages/db

```ts
export interface GuaranteeConfig { minQuality: number; windowMin: number; sampleRate: number; action: 'rollback' | 'alert' }
// Policy gains optional `guarantee`. Migration 0008_guarantee:
//   quality_samples(id, org_id, request_id, strategy_hash, quality, created_at)
//   incidents(id, org_id, kind: 'quality_breach' | 'rollback', detail jsonb, created_at, resolved_at)
// Rolling window quality per strategy; breach → action:
//   rollback: operating point moves to previous frontier version (or next-higher-quality point);
//   alert: incident only. Both emit webhook-ready incident row + metric.
// GET /api/guarantee/status → per-policy rolling quality + breaches. Dashboard badge on /frontiers.
```

### 12.6 Composite streaming (#23) — packages/strategies

```ts
// 7th StrategyConfig member:
| { type: 'composite'; startModel: string; upgradeModel: string; upgradeIf: { confidenceBelow: number }; }
```
- Execution: start streaming from startModel; at first token-batch confidence < threshold, restart from upgradeModel WITH the already-generated prefix in the prompt; final text = coherent continuation.
- `strategyHash` covers it via canonical JSON (no special-casing). Zod schema extended.
- SSE relay in server emits standard OpenAI chunks; upgrade boundary is transparent to the client (single stream), recorded in x-frontier-trace (`upgraded=1`).

### 12.7 OpenAI parity (#25) — apps/server

- `GET /v1/models` → aliases + `potion-auto` in OpenAI list shape.
- `POST /v1/embeddings` → `{ model, input }` → OpenAI response shape via resolveEmbedder (§4).
- `POST /v1/completions` (legacy) → prompt→messages shim.
- Chat: tool/function calling passthrough (`tools`, `tool_choice` forwarded unmodified; response `tool_calls` preserved); streaming chunks include `usage` when `stream_options.include_usage`.
- Errors: OpenAI JSON shape `{ error: { message, type, param, code } }` with matching HTTP codes (401/429/500/503).
- Contract tests: recorded-fixture comparisons (mock fetch), no live calls.

### 12.8 HA (#27) — apps/server, deploy

- Graceful shutdown: SIGTERM → stop accepting, drain in-flight (30s cap), close queue/db, exit 0.
- `/healthz` (process up) vs `/readyz` (db ping + queue ping + breaker summary); load-balancer ready.
- pg pool: `max`, `idleTimeoutMillis`, `connectionTimeoutMillis` env-tunable; transient-error retry on connect.
- Cross-instance invalidation of `providersForOrg` cache via redis pub/sub channel `potion:invalidate:keys` (memory fallback = 60s TTL only).
- docker-compose.ha.yml: 2× server replicas behind nginx round-robin + shared postgres/redis; docs/HA.md.

### 12.9 CI/CD + chaos (#29) — .github/workflows, tests/chaos

- ci.yml: pnpm install → build → typecheck → lint → test → audit-gate → SBOM artifact (CycloneDX) on every PR/push.
- deploy.yml: skeleton (build image → push → deploy step placeholder w/ environment secrets).
- tests/chaos: db killed mid-eval → run fails clean + no partial rows; redis down → bullmq enqueue surfaces typed error, memory fallback documented; instance kill during shadow → primary response unaffected.
- Folds in: dependency bumps clearing the 16 allowlisted high+ advisories (next, drizzle-orm) — audit allowlist must shrink to zero or re-justify; adversarial tenant-isolation tests (forged org headers, cross-org id enumeration, cookie tampering).

## 13. M4 contracts (wildfire)

### 13.1 Per-request policy override (#30 enabler) — apps/server
- `POST /v1/chat/completions` accepts header `X-Potion-Policy: <policyId | policyName>`; resolved within the caller's org (404-shaped OpenAI error `invalid_request_error/policy_not_found` when unknown; the API key's bound policy remains the default).
- The resolution is recorded in request_logs (policy_id column exists) and echoed in x-frontier-trace (`policy=<name>`).

### 13.2 SDKs (#30) — sdks/python + sdks/typescript (NOT pnpm packages; own packaging)
- Thin wrappers over the official `openai` clients: `Potion(base_url, api_key, default_policy?)`.
- Per-request `policy=` kwarg → sends X-Potion-Policy. Responses expose `.frontier_trace` (parsed x-frontier-trace) and `.cost` (usage.cost when present).
- Python: pyproject (hatchling), supports openai>=1. TS: tsup build, openai>=4. Both: 3-file surface (client, types, errors) + README quickstart; tests via mock HTTP server (no live calls).

### 13.3 Playground + share links (#31) — apps/dashboard, apps/server
- `/playground`: pick cluster → pick any frontier point (or potion-auto policy) → chat with SSE streaming; side-by-side compare of two points (latency/cost/answer); mock banner when provenance≠live.
- Share links: `POST /api/share` { kind: 'frontier' | 'report', clusterId?, windowDays? } → signed token (sha256, table share_tokens(id, org_id, kind, payload jsonb, token_hash, created_at, revoked_at)); public routes `/share/f/:token` and `/share/r/:token` render read-only SSR (no session required; no org-identifying data beyond what the payload carries — name redaction option).
- Migration 0009_share.

### 13.4 Public leaderboard (#32) — apps/server, apps/dashboard
- `GET /api/leaderboard` → per seeded cluster: best live-provenance frontier points (quality ≥ threshold), each with strategy label, cost/1K, quality, verification run id. LIVE-provenance only; when none exist (pre-M1b), response carries `status: 'awaiting_live_verification'` and the page renders an honest empty state (no mock data presented as live — ever).
- `/leaderboard` public page (no session) + opt-in org publishing toggle (org setting publish_to_leaderboard, default off).

### 13.5 Alerts & integrations (#33) — apps/server, packages/workers
- alert_rules(id, org_id, kind: 'webhook' | 'slack', target_url, events text[], created_at) — events: quality_breach, rollback, budget_warning, budget_exceeded, breaker_open.
- Dispatcher: `alerts:dispatch` JobKind in workers — on incident creation (any source), enqueue matching rules; POST JSON {event, org_id, detail, ts} (Slack-compatible {text} when kind=slack); 3 attempts, results logged (never the target_url with secrets — redact query strings).
- Migration 0010_alerts. Test endpoints: POST /api/alerts/test (sends to a caller-supplied URL, admin only).

### 13.6 Enterprise: SSO + audit export (#34) — apps/server
- SSO: env-configured OIDC (POTION_OIDC_ISSUER/CLIENT_ID/CLIENT_SECRET) — authorization-code flow against the dashboard; when unset, magic-link remains. SAML deferred (document why: OIDC covers the IdPs that matter first; contract keeps /auth/saml/* reserved).
- Audit export: GET /api/audit/export.jsonl?from&to (admin) → unified stream of custody_audit + auth events + incidents + key lifecycle, JSONL, org-scoped. SCIM deferred (reserved /scim/*).

### 13.7 Budget autopilot (#35) — apps/server, packages/db
- budgets(org_id pk, monthly_cap_usd, hard_stop boolean default false, warn_pct int default 80, updated_at) — migration 0011_budgets.
- Serving-path check: before execution, if hard_stop and MTD spend ≥ cap → 429 OpenAI-shaped `{error:{type:'budget_exceeded',...}}` (fail-closed; cached 60s per org).
- Anomaly detection: nightly worker job `budget:evaluate` — z-score of last-7-day daily spend vs trailing 30-day; |z|>2.5 → alert event budget_warning; MTD forecast (linear extrapolation) > cap → budget_warning at warn_pct crossing → budget_exceeded at cap.
- GET/PUT /api/budgets (admin); dashboard /reports shows cap line + forecast.

## 14. M5 contract (agent workloads, #36)

### 14.1 Trace ingestion — apps/server, packages/db
- `POST /v1/traces` (org-scoped, batch): spans in OTel GenAI convention subset {trace_id, span_id, parent_id, name, model?, input_tokens?, output_tokens?, attributes.gen_ai.*}; stored trace_spans(id, org_id, trace_id, span_id, parent_id, name, model, usage jsonb, cost_usd, attrs jsonb, ts). Idempotent on (org_id, trace_id, span_id).
- Per-trace rollup: GET /api/traces?from&to → sessions with total cost, span count, models used, loop-detection (repeated identical tool-call signatures).

### 14.2 Agent clustering + frontier — packages/cluster, packages/pareto
- Cluster agent sessions by: first-user-message embedding (existing embedder) + tool-call graph signature (hash of ordered tool-name sequence); cluster id `agent-<slug>`; feeds the SAME frontier pipeline (eval items synthesized from session replays: redact payloads, keep structure).
- Serving: agent workloads route through the same /v1/chat/completions with cluster hint `X-Potion-Cluster: agent-*` (documented, optional).
- Dashboard /traces: session list, per-trace cost attribution waterfall, cluster frontiers for agent clusters.

### 14.3 Discipline
- Trace payloads may contain customer data: storage honors a per-org `trace_retention_days` (default 30, 0 = metadata only) enforced by a nightly purge job.

## 15. Autoresearcher contract (#37 + #32 public face)

The researcher is PLATFORM-level: it discovers recipes against shared suites and publishes
frontier versions all orgs inherit. (Per-org private research = follow-up.)

### 15.1 Candidate generation — packages/researcher (new)

```ts
export interface ModelRegistryEntry { alias: string; provider: ProviderId; cls: 'cheap' | 'mid' | 'strong' | 'judge'; inputPer1M: number; outputPer1M: number; }
export type RecipeStatus = 'candidate' | 'frontier' | 'archived';
export interface GenerateOptions { registry: ModelRegistryEntry[]; focusAlias?: string; existingHashes: Set<string>; budget?: number; seed?: number; }
export function generateCandidates(opts: GenerateOptions): StrategyConfig[]; // deterministic w/ seed
```
- Templates (focus = the new model; defaults in parens): single(focus) · cascade with focus slotted into each class-compatible stage · composite (start=focus, upgrade=strong) + (start=cheap, upgrade=focus) · draft-verify (draft=focus, cheap/mid only; verifier=strong) · best-of-n(focus, n=3, judge=judge-class) · ensemble(focus + 2 cross-provider peers). decompose OFF by default (`includeDecompose: true` to enable — prompt-sensitive).
- Pruning: dedupe vs existingHashes AND vs eval-cache cells (already-evaluated (suite, modelVersions, hash) skipped); per-cycle budget default 20 candidates, focus-first ordering.

### 15.2 New-model detection — workers job `research:scan`
- Poll provider model lists (OpenRouter GET /models, raw fetch; mock provider exposes `models()` fixture for tests) → diff vs prices.json registry → append new entries as `candidate` state with provider-reported pricing when present.
- OpenRouter shape: `data[].{id, canonical_slug, created, pricing.{prompt,completion}, supported_parameters}` — pricing values are USD **per-token strings**; prices.json stores per-1M numbers, so scan converts `× 1e6` (parse as Number, never string-concat). `created` (unix ts) feeds "new since last scan" diffing; `supported_parameters` (e.g. `tools`) feeds candidate-generation capability filters.
- On additions → enqueue `research:cycle { focusAlias }` per new alias (cap 3 per scan). Triggers: nightly schedule + `POST /api/research/scan` (admin) + operator script.

### 15.3 Research cycle — workers job `research:cycle { focusAlias?, suiteIds?, capUsd? }`
- generateCandidates → sweep:run machinery over the standard v2 suite set → results into the SAME content-addressed eval cache (compounding).
- Budget-capped: default $5.00 live per cycle / uncapped mock; spend ledgered like M1b; graceful stop at cap.
- Mock cycles produce provenance=mock evidence → recipes enter `candidate` state (SIMULATED-badged); they can SHORTLIST, never PROMOTE.

### 15.4 Promotion gate — packages/researcher + packages/pareto
- Post-cycle: recompute cluster frontiers including new candidates. Publish a new frontier version (parentId = current) ONLY from live-provenance evidence AND when heldout shows: quality delta ≥ +1.5 pts at ≤ same cost, OR ≥ 20% cost cut at ≥ same quality (thresholds env-tunable). Significance method (pinned): **paired bootstrap over per-item heldout deltas** (new recipe vs incumbent operating point, same items), 1000 resamples with replacement, 95% CI on the mean delta, seeded PRNG (mulberry32, seed recorded on the cycle row) — promote only when the CI lower bound clears the threshold; CI overlapping it → stays `candidate`.
- Promotion is a frontier version — #22 auto-rollback applies unchanged. Events → alerts (#33).

### 15.5 Recipe library + leaderboard (#32) — apps/server, apps/dashboard
- `GET /api/recipes?cluster&status` → every strategy config + eval lineage (suite versions × model versions × provenance × cycle ids × dates). `POST /api/recipes/:hash/evaluate` (admin) → enqueue cycle for that recipe.
- `/recipes` dashboard: table (status badge candidate|frontier|archived, SIMULATED/LIVE provenance), lineage drawer, evaluate button.
- `GET /api/leaderboard` + public `/leaderboard` page per §13.4 — the PUBLIC FACE of the library: live-provenance frontier recipes per cluster; honest `awaiting_live_verification` empty state pre-M1b; org opt-in via publish_to_leaderboard (from #34).

### 15.6 Migration 0014_research
_(renumbered from 0013: request_logs_policy took 0013 in M4 #30)_

`research_cycles(id uuid pk, trigger text check (trigger in ('scan','manual','schedule')), focus_alias text, candidates jsonb not null default '[]', status text not null default 'queued', spend_usd double precision not null default 0, provenance text not null default 'unknown', created_at timestamptz default now(), completed_at timestamptz)` + `recipe_status(strategy_hash text pk, status text not null default 'candidate', first_cycle_id uuid, updated_at timestamptz default now())`.

### 15.7 Discipline
- End-to-end mock determinism (seeded) is mandatory; live only via operator runbook or admin-triggered cycles with ledger accounting. The $50 M1b cap and research-cycle caps are separate ledgers — document both in tasks/todo.md.
