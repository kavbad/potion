# tasks/todo.md — Potion (FRONTIER) MVP — Master Plan & Progress Log

> Rules in force (from BUILD PROMPT §7): plan first · one task per subagent · no checkbox without
> gate proof · stop & re-plan after 2 gate failures · elegance check on non-trivial changes ·
> lessons loop in `tasks/lessons.md` · zero live API spend outside budget-capped harness runs ·
> simplicity first (every dependency justified in its commit/PR note).

## Environment note (recorded 2026-08-04)
Sandbox has Node 20 + pnpm 9, but no Docker/Postgres/Redis and no live provider keys. Decisions:
- DB access goes through Drizzle with **two drivers from one schema**: PGlite (embedded Postgres,
  pgvector-enabled) for tests/dev/sandbox; real Postgres 16 via `docker-compose.yml` for local runs.
- Queue has **two drivers behind one interface**: BullMQ+Redis (local/prod) and in-process (tests/dev).
- **All gate proofs in this build run on the deterministic seeded mock provider** (same strategy/harness
  code paths, mock transport). Live-key scripts ship ready (`pnpm smoke:live`, capped) but stay
  unexecuted until keys exist — spend so far: **$0.00**.

---

## Phase 0 — Skeleton & Contracts
- [x] 0.1 pnpm workspace scaffold: `packages/{core,providers,strategies,cluster,harness,pareto,db,queue}`, `apps/{server,dashboard}`, root configs (tsconfig base, eslint, vitest)
      _(Phase 0 remainder shipped: providers/strategies/cluster/db/queue + root configs; harness/pareto/apps land in their phases)_
- [x] 0.2 CI script: typecheck + lint + test runnable via `pnpm verify` (GitHub Actions yaml included)
- [x] 0.3 `packages/core` types — **the contract, reviewed before anything consumes them**:
      `TaskCluster`, `StrategyConfig` (discriminated union over 6 types), `EvalResult`, `FrontierPoint`,
      `Frontier`, `Policy`, `ModelRef`, `Usage`, `PriceTable`
- [x] 0.4 Drizzle schema baseline for the 12 tables (§6 of build prompt) + migration runner (PGlite + node-pg)
- [x] 0.5 Mock provider: deterministic seeded responses (content, confidence/logprobs, usage, latency) from a fixture transcript
- [x] **GATE 0**: `pnpm test` green in every package; `pnpm demo:mock-e2e` runs a fake request through
      cluster → strategy → mock provider → response and prints a trace. _Proof: paste below._
- [x] Gate 0 proof recorded

## Phase 1 — Providers & Strategy Library
- [x] 1.1 `packages/providers`: `complete(model, messages, params) -> {text, usage, latencyMs}` for
      Anthropic, OpenAI, Google, OpenRouter via raw fetch; retry (exp backoff, jitter), timeout, typed errors
- [x] 1.2 `prices.json` (versioned price table) + cost accounting + staleness warning (>30 days)
- [x] 1.3 `packages/strategies`: interpreters over declarative configs — single, cascade, best-of-N+judge,
      draft-verify, ensemble+fusion, decompose-and-route
- [x] 1.4 Escalation confidence: logprob-based + calibrated self-report, both tested against mock
- [x] **GATE 1**: all 6 strategies execute against mock with seeded transcript; cost accounting matches
      hand-computed totals to the cent; live smoke scripts present (run deferred — no keys). _Proof below._
- [x] Gate 1 proof recorded

## Phase 2 — Task Clustering
- [x] 2.1 Seed taxonomy: 10 clusters × 25+ exemplars (authored by subagent, reviewed by second subagent)
- [x] 2.2 Embedding: provider-agnostic embedder with mock embedder for tests; exemplar centroids in pgvector (PGlite in sandbox)
- [x] 2.3 Assignment: nearest centroid + confidence threshold → fallback `general` cluster
- [x] 2.4 Held-out labeled set: 200 prompts (20/cluster), generator/reviewer agent pair
- [x] **GATE 2**: assignment accuracy ≥ 85% on held-out set; confusion matrix pasted below. _Proof below._
- [x] Gate 2 proof recorded

## Phase 3 — Eval Harness
- [x] 3.1 Benchmark suites: 30–50 items for each of the 10 clusters (public-benchmark-derived where license
      allows, else authored by generator/reviewer pairs); item = prompt + reference/rubric + scoring method
- [x] 3.2 Scorers: exact/functional (sandboxed code-exec runner for code-gen, field-match for extraction),
      LLM-judge (pinned judge model + rubric; mock judge in tests)
- [x] 3.3 Judge calibration: 30 items double-scored by second judge; agreement report; flag < 0.8
- [x] 3.4 Runner: resumable, content-addressed cache (strategy-config hash + item id), budget cap
      (refuses runs whose projected spend > cap)
- [x] **GATE 3**: full eval of 3 single-model baselines + 3 composite strategies on 2 clusters —
      executed on mock provider (zero spend; live rerun script `pnpm eval:live --cap 25` ships ready);
      results table: quality mean ± CI, cost/request, p50/p95 latency. _Proof below._
- [x] Gate 3 proof recorded

## Phase 4 — Pareto Engine
- [x] 4.1 Non-dominated set per cluster in (quality, cost, latency); versioned `frontiers` + `frontier_points` rows
- [x] 4.2 Frontier diffing: appeared / vanished / dominated-by narrative between two versions
- [x] 4.3 Recompute job: new model in prices.json → enqueue solo + shortlist combos (cheap cascade stage,
      judge, draft) → recompute affected frontiers (queue-driver based)
- [x] **GATE 4**: with Phase 3 results + one deliberately dominated strategy, engine excludes dominated
      point; diff correctly narrates a simulated "new model release" on mock data. _Proof below._
- [x] Gate 4 proof recorded

## Phase 5 — Serving Layer
- [x] 5.1 Fastify `/v1/chat/completions` (OpenAI-compatible, zod-validated); single-model strategies stream;
      composite strategies non-streamed with documented latency contract
- [x] 5.2 Real-time clustering < 30ms (embedding cached by prompt-prefix hash)
- [x] 5.3 Policies `max_quality(costCeiling)`, `min_cost(qualityFloor)`, `latency_bound(p95Ms)` — typed,
      validated, stored per API key
- [x] 5.4 `x-frontier-trace` response header (cluster, strategy id, frontier version)
- [x] **GATE 5**: load test 50 RPS vs mock providers — platform p95 overhead < 80ms; demo one request per
      policy type with trace header explained. _Proof below._
- [x] Gate 5 proof recorded

## Phase 6 — Dashboard
- [x] 6.1 Next.js 15 app in `apps/dashboard`: (1) connect keys, (2) upload JSONL workload → cluster breakdown,
      (3) per-cluster frontier plot (quality vs cost, latency = point size, dominated region shaded,
      "you are here"), (4) policy picker → endpoint + code snippet
- [x] 6.2 Money-shot legibility: axes in dollars + plain-language quality; readable by non-technical buyer in 5s
- [x] **GATE 6**: cold-start walkthrough (new user → sample workload → endpoint serving a chosen frontier
      point) < 5 minutes, steps recorded below. _Proof below._
- [x] Gate 6 proof recorded

## Definition of Done
- [x] All six gates passed with proof recorded in this file
- [x] Customer-shaped demo: one continuous run — workload in → clustered → frontier → policy → endpoint answering with trace header
      _(`scripts/demo-customer.ts` via `pnpm demo:customer`, branch `dod-finale`: boot on fresh PGlite
      auto-seed → sample workload upload (40 prompts, 6 clusters, avg conf 0.987) → code-gen +
      extraction frontier tables → max_quality($2/1K) policy + fresh key → 3 traced chats
      (code-gen/extraction fallback=0, general fallback=1) → mock-new-x recompute: code-gen v1→v2,
      best-of-n(mock-new-x×3) dominates single(frontier-class) "cheaper and higher quality", serving
      re-request traced frontier=v2. Exit 0.)_
- [x] README.md: new engineer runs full stack locally (docker-compose Postgres/Redis) < 15 min
      _(root `README.md`: prerequisites, zero-services Quickstart A (`pnpm install && pnpm verify &&
      pnpm demo:customer`), full-local Quickstart B (`docker compose up -d`, DATABASE_URL/REDIS_URL,
      `pnpm dev` API :3000 + dashboard :3001, optional live keys → `pnpm smoke:live`), ascii
      architecture map, six-gate story, verification commands, spend note)_
- [x] FRONTIER.md: buyer-facing explanation of frontier computation/versioning/new-model movement
      _(root `FRONTIER.md`, ~1 page, no jargon: frontier of combinations vs one-model routers,
      benchmark → non-dominated set → versioning, Gate-4 narrative (best-of-n(mock-new-x×3)
      dominates single(frontier-class), cheaper AND higher quality), chart legibility, 3 policies
      in one line each)_
- [x] Spend ledger: live spend $0.00 (mock-only build); live scripts capped and unexecuted

---

## Gate Proofs

**GATE 0 ✅ (2026-08-04, commit c8e64f5)** — 6 packages, 50 tests green; `demo:mock-e2e` trace printed
(cluster code-gen conf 0.9945, single→mock-frontier, stream 21 chunks reassembled == final). Independently
re-verified by orchestrator on merged main.

**GATE 1 ✅ (commits 02c8025 + 5914f00)** — all 6 strategies execute on mock with seeded transcripts
(cascade escalation + decompose routing samples recorded); cost accounting matches hand-computed total to
the cent (cascade $0.002646 verified); 4 live transports + retry wrapper (13 stubbed-fetch tests: 429/5xx
retry w/ exact backoff, no-retry on 400/401, timeout abort); live smoke = dry-run only (no keys, $0 spend).

**GATE 2 ✅ (commits 3d58889 + f156f31, audit fix 2026-08-04)** — 10×26+ taxonomy + 200-item held-out set
(generator + independent reviewer: 0 wrong labels, 3 near-dup pairs found & replaced); assignment accuracy
**89.00% ≥ 85%** re-run post-fix; confusion matrix printed by `pnpm --filter @potion/cluster evaluate`
(near-diagonal; classification recall lowest at .65, code-gen↔code-review absorbs most errors).

**GATE 3 ✅ (commit 9915251)** — 3 single-model baselines + 3 composites × code-gen & extraction suites,
360 executions, mock spend $0 under exercised $25 cap. Quality ordering confirmed thesis: code-gen cheap
0.628 < mid 0.744 < draft-verify 0.794 < cascade 0.817 < best-of-3 0.878 < frontier 0.900 (±CI95 reported);
extraction similar (0.913→0.992). Judge calibration Pearson **0.996** (30 double-scored). Cap refusal
demonstrated ($0.001 cap → REFUSED before execution, exit 2).

**GATE 4 ✅ (commit cbed8db)** — deliberately dominated ensemble(cheap×3 concat) excluded (0.000 quality);
simulated new-model release `mock-new-x` → runRecompute → frontier v1→v2 diff: 4 appeared, 1 vanished,
single(frontier-class) dominated by best-of-n(mock-new-x×3) "cheaper and higher quality" — full buyer-readable
narrative printed. 30 pareto tests (dominance/persistence/diff/recompute e2e on PGlite+memory queue).

**GATE 5 ✅ (2026-08-04, branch `phase5-server`, commit 76b721e)** — `apps/server` (@potion/server,
Fastify 5): `buildServer()` boots PGlite + migrate → taxonomy centroids (mock embedder default; OpenAI
embed when `OPENAI_API_KEY` set) → demo seed when empty (key `pk_demo_3f1a…`, 3 policies one-per-type,
code-gen + extraction frontiers computed for real via harness+pareto on mock, capped at 4 strategies/$5,
$0.23 mock-priced spend) — zero network/services. Routes: `POST /v1/chat/completions` (zod-validated
subset; bearer → api_keys → policy; assign cache keyed by sha256(first 512 chars of user content) →
loadCurrentFrontier → selectPoint → NULL fallback to highest-quality point; SSE for `single`,
`x-latency-contract: non-streamed` JSON for composites; `x-frontier-trace:
cluster=<id>;strategy=<hash8>;frontier=v<n>;policy=<type>;fallback=<0|1>`; every request logged to
request_logs), GET/POST `/v1/policies` (PolicySchema-validated, stored per key), dashboard API
(POST /api/keys masked-only storage via additive migration 0001_provider_keys, POST /api/workloads JSONL
→ assignBatch breakdown, GET /api/frontiers/:clusterId incl. operating point, POST /api/policies,
GET /api/endpoint-snippet). Workspace `pnpm build && pnpm typecheck && pnpm lint && pnpm test` green:
**222 tests** (192 prior + 30 server). Load test (`pnpm --filter @potion/server loadtest`; hand-rolled
open-loop fetch — no extra dep, exact pacing, in-process assign timing): 500/500 @ 50.1 RPS all 200;
platform overhead p50=**6.44ms** p95=**9.66ms < 80ms** (overhead = client wall − model time; mock model
time ≈ 0 — the mock performs no sleep, its latencyMs is a synthetic profile; derivation printed by the
test); cluster assign p95=**0.26ms < 30ms**. Demo (curl vs seeded server): max_quality($1.0/1K) →
cascade `bb89ffe8` (best quality ≤ ceiling); min_cost(0.9) → single(frontier-class) `3d91ec22` (cheapest
≥ 0.9); latency_bound(1000ms) → single(gpt-mini-class) `00bf5e29` streamed over SSE (only point with
p95 ≤ 1000ms) — all `frontier=v1`, `fallback=0`.

Spend ledger: **$0.00** live (mock-only; live scripts ship ready, capped).

---

## M1b Live Spend Ledger (cap: $50.00 — confirmed by operator 2026-08-04)
Key custody: OPENROUTER_API_KEY stored in gitignored root `.env` (chmod 600), supplied by operator
(spend-limited to $50 at the provider dashboard). Hard ceiling: $50.00 total for M1b
($25 Gate-3 live rerun + $15 ten-cluster frontier sweeps + $10 headroom). No live call outside
budget-capped harness runs. Revoke key when M1b completes.

| date | run | projected | actual | cumulative |
|---|---|---|---|---|
| 2026-08-04 | key received, no runs yet | — | $0.00 | $0.00 / $50.00 |
| 2026-08-04 | openrouter region probes (curl ×3, max_tokens 1) | — | $0.000009 | $0.000009 / $50.00 |
| 2026-08-04 | openrouter smoke (or-gpt-mini + or-gemini-flash region-blocked 403 → or-deepseek fallback ✓, 6in/1out) | $0.000062 | $0.00000245 | $0.00001146 / $50.00 |
| 2026-08-06 | Gate-3 first attempt (killed by sandbox exec limit; in-memory db, results lost) | $0.3081 | ~$0.08 | ~$0.08 / $50.00 |
| 2026-08-06 | Gate-3 live rerun `run-d9fb94ab` (chunked --resume, persistent pglite) | $0.3081 | $0.2927 | $0.379 / $50.00 |
| 2026-08-06 | sonnet fence repro (1 direct call, diagnosis of code-gen 0.000) | — | ~$0.01 | ~$0.39 / $50.00 |
| 2026-08-06 | Gate-3 fence-fix rerun `run-b03963c3` (12 re-executions, 240 cache hits) | $0.3081 | ~$0.12 | ~$0.51 / $50.00 |
| 2026-08-06 | ten-cluster frontier sweep (8 suites × 6 strategies, chunked --resume) | $1.4442 | $3.3730 | $3.879 / $50.00 |

M1b-prep outcome (2026-08-04, branch `m1b-openrouter`): OpenRouter single-key live path PROVEN end-to-end
(real completion, real usage, exit 0). Two findings of consequence: (1) the Phase-1 transport URL was
missing the `/api` prefix — `https://openrouter.ai/v1/chat/completions` returns HTTP 404; fixed to
`https://openrouter.ai/api/v1/chat/completions`. (2) ALL six mission models (OpenAI/Anthropic/Google
families via OpenRouter) return "This model is not available in your region" (HTTP 403) from this
sandbox's egress region; `or-deepseek` (deepseek/deepseek-chat-v3.1, SiliconFlow upstream) was added to
prices.json as the documented last-resort fallback and is what the smoke actually ran on. Live smoke in
a non-blocked region will use `or-gpt-mini` as designed (it is tried first, cheapest-first). Authoritative
cumulative per GET /api/v1/key: $0.00001146 used, $49.99998854 remaining of the $50.00 cap.

### GATE 0 — 2026-08-04 — branch `phase0` ✅

`pnpm install && pnpm build && pnpm test` — green across all 6 packages
(queue 5, core 10, providers 13, db 6, cluster 6, strategies 10 = **50 tests, 0 failed**);
`pnpm verify` (build + typecheck + lint + test) exit 0.

`pnpm demo:mock-e2e` output:

```
── Potion Gate 0: mock end-to-end ──────────────────────────────
prompt        : Write a Python function that checks whether a string is a palindrome
prices        : v2026-08-04 (14 aliases)
cluster       : code-gen (confidence 0.9945)
────────────────────────────────────────────────────────────────
strategy      : single → mock-frontier
stage usage   : 30 in / 40 out tokens
cost          : $0.000000 (mock pricing)
latency       : 1800 ms (mock frontier profile)
confidence    : 0.9601 (mock logprob)
stream        : 21 chunks, reassembled === final text: true
────────────────────────────────────────────────────────────────
response      : [mock:mock-frontier] however a summary value however result case complete check the example summary table correct finally clear analysis note table analysis.
── Gate 0 demo OK ──────────────────────────────────────────────
```

Notes: live provider stubs throw "no API key" on first call (import safe); bullmq driver
is a TODO stub; strategies other than `single` throw "not implemented (Phase 1)";
cluster ships a 3×3 taxonomy stub (full 10×25 taxonomy is Phase 2).

### Gate 6 — Dashboard (phase6-dashboard)

`pnpm verify` (build incl. `next build` + typecheck + lint + test) exit 0 — 233 tests
(222 baseline + 11 new `apps/dashboard/test/frontier-chart.test.ts` money-shot mapping
tests: quality-word ticks, $ formatting, latency→radius scaling, dominated-region rects,
x-domain). ESLint clean.

`pnpm --filter @potion/dashboard walkthrough` (boots API on fresh in-memory PGlite →
auto-seed, boots `next start`, drives the new-user flow through the dashboard proxies):

```
── Potion Gate 6: dashboard cold-start walkthrough ──────────────
repo: /home/kimi/app-p6
api : http://localhost:3100   dashboard: http://localhost:3101
PASS  boot api server (fresh PGlite → auto-seed)  (5.2s) — healthz ok, seeded=true
PASS  boot dashboard (next start, production build)  (0.9s)
PASS  1. POST /api/keys (connect provider key)  (0.1s) — stored as sk-…0001, list shows 1 key(s)
PASS  2. POST /api/workloads (sample workload.jsonl)  (0.1s) — 40 prompts → 6 clusters: {"code-gen":7,"code-review":6,"extraction":7,"summarization":7,"classification":7,"creative":6}
PASS  3. GET /api/frontiers/code-gen (points exist)  (0.0s) — v1, 3 points, operatingPoint=yes; clusters: code-gen, extraction
PASS  4. POST /api/policies (max_quality, $2 ceiling)  (0.0s) — policy pol-4a41de34, key pk_60cab79…
PASS  5. POST /v1/chat/completions (200 + x-frontier-trace)  (0.0s) — trace: cluster=code-gen;strategy=bb89ffe8;frontier=v1;policy=max_quality;fallback=0
PASS  6. GET /frontiers (page HTML renders chart)  (0.1s) — 24KB html, 4 <circle> nodes, caption + ticks + marker present
────────────────────────────────────────────────────────────────
── Gate 6 walkthrough OK — total 6.4s (budget 5 min) ──
```

SSR chart evidence from `curl localhost:3101/frontiers?cluster=code-gen` (seeded data):
y ticks `<tspan>poor|fair|good|very good|excellent</tspan>`, x ticks `$0/$0.75/$1.5/$2.86`,
step path `d="M140.1,127.7L262.8,127.7L262.8,72.5L660.2,72.5L660.2,66.6"` (right-angle
steps), 3 frontier circles r=5.75/11/9.5 (radius ∝ p95 latency) + ink ReferenceDot ring
r=11 ("You are here"), 3 shaded dominated-region ReferenceAreas, caption "Only points on
the line are worth paying for".

Notes: additive server tweaks confined to `apps/server/src/routes/dashboard.ts` — `GET
/api/keys` (masked list; raw keys never stored) and `GET /api/frontiers` (clusters with a
current frontier, for the selector). Dashboard talks to apps/server only, via
`POTION_API_URL` (default http://localhost:3000); route handlers under
`apps/dashboard/app/api/*` proxy so the browser stays same-origin.

## Failure Analyses
_(none yet)_

---

## M1a — Decouple from the mock world (dispatched 2026-08-04)
- [x] 1. Benchmark ingestion path + license audit (branch m1a-benchmarks) — DONE: SuiteManifest v2 + humaneval/jsonl-authored adapters + ingest CLI; code-gen-humaneval-js-v1 (12 JS tasks) + extraction-authored-v1 (30); LICENSES.md audit; python code-exec skipped with warning
- [x] 2. Mock corpus → test fixtures; production suites decoupled (branch m1a-mock-quarantine)
- [x] 3. Embedding canonicalization: 384-dim canonical, OpenAI dimensions=384 prod path (branch m1a-embedding) — DONE: resolveEmbedder (openai→mock fallback w/ warning), 384-dim guards, rebuild-centroids script, /healthz embedder reporting, POTION_CLUSTER_THRESHOLD override
- [x] 4. Provenance labeling: provider_mode mock|live end-to-end; serve-time guard (branch m1a-provenance)
- [x] 5. BYOK interim honesty fix (branch m1a-provenance)
- [x] 6. Staleness engine: model/prices/judge change → stale flags (branch m1a-provenance)
- [x] M1b-prep: OpenRouter aliases in prices.json + $1-capped live smoke (branch m1b-openrouter) — DONE 2026-08-04: 8 or-* aliases, live smoke exit 0 (or-deepseek fallback; mission models region-blocked from sandbox), spend $0.00001146, see M1b ledger

## M1a Gate Proofs
_(appended as workstreams land)_

### Item 1 — benchmark ingestion (branch m1a-benchmarks)
- Suite format v2: `suites/v2/<id>/manifest.json` + items.jsonl; adapters humaneval + jsonl-authored + registry + CLI (`pnpm --filter @potion/harness ingest`); runner `--suite-v2` wired, python items skipped with warning (`RunSummary.skipped`).
- Converted: code-gen-humaneval-js-v1 (12 original JS tasks, refs self-pass vm tests), extraction-authored-v1 (30 items repackaged, ids stable); `suites/LICENSES.md` audit (HumanEval MIT ok; others marked verify-before-customers).

### Item 3 — embedding canonicalization (branch m1a-embedding)
- DECISION: canonical 384-dim; prod = OpenAI text-embedding-3-small dimensions:384; mock stays dev/CI; Google 768-dim rejected with named error. resolveEmbedder priority + loud mock warning; dimension guards in assigner/centroids; `rebuild-centroids` (idempotent, dry-run verified 262 exemplars); /healthz embedder object.

### Item 2 — mock corpus quarantine (branch m1a-mock-quarantine)
- Corpus moved: `packages/providers/src/mock/fixtures.ts` (eval half) →
  `packages/providers/src/mock/eval-corpus.ts`, banner "TEST/CI SIMULATION
  ONLY — never authoritative for customer-facing evals"; `MOCK_PROVIDER_DISCLAIMER`
  exported from the mock module; mock behavior bit-identical (34 provider tests green).
- Suites: `code-gen.jsonl` + `extraction.jsonl` → `packages/harness/suites/simulated/`
  (+ README provenance statement); 8 authored suites carry
  `// provenance: authored, unvalidated — pending live calibration` headers;
  loader skips `//` comment lines.
- Runner: `runEval` throws `SimulatedSuiteError` for simulated suites without
  `simulatedOk` / `--simulated-ok`; `RunSummary.simulated: true` + loud CLI banner
  when simulated suites run. Refusal + opt-in demos recorded in the branch report.
- `gen:suites` → `gen:simulated-suites` (scripts/gen-simulated-suites.ts,
  deprecated/test-only banner, writes suites/simulated/).
- `pnpm build && pnpm test` green: 234 tests (233 + 1 new provenance-gate test).
- **Item 4 (provenance, m1a-provenance)**: `provider_mode` flows core → db (0002, DEFAULT 'unknown' + CHECK mock|live|unknown) → harness runEval stamping → pareto frontier points → serve guard: live server + mock frontier falls back with `x-frontier-trace: …;fallback=1;provenance=blocked`, mock dev server serves with `provenance=mock` (inject demo, apps/server/test/provenance.test.ts).
- **Item 5 (BYOK honesty, m1a-provenance)**: POST /api/keys returns `servingEnabled:false`; connect-keys page shows the verbatim custody banner and replaces the form with a contact-us note unless `NEXT_PUBLIC_BYOK_ENABLED=true` (walkthrough steps 1 + 7 PASS).
- **Item 6 (staleness, m1a-provenance)**: `markStale` flags exactly the rows whose prices/judge/model versions drifted (5-row mixed fixture → 3 flagged, idempotent); `aggregatesFromEvalResults` excludes stale rows by default (`includeStale` override); CLI: `DATABASE_URL=… pnpm --filter @potion/harness staleness -- --check` prints per-cause counts.


### M1a integration (orchestrator, 2026-08-04)
- All 5 branches merged via integrate-m1a (conflicts: harness runner/cli/package.json — both feature sets kept; lockfile regenerated). Integrated tree: typecheck 0 errors, **340 tests passed / 0 failed**, lint clean.

---

## M1b — Real numbers (RESTRUCTURED 2026-08-04: operator-run package)
Sandbox egress blocks OpenAI/Anthropic/Google (403/000) and OpenRouter's region for those
families; DeepSeek-class only reachable. M1b live runs therefore execute on the OPERATOR's
machine via docs/M1B-RUNBOOK.md (one command, capped), results committed back for analysis.
- [x] Operator: Gate-3 live rerun on v2 suites (--cap 25) → commit artifacts
- [x] Operator: Gate-2 rerun on OpenAI embeddings (needs OPENAI_API_KEY locally) → commit
- [x] Operator: 10-cluster frontier sweeps (--cap 15) → commit
- [x] Orchestrator: analysis + frontier publication + ledger reconciliation ($50 hard cap)
(all four superseded/completed — M1b live runs finished 2026-08-06; artifacts + ledger on record)

## M2 — Safe to sell (dispatched 2026-08-04, COMPLETE 2026-08-05)
Wave 1 (foundation):
- [x] 13. Tenant model: orgs/users/memberships, org-scoping on keys/policies/logs (branch m2-tenancy @ f00bcff)
Wave 2 (parallel, after tenancy merges):
- [x] 14. Dashboard auth: magic-link + sessions + RBAC (branch m2-auth @ 5db73b0)
- [x] 15. API key lifecycle: rotation/revocation/scopes/envs (branch m2-keys @ 0a994f3)
- [x] 16. Key custody: KMS envelope encryption, decrypt-at-use, audit log, validation call (branch m2-keys @ 0a994f3)
- [x] 17. Rate limits & quotas per key (branch m2-metering @ c0e7028)
- [x] 18. Metering: usage aggregation, cost reports, Stripe-ready invoicing (branch m2-metering @ c0e7028)
- [x] 19. Security pack: code-exec sandbox → isolated workers, injection hardening, audit/SBOM (branch m2-security @ 6fecfa1)
- [x] 20. Legal templates: ToS/DPA/privacy drafts (branch m2-legal @ 7ddc1c0)

## M2 Gate Proofs
- **Tenancy (m2-tenancy f00bcff)**: orgs/users/memberships (role admin|member|viewer); `resolveOrgContext(db, {kind:'apiKey'}|{kind:'session'})`; org_id NOT NULL on api_keys/provider_keys/policies/request_logs (migration 0003); provider_keys dedup per-org UNIQUE(org_id,key_hash); cross-org access tests pass.
- **Auth (m2-auth 5db73b0)**: magic-link sessions (sha256 token hashes, httpOnly potion_session cookie), auto-org provisioning on first signup, admin-only invites, `requireRole` RBAC, dashboardAuthHook gates /api/*, POTION_DEV_AUTH bypass (default ON outside production); 385 tests green on merge.
- **Key custody (m2-keys 0a994f3)**: AES-256-GCM envelope encryption (per-key data key wrapped by POTION_MASTER_KEY); zero plaintext at rest proven by PGlite-dir scan test; custody_audit table; rotate/revoke/validate lifecycle; `ctx.providersForOrg(orgId)` with 60s cache; `servingEnabled = status==='active' && ciphertext !== null`; 445 tests green on merge.
- **Metering (m2-metering c0e7028)**: per-key token-bucket rate limiting (429 + Retry-After + x-ratelimit headers); usage_daily rollup (idempotent); Stripe-ready invoice JSON + HTML; margin_pct pricing; 397 tests green on merge.
- **Security (m2-security 6fecfa1)**: worker_threads code-exec sandbox (2s timeout, 32MB heap cap, stripped globals — live-probed: memory bomb killed, infinite loop timed out at 2027ms, process/require undefined; 50 sequential runs, zero handle leaks); prompt-injection hardening (DATA-block wrapping, LAST-line-anchored PICK/SCORE/CONFIDENCE parse, decompose caps 8 subtasks/4k chars/kind allowlist); supply-chain gate (pnpm audit + plain-JSON allowlist, fails closed) + SBOM (CycloneDX 1.7, 439 components, artifacts/sbom.cyclonedx.json); gitleaks git+dir scans clean; docs/security/{CODE-EXEC,THREAT-MODEL}.md; 437 tests green on merge.
- **Legal (m2-legal 7ddc1c0)**: docs/legal/{TERMS_OF_SERVICE,PRIVACY_POLICY,DPA}.md counsel-review templates with consolidated [●] decision points.
- **M2 integration (orchestrator, 2026-08-05)**: waves merged via integrate-m2w2 → master; final merge integrate-m2-final @ 482dfbb (walkthrough updated to M2 custody behavior: servingEnabled:true, custody note, form ON). Integrated tree: build 0 errors, typecheck 0 errors, lint clean, **464 tests passed / 0 failed** (queue 5, core 13, dashboard 21, providers 35, db 23, strategies 46, cluster 52, harness 113, pareto 35, server 121).
- **M2 exit-criteria proof (2026-08-05, master @ 90ddb84)**: Gate-6 walkthrough re-run end-to-end on the M2 tree — **all 10 steps PASS in 8.6s**: cold boot (fresh PGlite, auto-seed) → magic-link signup (auto-org, role=admin) → connect provider key (201, encrypted, servingEnabled=true) → workload upload (40 prompts → 6 clusters) → frontiers → policy+key → /v1/chat/completions (x-frontier-trace, provenance=mock) → SSR frontiers page (SIMULATED badges) → home page (custody note, form ON, M1a banner gone). "A stranger signs up, connects a key, and is served through the platform" — verified.
- **OPEN follow-ups**: (a) audit re-triage — 16 high+ advisories in next@15.1.8/drizzle-orm allowlisted with per-advisory reasons (scripts/security/audit-allowlist.json), pending dependency bumps; (b) tenant-isolation pen-test is tests-only so far; (c) operator M1b runbook still pending (spend ledger: $0.00001146 / $50.00).

---

## M3 — Production-grade (COMPLETE 2026-08-05; contracts SPEC §12)
Wave 1 (parallel foundations):
- [x] 24. Provider resilience: retry/breaker/hedge/failover + chaos mock (m3-resilience 00b7cad, merged be6ce9b)
- [x] 28. BullMQ driver + workers + artifact store (m3-queue-workers a77e8f2, merged aa7af85)
- [x] 26. Observability: metrics/OTel/logging (m3-observability 91b1e76, merged 848344a)
- [x] 25. OpenAI parity: models/embeddings/completions/tools/errors (m3-openai-parity 1108a84, merged c770d52)
Wave 2 (after W1 merges):
- [x] 21. Shadow mode + savings report (m3-shadow 764fbee, merged 6594aff)
- [x] 27. HA: graceful shutdown, readyz, pool, pub/sub invalidation (m3-ha c272836, merged f9168d3)
Wave 3 (after W2 merges):
- [x] 22. Quality guarantee + auto-rollback (m3-guarantee 04155a5, merged 50b5aab)
- [x] 23. Composite streaming (7th strategy type) (m3-composite e083cc8, merged 2bbf4cc)
- [x] 29. CI/CD + chaos + audit re-triage + tenant pen-test (m3-cicd-chaos e0a6641, merged 5e8543f)

## M3 Gate Proofs
- **#24 resilience (00b7cad → be6ce9b)**: ProviderError taxonomy (retryable classification), resilient() (full-jitter backoff, per-attempt timeout, breaker closed→open→half-open, hedging w/ loser-abort), failoverChain(), breakerStates(), chaosProvider(); createProviders wrapped; mock determinism preserved; 488 tests (+24).
- **#26 observability (91b1e76 → 848344a)**: @potion/observability — prom-client metrics (http/provider/frontier-decision/breaker-gauge/shadow series), GET /metrics, OTel lazy-optional, pino redaction + x-request-id, withMetrics proxy at providersForOrg boundary; 524 tests (+36). Breaker gauge mapping: closed=0/half-open=1/open=2.
- **#25 OpenAI parity (1108a84 → c770d52)**: GET /v1/models, POST /v1/embeddings (384-dim), POST /v1/completions legacy, tool calling passthrough (single-strategy only), stream_options usage chunk, full OpenAI error-shape parity (401/429/400/503); walkthrough 10/10 green; 547 tests (+23).
- **#28 queue/workers/artifacts (a77e8f2 → aa7af85)**: BullMQ driver (hermetic ioredis-mock + fengari Lua shims; retry/restart-durable/typed-unavailable), packages/artifacts (local + S3-MinIO), packages/workers (eval:run e2e/sweep/staleness/shadow:judge stub), POST /api/evals + GET /api/jobs/:id (org-scoped), minio compose; driver precedence explicit > QUEUE_DRIVER > REDIS_URL > memory; 566 tests (+19).
- **#21 shadow (764fbee → 6594aff)**: ShadowConfig on Policy; migration 0007 shadow_results; fire-and-forget executor (≤2 candidates, resilient providers, all errors swallowed, shadow:judge via queue when present); GET /api/reports/savings[.csv] (projection vs actual, confidence tiers 30/200); dashboard /reports (SSR chart + table + CSV); 621 tests (+35... integrated 621).
- **#27 HA (c272836 → f9168d3)**: graceful shutdown (drain, idle-conn close, double-signal safe), /readyz (db SELECT 1 2s + queue probe + breakerStates payload), pg pool env config + connect retry, redis pub/sub cache invalidation (lazy ioredis, memory fallback), docker-compose.ha.yml + nginx + Dockerfile + docs/HA.md; 657 tests (+36). Known pre-existing: pnpm demo:customer SimulatedSuiteError (unrelated to HA; open follow-up).
- **#22 guarantee (04155a5 → 50b5aab)**: GuaranteeConfig on Policy; migration 0008 (quality_samples + incidents); fire-and-forget sampler; rolling-window evaluator (min 5 samples, per-window cooldown); auto-rollback via latest-unresolved-rollback override (previous frontier version first; resolve lifts override); guarantee:evaluate worker job (60s sweep); GET /api/guarantee/status + incident resolve (admin); dashboard breach badge + incidents table; potion_guarantee_breaches_total metric; 702 on-branch (+49).
- **#29 CI/CD + chaos (e0a6641 → 5e8543f)**: ci.yml (node22/pnpm cache/gitleaks/build/typecheck/lint/test/audit-gate/SBOM artifact), deploy.yml skeleton (Docker build real, push/deploy placeholder); tests/chaos package — db-killed-mid-eval (idempotent resume), redis-down (typed QueueUnavailableError, memory precedence), shadow-kill (primary SLO held), breaker-exhaustion (fail-fast + /readyz); 18 adversarial tenant-isolation cases (forged headers, cross-org enumeration, cookie tampering, bearer flip); next 15.1.8→15.5.22 + drizzle 0.36→0.45.2 + scoped overrides (postcss/sharp/glob) — audit allowlist 16→0, `audit-gate: PASS, 0 blocking`.
- **M3 integration (orchestrator, 2026-08-05)**: all 9 items merged via integrate-m3 → master @ 50b5aab. Final tree: build 0 errors, typecheck 0 errors, lint clean, audit gate PASS, **731 tests passed / 0 failed** (artifacts 5, core 21, dashboard 36, queue 9, providers 61, db 51, observability 29, strategies 54, cluster 52, harness 115, workers 9, pareto 35, server 243, chaos 11), walkthrough 10/10 green. M2 follow-ups (a) and (b) CLOSED by #29; (c) operator M1b runbook still open ($0.00001146 / $50.00).
- **#23 composite (e083cc8 → 2bbf4cc)**: 7th StrategyConfig type composite(startModel, upgradeModel, upgradeIf.confidenceBelow); kept/upgraded paths with reused cascade confidence (logprob | self-report-calibrated); stream = 20-token buffer then flush-continue or flush-switch (one coherent client stream); SSE relay with upgraded=0|1 in x-frontier-trace; mock [[mock-confidence:x]] fixture knob; harness/pareto compat; shadow switches gained composite cases (af4c33b); 674 tests (+17); walkthrough 10/10.

---

## M4 — Wildfire (COMPLETE 2026-08-06; contracts SPEC §13)
Wave 1 (parallel; migration numbers pre-assigned):
- [x] 30. SDKs (python+ts) + X-Potion-Policy override (merged 5e25126; request_logs_policy renumbered 0009→0013)
- [x] 31. Playground + share links — migration 0009_share (merged 3c96ac9; share pages return real 404s post-revoke, c04f5dc)
- [x] 33. Alerts & integrations — migration 0010_alerts (merged 3a21123; webhook+slack shapes, masked URLs, test endpoint, breaker-open alerts edge-deduped on both chat paths)
- [x] 35. Budget autopilot — migration 0011_budgets (merged 3a21123; chat-path hard stop 429 budget_exceeded, fail-open cache 60s TTL, nightly budget:evaluate sweep)
- [x] 34. Enterprise SSO/OIDC + audit export — migration 0012_auth_events (merged cbcba46; full PKCE-S256/RS256 flow, audit merge custody+auth, JSONL export, ENTERPRISE.md)
Wave 2:
- [ ] 32. Public leaderboard → MOVED to M4b (rides with #37 as the public face of the recipe library, per user decision)

## M4 Gate Proofs (all green 2026-08-06)
- build: pnpm build 0 errors (14 packages incl. sdks via tsup); dashboard tsc + prod build clean
- tests: **784 pnpm green** (artifacts 5, core 21, dashboard 36, queue 9, providers 61, db 51, observability 29, strategies 54, cluster 52, harness 115, workers 9, pareto 35, server 296, chaos 11) + TS SDK 14 (vitest vs node:http mock) + py SDK 13 = **811 total**
- walkthrough: **13/13 PASS** (base 0-7 + M4 steps: 8 playground, 9 share mint→session-free SSR→revoke→404, 10 budget hard-stop 429→disarm→200, 11 audit trail render+export)
- security: audit-gate PASS, allowlist 0; .env never tracked (verified)
- new M4 test files: server/test/alerts.test.ts (9), budgets.test.ts (7), audit.test.ts (7), oidc.test.ts (6 — mock IdP, RSA2048 JWKS, tampered-sig/nonce/state negatives)

## M4b — Autoresearcher (COMPLETE 2026-08-06; contracts SPEC §15; user decision: #32 rides as its public face)
- [x] db: migration 0014_research (research_cycles + recipe_status, idempotent), repos/research.ts (cycle lifecycle, sticky-firstCycleId upsert, read models for routes) — db 57 tests
- [x] packages/researcher (NEW): registry.ts (segment-matched classifyModel — 'gemini-pro' never hits 'mini'), generate.ts (template grammar × class-pruned registry, ≤20/cycle, dedupe vs existing + eval-cache cells), gate.ts (paired bootstrap 1000 resamples, mulberry32 seeded, +1.5pts @ ≤cost OR ≥20% cost cut @ ≥quality, CI lower bound must clear) — 26 tests
- [x] providers scan: fetchOpenRouterModels (raw fetch, per-token string pricing ×1e6), diffModelListings, MOCK_MODEL_LISTINGS — providers 68 tests
- [x] workers: researchScanHandler (diff → registry persist via POTION_PRICES_PATH → enqueue ≤3 cycles), researchCycleHandler (mock uncapped sentinel / live $5 cap, own ledger, promotion = saveFrontier + lifecycle flips + recipe_promoted alerts) — workers 19 tests incl. full gate e2e on seeded live evidence
- [x] gate hardening: COST_COMPARISON_EPS=1e-9 relative-epsilon ≤cost + costCutPct noise clamp (IEEE754 1.0000000000000002 regression test); live-evidence gating at the ROW level (mock cycle over seeded live rows CAN promote — how it's tested; real mock cycles structurally cannot)
- [x] server: POST /api/research/scan (admin), GET /api/research/cycles, GET /api/recipes (+lineage), POST /api/recipes/:hash/evaluate (admin), GET /api/leaderboard PUBLIC (honest awaiting_live_verification; LEADERBOARD_QUALITY_MIN=0.5); nightly scan interval; auth exemption — server 301 tests
- [x] dashboard: /recipes (status badges, SIMULATED/LIVE provenance, lineage drawer, admin scan+evaluate islands), /leaderboard public page, nav + middleware open prefix, 4 proxy routes — dashboard 36 tests
- [x] walkthrough step 12: mock scan → cycles settle → tmp registry extended (POTION_PRICES_PATH, repo file untouched) → /recipes SIMULATED → public /leaderboard awaiting — **14/14 PASS**

## M4b Gate Proofs (all green 2026-08-06)
- build: pnpm build 0 errors; dashboard tsc + prod build clean
- tests: **838 pnpm green** (artifacts 5, core 21, queue 9, dashboard 36, researcher 26, providers 68, db 57, observability 29, strategies 54, cluster 52, harness 115, pareto 35, workers 19, server 301, chaos 11) + TS SDK 14 + py SDK 13 = **865 total**
- walkthrough: **14/14 PASS** (M4 0-11 + M4b step 12)
- security: audit-gate PASS (official registry), allowlist 0; .env never tracked (verified)
- M4b commits: db layer → researcher → providers scan → workers → server → dashboard (456→463 files)

## M4b Research Spend Ledger (research_cycles.spend_usd — separate from the M1b $50 cap)
- Live research spend to date: **$0.00** (all cycles mock-provenance; live cycles activate only via POTION_RESEARCH_PROVIDER=live post-M1b, $5/cycle cap)

## M5 — Agent workloads (COMPLETE 2026-08-06; contracts SPEC §14)
- [x] db: migration 0015_traces (trace_spans, idempotent UNIQUE(org,trace,span); orgs.trace_retention_days default 30) + repos/traces.ts (idempotent batch ingest, window/waterfall reads, purge + metadata-only redaction, clustering read model, threshold loop detection with canonical-attrs signatures) — db 66 tests
- [x] workers: traces:cluster (redactTraceText FIRST → embed → toolSignatureSlug buckets → greedy cosine ≥0.62 agent-<slug> clusters + exemplars cap 8 → synthesized redacted replay suites agent-<slug>-replays-v1 with patch version bumps → mock sweep singles → evalRuns → computeFrontier saveFrontier('recompute'); idempotent re-runs, incremental growth) + traces:purge (retention 0=metadata-only redaction, N=delete, idempotent) + JobContext embedder/suitesV2Dir + POTION_SUITES_V2_DIR — workers 27 tests
- [x] server: POST /v1/traces (api-key, idempotent batch ≤500, ingest-time pricing byAlias→byModel), GET /api/traces rollup (loop signals, metadataOnly), GET /api/traces/:traceId waterfall, PUT/GET /api/traces/retention (admin), POST /api/traces/cluster + /api/traces/purge (admin, org-forced), nightly purge+cluster intervals (24h), X-Potion-Cluster chat hint (400 cluster_not_found unknown — explicit never silent), /api/frontiers merges db-registered agent clusters (gap fix: static taxonomy only previously) — server 305 tests
- [x] dashboard: /traces page (session rollup cost + LOOP/METADATA-ONLY badges, ?trace= waterfall per-span cost + parent indentation, agent-cluster frontier links, admin TraceClusterButton + TraceRetentionForm islands) + 5 proxy routes + nav step 8 — dashboard 36 tests
- [x] walkthrough step 13: 7-span ingest idempotent (retry 0 accepted/7 dup) → LOOP rollup + /traces badge → waterfall pricing → cluster job (2 agent clusters) → agent-* frontier → X-Potion-Cluster hint honored → retention 0 purge redacts attrs (restored 30); POTION_SUITES_V2_DIR tmp copy — **15/15 PASS in 21.3s**

## M5 Gate Proofs (all green 2026-08-06)
- build: pnpm build 0 errors; dashboard tsc + prod build clean
- tests: **859 pnpm green** (+21 over M4b: db 66, workers 27, server 305) + TS SDK 14 + py SDK 13 = **886 total**
- walkthrough: **15/15 PASS** (M4 0-11 + M4b step 12 + M5 step 13)
- security: audit-gate PASS (official registry), allowlist 0; .env never tracked (verified)
- M5 commits: db layer (0304475) → workers (708eac0) → server (19c265e) → dashboard (3973401) → walkthrough (f449e4b); 469→476 files
- survived two mid-session $HOME wipes with zero work lost (all layers committed immediately upon green)

### M1b EXECUTION — 2026-08-06 — Claude-chat sandbox ✅ (Steps 1–2; Step 3 skipped)

Authoritative cumulative per GET /api/v1/key: **$3.879 of $50.00** ($46.12 remaining).
Region note: unlike the 2026-08-04 sandbox, THIS sandbox's egress region is NOT
blocked — all mission or-* models (OpenAI/Anthropic families via OpenRouter) ran natively;
or-deepseek fallback never engaged.

**Step 1 (Gate-3 live, cap $25)** — final clean run `run-b03963c3`: $0.29, 252 results.
Headline: single:or-gpt-mini 1.000/0.968 (code-gen/extraction) at $0.08–0.09/1K;
cascade mini→sonnet matches at $0.17–0.18; best-of-3 pays $3.75–3.83/1K for ≤+0.009.
Full table: artifacts/m1b-gate3-live.log.

**Step 2 (sweep, cap $15)** — exit 0, 8 suites × 6 strategies × 14 items = 672 results,
$3.37 actual. JSON artifact: artifacts/m1b-sweep-2026-08-06T05-16-58-387Z.json, log:
artifacts/m1b-sweep.log. FINDING — projection deficiency: the "worst-case" preflight
estimator projected $1.44 but actual was $3.37 (2.3×); per-suite actuals exceeded
projections consistently (e.g. rewrite-edit $0.22 proj → $0.37 actual). Cap enforcement
held throughout, but the estimator under-counts (likely output tokens + judge overhead).
File as an M2 fix: the estimator must dominate actuals or preflight refusal is theater.

**Step 3 (Gate-2 embeddings)** — SKIPPED: no OPENAI_API_KEY in .env (runbook marks optional).

**Four defects found & fixed during execution (all with tests, suites green:
harness 118/118, providers 68/68, sweep 12/12):**
1. cli.ts: runbook's `--provider live` flag was never implemented (hardcoded mock) — added.
2. providers/factory.ts: nothing read `*_API_KEY` env vars despite the factory's own error
   message promising it — live mode was broken end-to-end; env fallback implemented.
3. code-exec-sandbox.ts: raw answers fed to sandbox with zero fence tolerance →
   single:or-sonnet scored 0.000 on ALL 12 code-gen items (Sonnet emits ```javascript
   fences despite "no markdown fences" prompt; confirmed by live repro). Added
   stripCodeFences mirroring field-match's ```json tolerance; invalidated the 12 poisoned
   cache rows; rerun scored 1.000. NOTE: all pre-fix code-exec results for fence-emitting
   models are invalid — any historical mock/live code-gen numbers for sonnet-class should
   be treated as unmeasured, not zero.
4. m1b-sweep.ts: never passed `resume` into runEval — interrupted sweeps lost results AND
   re-spent on retry; --resume flag added end-to-end.

Sandbox execution constraints (for future operator runs in Claude chat): background
processes do not survive between tool calls; single calls have a ~300s hard limit. Pattern
that works: DATABASE_URL=pglite://<repo>/artifacts/pgdata + --resume + repeated
timeout-bounded passes; per-item inserts bank results across interruptions.

Runbook Step 4 (commit): repo zip contained no .git — commit must happen operator-side.
Key revocation per ledger policy: M1b live runs complete; revoke unless Step 3 is wanted.

---

## Phase 1, item 1 — Cost estimator must dominate actuals (session 2026-08-06, plan approved)

**Baseline verified first**: 546 tests across 13 packages + server 305 + chaos 11 + TS SDK 14 +
py SDK 13 — all green. Two baseline fixes required: (a) root `vitest.config.ts` added — stray
`~/Downloads/vite(st).config.ts` files from another project hijacked vitest's upward config
search and broke every package in this environment; (b) `apps/server/test/traces.test.ts` was
the only buildServer test missing the repo-convention `90_000` beforeAll timeout and timed out
under full-suite load.

**Root cause (verified against artifacts/m1b-sweep-2026-08-06T05-16-58-387Z.json, 672 results):**
1. OpenAI-shaped live transport (used by ALL M1b OpenRouter traffic) never sends `max_tokens` —
   `DEFAULT_MAX_TOKENS=1024` is computed then ignored (`openai.ts:53`); recorded outputs reach
   1501 tokens. Anthropic/Google transports DO enforce it. Unbounded output ⇒ no finite
   projection can dominate.
2. `OUTPUT_TOKENS_PER_CALL=80` was calibrated to mock answers; live p95 is 595–1137 out-tokens.
3. Judge/probe prompts embed full answers but are modeled at 80 tokens; judge/probe outputs are
   themselves unbounded (no maxTokens on any judge/probe call).
4. Fan-out under-counts: decompose models 3 subtasks vs MAX_SUBTASKS=8 (and prices at
   routing[0], not the priciest route); cascade probe missed for logprob-fallback.
5. No test encodes projection ≥ actual.

**Fix (bounds by construction, no fudge multiplier):**
- [x] A. `openai.ts`: always send `max_tokens = sampling.maxTokens` (mirrors anthropic/google)
- [x] B. `PROTOCOL_MAX_TOKENS = 128` in @potion/core; optional params passthrough in
      strategies `callModel`; set on the 6 one-line-protocol call sites (llm-judge scorer,
      cascade probe, best-of-n judge, ensemble judge, decompose fusion judge, composite probe)
- [x] C. Rewrite `estimate.ts` token model: answer output = DEFAULT_MAX_TOKENS, protocol
      output = PROTOCOL_MAX_TOKENS, embedded answers = DEFAULT_MAX_TOKENS, judge scaffolding
      measured from `buildJudgeScoreMessages`, cascade probe for any confidenceMethod,
      decompose = MAX_SUBTASKS × priciest routed model
- [x] D. NEW regression test (harness): recorded M1b sweep replay — assert projection ≥ actual
      per-run, per-(suite×strategy) cell, and total; providers test for always-sent max_tokens;
      protocol-cap tests; update hand-computed expectations in existing tests
- [x] E. Full verify: providers/strategies/harness suites, then all-package re-run
      (final counts in the commit message; sweep script 12/12; --dry-run preflight re-printed)
- [x] F. Docs: ledger row (no live spend); CLAUDE.md defect #2 update deferred to the
      repositioning re-plan (CLAUDE.md is being rewritten there anyway)
- [x] G. TRUNCATION RESOLUTION (owner review finding): the enforced 1024 cap is itself a
      behavior change — recorded M1b answers exceeded it. Analysis of the recorded sweep
      (336 single-strategy results): 12 answers certainly >1024 tokens, ALL in
      agentic-tool-use (or-gpt-full / or-sonnet, max 1501), and those long answers score
      HIGHER than the suite mean (0.942 vs 0.828) — a silent cap would truncate the BEST
      answers on the suite where compositions matter most. Resolution: per-run configurable
      `maxOutputTokens` (RunOptions → ExecContext → every answer call incl. single's direct
      path; CLI `--max-output-tokens`), per-suite config `SUITE_OUTPUT_CEILINGS` in
      harness/suites.ts (agentic-tool-use: 2048, evidence-driven), and the estimator BINDS
      to the configured value (projection scales with the ceiling — a bound achieved by
      truncating output is not a fix). Summarization/creative/rewrite-edit stayed under
      1024 in recorded data (near-cap band: 4 results in 900–1034, code-review +
      agentic-tool-use — watch on next live run). Protocol calls stay at
      PROTOCOL_MAX_TOKENS regardless.

**Final numbers (rebuilt --dry-run preflight, ceilings applied)**: sweep projects **$12.99**
vs $3.37 recorded actual (old estimator: $1.44, 2.3× UNDER) — dominates every suite and every
(suite × strategy) cell (regression-tested), agentic-tool-use projected at its 2048 ceiling
($3.02), and the sweep still fits the $15 cap. Item-level domination is impossible against
PRE-fix data: 16/672 recorded results were produced before max_tokens enforcement (max 1501)
— documented in estimate-m1b-regression.test.ts.

**Owner flag — cap sizing**: projections are now honest worst cases (~3.5× typical actuals).
Existing caps sized against the old under-counting estimator (workers DEFAULT_EVAL_CAP_USD=10,
research $5/cycle) are now effectively stricter; re-size deliberately if live runs refuse.

| date | run | projected | actual | cumulative |
|---|---|---|---|---|
| 2026-08-06 | estimator fix session — no live calls (regression vs recorded artifacts only) | $0.00 | $0.00 | $3.879 / $50.00 |

---

## Repositioning — guarantee product (2026-08-06, plan approved)

OpenRouter ships free generic routing (Auto Beta; coding Pareto Router) at 100T tok/mo —
we exit generic selection. Product = quality guarantee on the customer's own workload over
models AND compositions (M1b: cascade 0.943 @ $6.85/1K vs sonnet 0.957 @ $19.31/1K on
agentic-tool-use). Design-partner-first, hand-issued keys, invoiced. Full positioning +
roadmap: CLAUDE.md.

**Pressure-test verdicts (3 deep code explorations):** the guarantee loop's machinery
(windows/incidents/rollback/alerts, org-isolated) is real, but its quality signal is a
Jaccard-vs-prompt STUB — no judge anywhere in the path; breach stats are a bare mean (n≥5,
no CI, success-path sampling, cluster misattribution); serving keys can resolve their own
incidents. Frontiers/clusters/eval evidence are global by design contract — per-org
frontiers are an architecture change (schema + ~7 call sites + racy versioning + publisher
rules). Chat path retains no content; traffic enters via /v1/traces which stores prompts
verbatim (redaction is 3 regexes, late); derived suites sit on worker-local disk with no
lifecycle; replays have no reference answers; judge calibration is mock-hardwired.
Researcher gate.ts (paired bootstrap) is pure and reusable for breach CIs. Invoiced
billing + key minting exist; org-creation route and SMTP do not (dev-link workaround).
CLAUDE.md's old defect #1 ("server has ZERO tests") was stale — 305 tests exist; item
re-scoped to hot-path gaps.

### Phase G0 — make the measurement real
- [x] G0.1 Judge-scored guarantee samples: replace serveQualityScore Jaccard with a real
      llm-judge call (protocol-capped, PROTOCOL_MAX_TOKENS), sampled per GuaranteeConfig;
      spend recorded per org and visible to budgets; queue payloads carry no raw content
      at rest longer than needed. Mock mode keeps a deterministic mock JUDGE (labeled),
      never Jaccard. [M]
- [x] G0.2 Judge trust: extend runJudgeCalibration beyond hard-wired mock judges — real
      judge pair on reference-scored items, Pearson + flag <0.8, per workload; store the
      calibration record with the frontier evidence. [M]
- [x] G0.3 Contract-grade breach stats: CI-lower-bound breach decision (reuse gate.ts
      paired-bootstrap machinery), configurable min-samples (floor 5 → raise), stratified
      sampling incl. error path, samples keyed (org, policy, cluster, strategy). [M]
- [x] G0.4 Cost estimator dominates actuals (c248d74; regression-tested vs recorded M1b)
- [x] G0.5 Gate-2 live embeddings run + suites scaled 50–100/cluster (needs OPENAI key +
      small ledgered budget). [M]

### Phase G1 — per-customer workload pipeline
- [x] G1.1 Ingest-time redaction: real PII pass at POST /v1/traces before rows are written
      (names/phones/addresses/ids; documented residual risk), raw prompt never at rest;
      re-redact existing rows via migration job. [M]
- [x] G1.2 Org-scoped trace clustering: org predicate in listTracesForClustering SQL,
      per-org cluster ids (agent-<org>-<slug>), org column on db-registered clusters +
      exemplars; X-Potion-Cluster validates org ownership. [M]
- [x] G1.3 Derived suites out of worker-local disk: Postgres or artifact store with
      retention/deletion tied to trace retention; suite provenance rows. [M]
- [x] G1.4 Replay fidelity: capture reference answer + tool results + multi-turn context
      in synthesized items (ingestion contract addition); judge anchors on reference. [L]
- [x] G1.5 Automated scorer construction: rubric generation per cluster from exemplars +
      G0.2 calibration on the result; customer-visible rubric review step. [M]
- [x] G1.6 Per-org frontiers [ARCHITECTURE]: org_id (NULL=platform) on frontiers/
      frontier_points/eval_runs/eval_results, unique (org,cluster,version) fixing the
      read-then-insert race, fallback-to-global reads, thread org through ~7
      loadCurrentFrontier sites (share links + leaderboard stay platform-only), org-scoped
      recompute + provenance rules (live-evidence-only serving stands). [L]
- [ ] G1.7 Live capped evals of customer suites (estimator now honest): live sweep of the
      per-org frontier under --cap with ledger rows; mock-derived frontiers remain
      demo-only. [M]
- [ ] G1.8 Researcher per-org refresh: thread suiteV2Ids + suitesV2Dir + org through
      researchCycleHandler; gate.ts unchanged; per-org cycle trigger route. [S]

### Phase G2 — guarantee as product surface
(owner-reordered 2026-08-07 — queue of record: G2.7 → G2.1 → G2.2 → G2.3 → G2.4 →
G2.6 → G2.8 → G2.5. Onboarding lands FIRST so a real org's traffic accumulates while
the rest of G2 is built — guarantee report and incident SLAs get developed against real
data, not walkthrough spans. Redis is DEFERRED to last: in-memory limiting is only
incorrect across replicas and initial deployment is single-instance. G2.8 is the
capstone everything else serves.)
- [ ] G2.7 Operator onboarding: org-creation route (operator credential, not self-serve),
      README runbook: create org → policy → hand-issue key → invoice. [S]
- [ ] G2.1 Guarantee report: quality time series per policy/cluster (persisted samples +
      request_logs join via new completion-id column); exportable monthly report next to
      the invoice. Incl. the serve-path judgeMaxTokens budget on GuaranteeConfig
      (G1.4-filed stray: verbose judges truncate at PROTOCOL_MAX_TOKENS on the serve
      path today). [M]
- [ ] G2.2 Incident SLAs: emitAlert on the in-process breach path (parity with worker),
      measured breach→notification latency, auto-restore-on-recovery option, cooldown
      that re-fires on worsening. [M]
- [ ] G2.3 Key role split: serving keys lose incident-resolve and other admin mutations;
      explicit admin scope for humans. [S]
- [ ] G2.4 Targeted server hot-path tests: guarantee override gating, pre-auth log
      attribution, policy override, provenance guard branches. Incl. the
      mock-eligibility audit: sweep EVERY provider-resolution site with the proven
      guard — live excludes mock entries, keyless live fails loudly (the fourth
      false-live instance, G1.5's classRepresentative, made this a pattern). [M]
- [ ] G2.6 Compound policy: quality floor + latency bound in one policy (schema + select +
      routes + dashboard picker). [S/M]
- [ ] G2.8 CAPSTONE — one real workload end-to-end: ingest → redaction → org-scoped
      clustering → derived suite with references → per-cluster rubric → per-org
      frontier → live capped eval → guarantee verdict → customer-visible report, as a
      single demonstrated, committed run with a ledger row. The integration proof of
      everything in G1+G2 and the demo for a first external customer. The specific
      workload is chosen at this item's check-in — not assumed before. [L]
- [ ] G2.5 DEFERRED TO LAST (post-capstone): Redis rate limiting + shared caches —
      build when deployment reality demands multi-replica correctness; the
      RateLimiterStore seam (apps/server/src/middleware/ratelimit.ts) stays documented. [M]

DEMOTED (parked): public pricing page, catalog breadth, self-serve funnel, SDK publishing,
SMTP, cloud-KMS, Stripe.

### Design-partner readiness (≥$10K/month behind a guarantee)
Minimum bar: judge-scored rolling quality live + metered + calibration record (G0.1-2);
CI-based breach + stratified sampling (G0.3); ingest redaction + org-scoped clustering +
suite lifecycle (G1.1-3); partner frontier from THEIR traffic live-evaluated under
ledgered caps (G1.6-7; single-tenant deploy is acceptable interim isolation);
min_cost(qualityFloor)+guarantee verified in staging; serving key cannot resolve incidents
(G2.3) + alerts on both breach paths (G2.2); estimator-capped preflight (done);
onboarding runbook executed once end-to-end (G2.7).
Pilot measurements: rolling quality vs floor per cluster (CI not mean); breach count /
time-to-detect / time-to-notify; judge↔human agreement on their traffic; realized $/1K vs
incumbent single-model baseline; sampling coverage; frontier drift across refreshes.
Disclosed as not built: SLA credits/remedies; human ground truth (judge-based); HA posture
(per-replica limits until G2.5); compound latency policies (G2.6); Stripe (invoiced);
workload leaderboards; automated rubric review (human-in-the-loop until G1.5).

---

## G0.1 — Judge-scored guarantee samples (session 2026-08-06, plan approved)

Design (full plan in the session record): judge runs IN-PROCESS on the server, always
(mock AND live), fire-and-forget like the shadow executor — the live path stops enqueueing
{promptText, answerText}; after scoring + inserting the sample the server enqueues
guarantee:evaluate in per-target mode (no content), so window evaluation + alert emission
run through the worker's existing path. Scoring reuses scoreLlmJudge wholesale via a new
harness serve-judge module (reference-free rubric, scale [0,10], PROTOCOL_MAX_TOKENS).
Judge spend = one request_logs row per judge call with status='guarantee_judge': cost sums
in rollupQuery widen to include it; requests/token counts stay serving-only. Additive
GuaranteeConfig.judgeModel (default judge-class live / mock-judge mock). quality_samples
gains scorer/judge_model/judge_cost_usd (migration 0016). Both serveQualityScore Jaccard
implementations deleted; shadowScore untouched (shadow's own stub, G-later).

- [x] a. core: GuaranteeConfig.judgeModel (additive zod + type + test)
- [x] b. db: 0016_guarantee_judge.sql (ADD COLUMN IF NOT EXISTS scorer/judge_model/
      judge_cost_usd) + schema + NewQualitySample; rollupQuery cost-vs-requests contract
      (+ usage tests)
- [x] c. harness: serve-judge.ts (SERVE_JUDGE_RUBRIC, scale, defaults, scoreServedAnswer
      reusing scoreLlmJudge) + tests
- [x] d. server: rewrite runGuaranteeSample (judge call via orgProviders, evidence-rich
      sample insert, guarantee_judge request_log, content-free enqueue | in-process eval);
      chat.ts call sites pass orgProviders + policyId
- [x] e. workers: delete serveQualityScore + payload.sample scoring mode; keep per-target
      + sweep + alerts; jobs.ts payload updated
- [x] f. tests updated across server/workers/usage/core/db; full pnpm -r green +
      walkthrough; manual proof (sample row + judge log row + /api/usage/current)
- [x] g. docs: CLAUDE.md defect #1 updated; ledger row ($0 — mock judge only); commit

**G0.1 DONE (2026-08-06)**: proof — chat 200 → quality_sample {quality 0.58,
scorer llm-judge:mock-judge, judgeCostUsd recorded} → status='guarantee_judge'
request_log (280 in / 3 out tokens) → usage_daily: 1 request (judge row counts
toward COST only, never requests/tokens). Full verify: 881 pnpm tests green
(core 21, queue 9, dashboard 36, artifacts 5, researcher 26, providers 69,
db 67, strategies 58, observability 29, cluster 52, harness 130, pareto 35,
workers 27, server 306, chaos 11); walkthrough 15/15. Two load-flaky tests
given explicit 30s timeouts (runner-v2 code-exec, workers research cycle) —
same class as the traces.test fix. Zero live API calls.

| date | run | projected | actual | cumulative |
|---|---|---|---|---|
| 2026-08-06 | G0.1 session — no live calls (mock judge only) | $0.00 | $0.00 | $3.879 / $50.00 |

---

## G0.3 — Contract-grade breach statistics (session 2026-08-06, plan approved)

Design: samples re-keyed (org, policy, cluster, strategy) via migration 0017 (strict
windows; NULL-key stub-era rows excluded from evidence); seeded bootstrap CI moved to
@potion/core stats.ts (SPEC-pinned researcher mulberry32 variant, gate.ts delegates —
zero-drift); breach fires only when CI95 UPPER < minQuality (confident breach), observed-
below-floor-but-straddling → new 'not-significant' suppressed state; deterministic seed
from the evidence itself (auditable, stored in incident detail with ci95/resamples);
GuaranteeConfig.minSamples (additive, floor 5, evaluation-time default); error-path
sampling (quality 0, scorer 'serve-error', no judge) at the 3 chat exec-failure catches;
sweep rework (distinct keyed tuples replace the strategies×clustersForStrategy cartesian
— fixes N-incidents-per-strategy misattribution); status route per-policy keyed numbers.

- [x] a. core: stats.ts (mulberry32 + bootstrapMeanCi + seedFromString) + minSamples
      schema; researcher rng/gate zero-drift delegate (26 tests pin verdicts)
- [x] b. db: 0017 migration + keyed window query returning values + CI decision +
      cooldown policyId + distinctSampledTargets; delete rollingQualityForOrg +
      clustersForStrategy (caller-less)
- [x] c. server: keyed inserts, runGuaranteeErrorSample + 3 catch-site wiring, policyId
      threading, status route per-policy numbers
- [x] d. workers: resolveTargets keyed sweep + payload policyId
- [x] e. dashboard types + incidents-table doc string + SPEC.md GuaranteeConfig (fixes
      judgeModel drift too)
- [x] f. tests: core stats; db (confident-breach / not-significant / minSamples /
      strict-keying); server error-path integration; workers keyed sweep; 8 fixture
      insert sites gain keys; full pnpm -r + walkthrough
- [x] g. manual proof + CLAUDE.md defect update + ledger ($0) + commit

**G0.3 DONE (2026-08-06)**: proof — decisively-low window {mean 0.20, ci95
[0.14, 0.26], seed recorded} → breach with full audit detail (policyId/ci95/
seed/resamples/minSamples in the incident); high-variance window {mean 0.58 <
floor 0.6, ci95 [0.28, 0.86]} → 'not-significant', NO incident; verdicts
re-derive bit-identically; exec failure → 503 + keyed quality-0 'serve-error'
sample (integration-tested); status route reports per-policy keyed numbers.
Sweep now evaluates distinct keyed tuples (the N-incidents-per-strategy
cluster misattribution is structurally gone). Full verify: 894 pnpm tests
green (core 26, db 74, server 307, workers 27, researcher 26 bit-identical,
rest unchanged); walkthrough 15/15; only the 2 documented pre-existing lint
errors. Zero live API calls.

| date | run | projected | actual | cumulative |
|---|---|---|---|---|
| 2026-08-06 | G0.3 session — no live calls | $0.00 | $0.00 | $3.879 / $50.00 |

---

## G0.2 — Judge-truth calibration (session 2026-08-06, plan approved)

Design: calibration becomes judge-vs-TRUTH on deterministic reference-scored items (the
old mock-noise agreement check never computed ground truth at all): one pass answers
each item (single answerer) → deterministic truth via scoreAnswer ($0) → each judge
re-scores via a synthetic llm-judge view; report per-judge pearsonVsTruth + meanAbsErr +
flag <0.8 + cross-judge agreement + REAL spend. Preflight-capped via a calibration
projection (BudgetCapError). Persisted to new judge_calibrations (0018; platform-global,
text keys, provider_mode CHECK, judge_resolved_model = runner's judgeVersionOf resolution
so records stale in lockstep). Surfaced (not gated) on GET /api/guarantee/status per
policy's effective judge. CLI --calibrate becomes standalone (v2 suites supported,
--judge repeatable, flagged → exit 3). LIVE run: OpenAI key (custody: gitignored .env,
chmod 600), additive oa-mini/oa-full prices aliases WITHOUT version bump (bump would
stale-flag all M1b evidence — deliberate, documented), extraction-authored-v1 +
code-gen-humaneval-js-v1, judge pair oa-mini + oa-full, cap $2, ledger rows.

- [x] a. db: 0018_judge_calibrations + repo + tests
- [x] b. harness: calibrate.ts truth-anchored rework + projectCalibrationCostUsd +
      BudgetCapError + tests (truth stats, cap refusal, legacy agreement, persistence)
- [x] c. cli: standalone --calibrate (v2 suites, --judge, exit 3 on flag)
- [x] d. server: status route judgeCalibration field + dashboard DTO + tests
- [x] e. mock proof + full pnpm -r + walkthrough
- [x] f. LIVE calibration (cap $2, ledger before/after; OpenAI has no key-balance
      endpoint — ledger records usage-priced spend)
- [x] g. docs (CLAUDE.md defect line) + commit

| date | run | projected | actual | cumulative |
|---|---|---|---|---|
| 2026-08-06 | G0.2 live calibration, OPENAI key (separate ledger; usage-priced — no balance endpoint for project keys): run 1 extraction (mini answerer, mini+gpt5 judges) $0.0546; run 2 code-gen (mini/mini) $0.0023; run 3 code-gen (nano answerer, mini+gpt5) $0.0210; one 400-rejected run pre-generation $0 | $0.2197 | $0.0779 | $0.0779 (OpenAI key) |

**G0.2 DONE (2026-08-06)** — mock proof: truth-Pearson 0.955/0.941 (agreement
0.897), persisted provider_mode=mock, exit 0. LIVE runs (3, $0.0779 total,
capped $2 each) produced FLAGGED records — which is the machinery working:
(1) gpt-5-as-judge is unusable under PROTOCOL_MAX_TOKENS=128 (reasoning
consumes the completion budget → empty output → strict parse 0, mAE 0.97);
per-judge protocol-cap override is future work if reasoning judges are wanted.
(2) Competent answerers produce (near-)constant truth on the current n=12-30
suites → correlation is INDETERMINATE (now honestly labeled, pearson null,
conservatively flagged) — larger/harder suites (G0.5) are the fix, matching
defect #4. (3) gpt-4.1-mini as judge tracks truth (mAE 0.028) but
rubber-stamps ≈1.0 — no discrimination, correctly flagged. Two live-path
transport/stat bugs found & fixed with tests: OpenAI-native chat requires
max_completion_tokens (max_tokens rejected — split from the OpenRouter path);
pearson() reported two DIFFERENT constant vectors as agreement 1.0.
Verify: harness 133 + db 76 + providers 69 + server 18-in-file, full sweep at
commit. Judge trust surfaced per policy on /api/guarantee/status
(judgeCalibration; null = never calibrated, itself a signal).

---

## G0.5 — Gate-2 live embeddings + discriminative suite scaling (session 2026-08-06, plan approved)

Findings shaping scope: evaluate.ts hardcoded the MOCK embedder (runbook's "live" Gate-2
command would print a false proof at $0); threshold 0.62 is mock-geometry-tuned (live
cosines compressed → sweep required; POTION_CLUSTER_THRESHOLD already the serving knob);
no real HumanEval exists in-repo (the 12 "humaneval-js" items are Potion one-liners —
why models ace them); v1 suites append-only-safe / v2 counts frozen by tests;
--calibrate silently sliced to 30; extraction-authored-v1 is mock-corpus data with its
SIMULATED quarantine stripped during v2 repackaging (superseded as evidence by the new
authored suite; kept frozen as fixture). Deterministic-first: 5 llm-judge breadth suites
deferred (no calibration value) — follow-up item.

- [x] a. evaluate.ts: resolveEmbedder wiring + honest banner + --sweep with memoized
      embeddings + test; mock ≥85% @0.62 reproduces through the new path
- [x] b. LIVE Gate-2: threshold sweep 0.1–0.7, confusion matrices,
      artifacts/m1b-gate2-live.log, recommended POTION_CLUSTER_THRESHOLD, ledger
- [x] c. code-gen-potion-v2: 60 tiered JS items (20E/25M/15H, ≥5 tests each), mechanical
      self-pass gate as a permanent harness test + reviewer pass
- [x] d. extraction-potion-v2: 50 authored field-match items (6-10 fields, arrays,
      absent fields, ambiguous docs) + reviewer pass + ingest lint
- [x] e. exact v1 appends: classification/multi-step-reasoning/rag-answer +36 each → 50
      (new ids only; existing 14 byte-untouched; domination regression re-run green)
- [x] f. cli --calibrate-n (default 30, silent slice removed)
- [x] g. LIVE recalibration on code-gen-potion-v2 (nano answerer, mini judge, cap $2) —
      closes G0.2 INDETERMINATE with a real pearson-vs-truth
- [x] h. docs (CLAUDE.md defect #4 + Gate-2), ledger rows, two commits

### GATE 2 LIVE ✅ (2026-08-06, OpenAI text-embedding-3-small dims=384)

**96.00% held-out accuracy (200 examples) — PASSES ≥85%, ABOVE the mock's 89.00%.**
Full sweep (artifacts/m1b-gate2-live.log): 96.00% flat across thresholds 0.05–0.2,
95.50% @0.25, 92.50% @0.3, 87.50% @0.35, 82.50% @0.4, 45.50% @0.5, **6.00% @0.62** —
the mock-tuned default threshold routes nearly everything to 'general' on real
embeddings, exactly as predicted (compressed cosine geometry). **Recommended
POTION_CLUSTER_THRESHOLD=0.2 for live deployments**: the highest plateau threshold,
preserving a meaningful below-threshold→general fallback (0.05 would almost never fall
back). Mock path re-verified at 89.00% @0.62 through the NEW resolveEmbedder-wired
evaluate.ts (the old script hardcoded the mock — a live run would have printed a false
proof). Embedder provenance on cluster rows remains schema debt (artifact log is the
record). Pre-G0.5 defect fixed: evaluate.ts ignored POTION_EMBEDDER entirely.

| date | run | projected | actual | cumulative |
|---|---|---|---|---|
| 2026-08-06 | Gate-2 LIVE sweep: 462 texts embedded once (memoized across 10 thresholds), ~16.5K tokens @ $0.02/1M | $0.01 | ~$0.0004 | $0.0783 (OpenAI key) |

**G0.5 DONE (2026-08-06)** — Gate-2 LIVE 96.00% (see proof block above; leg-1 commit
5ffbdca). Suite scaling: code-gen-potion-v2 (60 tiered JS items, 100% sandbox self-pass
— now a PERMANENT harness gate), extraction-potion-v2 (50 discriminative field-match),
+36 each to classification/multi-step-reasoning/rag-answer (→50; append-only, M1b
domination regression green). Independent adversarial review: 0 blocking findings
(all 36 reasoning answers recomputed by script). --calibrate-n added (silent slice(0,30)
removed). LIVE recalibrations (nano answerer, mini judge, ~$0.045 total):
- code-gen: nano fully solves 56/60 — even the hard tier barely dents a 2025 nano;
  4-point truth spread → pearson statistically meaningless; the judge scored 1.0 on an
  item whose code LOOKED right but failed tests (a reading-judge cannot execute code —
  code-exec truth is irreplaceable there). Flag correct.
- extraction-v2: REAL signal at last — pearson-vs-truth 0.421 (n=50, genuine field-level
  spread; the discriminative design works), mAE 0.073. FINDING OF RECORD: gpt-4.1-mini
  as a reference-free judge is measurably below the 0.8 trust bar. The guarantee's
  serve-judge default for live (judge-class = sonnet-class) remains UNCALIBRATED —
  calibrating it is the natural next live run (OpenRouter key needed, ~$0.10).
Suites: 899→910 pnpm tests green (cluster 55, harness 137, server 307 — jobs.test count
pin 14→50 updated), walkthrough 15/15.

| date | run | projected | actual | cumulative |
|---|---|---|---|---|
| 2026-08-06 | G0.5 live recalibrations: code-gen ×2 ($0.0143 each) + extraction-v2 ($0.0156) | $0.30 | $0.0442 | $0.1225 (OpenAI key) |

---

## G1.1 — Ingest-time PII redaction + judge-class calibration (session 2026-08-06, plan approved)

Design: shared deterministic+idempotent redactor in @potion/core (redact.ts) — JWT/secret/
email/card(Luhn)/SSN/IBAN/phone/IPv4/url-cred placeholders, ≥4-digit rule LAST; residual
risk documented (names/addresses/narrative PII = NER territory, out of scope for the
pattern pass). redactAttrs walks string leaves only, preserves keys, operational allowlist
(gen_ai.request.model, gen_ai.operation.name, tool.name). Applied at POST /v1/traces
BEFORE rows are written; worker redactTraceText stays as second-pass defense (delegates to
core). Backfill job traces:redact (idempotent; admin route; one-shot by design — operators
run once post-deploy; no nightly). Leg 2: judge-class (sonnet@openrouter) calibrated on
extraction-potion-v2 (the suite G0.5 proved has real truth spread), cap $2; OpenRouter key
verified ALIVE pre-run ($46.0964 remaining; authoritative usage $3.9036 — ledger
cumulative reconciled to this, +$0.025 drift from M1b estimated rows).

- [x] a. judge-class LIVE calibration (leg 2; ledger before/after; record persisted)
- [x] b. core redact.ts + tests (patterns/Luhn/idempotency/nested/allowlist)
- [x] c. ingest wiring + server tests; worker delegation + contract test update
- [x] d. backfillRedactSpans + traces:redact job + admin route + tests
- [x] e. keyless full sweep + walkthrough + manual proof
- [x] f. docs (CLAUDE.md defect #3) + commits

**G1.1 leg 2 DONE (2026-08-06)** — judge-class calibration finding chain (all persisted,
probes on record):
1. Rubric-scale mismatch: "full credit only when completely correct" made sonnet score
   all-or-nothing against graded truth (mAE 0.88, r=0.05). CALIBRATION_RUBRIC is now
   GRADED (proportional credit).
2. Verbose-judge truncation: with the graded rubric sonnet reasons field-by-field and
   truncated at PROTOCOL_MAX_TOKENS=128 before its SCORE line → parse-fail 0 (probe
   evidence). Second instance of the G0.5 lesson (enforcement caps must be configurable
   with dependent calculations bound to the config): calibration gains judgeMaxTokens
   (projection-bound, --judge-max-tokens). FOLLOW-UP: per-judge budget for the SERVE
   path (GuaranteeConfig) if verbose serve-judges are wanted.
3. Final records (extraction-potion-v2, n=50, judge budget 768): judge-class (sonnet)
   pearson-vs-truth 0.544 / mAE 0.039 — BEST judge measured; gpt-mini 0.439; cross-judge
   agreement 0.568. All below the 0.8 contract bar → correctly FLAGGED. Standing truth:
   reference-free judging does not yet clear contract grade — reference-anchored replays
   (G1.4) / per-cluster rubrics (G1.5) are the路 to 0.8.

| date | run | projected | actual | cumulative |
|---|---|---|---|---|
| 2026-08-06 | LEDGER RECONCILE: authoritative OpenRouter usage was $3.9036 (ledger said $3.879; ~$0.025 M1b estimated-row drift) | — | — | $3.9036 / $50.00 (OpenRouter) |
| 2026-08-06 | judge-class calibrations ×3 + 3 probes (sonnet judge calls via OpenRouter; before $46.0964 → after $45.3997 remaining) | $2.00/run cap | $0.6966 | $4.6003 / $50.00 (OpenRouter) |
| 2026-08-06 | same runs, OpenAI side (nano answerers + mini judge) | — | ~$0.07 | ~$0.19 (OpenAI key) |

**G1.1 leg 1 DONE (2026-08-06)** — platform redactor in @potion/core (JWT/secret/email/
card+Luhn/SSN/IBAN/phone/IPv4/url-cred, ≥4-digit rule last; deterministic + idempotent;
placeholder vocabulary preserved). Applied at POST /v1/traces before rows are written —
raw prompts never at rest; string leaves only, keys preserved, operational allowlist
(model ids with digit runs survive). Worker redactTraceText delegates to core (defense-
in-depth). Backfill: traces:redact job + POST /api/traces/redact (admin, org-forced,
idempotent — second run updates 0). RESIDUAL RISK (documented): names/addresses/narrative
PII are NER territory — pattern pass only; partner-facing surfaces treat redacted text as
reduced-risk, not risk-free. OPERATOR RUNBOOK: run POST /api/traces/redact once per org
after deploying G1.1 (covers pre-G1.1 rows). 914 pnpm tests green (core 32, workers 28,
server 308), walkthrough 15/15 (loop detection verified on ingest-redacted spans). No
live calls (leg 1 $0).

---

## Judge-verdict robustness check (owner-directed, 2026-08-06)

Re-ran the extraction-v2 calibration (persistent db, spearman now a permanent report
field + 0019 column). Findings that FINALIZE the verdict:
1. **Truth distribution is ceiling-compressed**: 34/50 items at exactly 1.0, the rest in
   [0.67, 0.89]; mean 0.944, sd 0.093, 8 distinct values. Correlations are computed on a
   narrow top band — measured r/ρ understate ranking ability on a broader-difficulty
   corpus, and the corpus's discriminative band needs widening (harder items or weaker
   answerers) before the 0.8 bar is a fair test.
2. **Spearman ≈ Pearson** (sonnet ρ=0.676 vs r=0.637; mini ρ=0.600 vs r=0.590): NO
   monotone-scale-distortion gap — recalibrating the judge's scale would not rescue it.
   Within the fine [0.67–1.0] band the judge genuinely mis-ranks (gives 1.0 to
   truth-0.70 items, 0.75 to truth-0.89 items; its outputs are coarse {0.75, 0.875, 1}).
3. **Run-to-run variance is material**: sonnet r moved 0.544→0.637 across identical
   live runs (judge non-determinism at n=50) — single-run correlations carry ±0.1-scale
   error. FOLLOW-UP: bootstrap CI on the correlation itself (bootstrapMeanCi machinery
   exists) before any contract-facing use of these numbers.
4. **FINAL VERDICT (nuanced, evidence-backed)**: judge-class is a good LEVEL estimator
   (mAE 0.036) but a weak FINE-GRAINED ranker on a ceiling-compressed corpus — unfit,
   as configured, to detect the small (~0.05) quality drops a guarantee floor exists to
   catch. Correctly flagged below 0.8. Paths forward remain G1.4/G1.5, now plus corpus
   difficulty-widening (G0.5 follow-on) and correlation CIs.

| date | run | projected | actual | cumulative |
|---|---|---|---|---|
| 2026-08-06 | verdict-robustness re-run (sonnet+mini judges, persistent db; before $45.3997 → after $45.0294 remaining) | $2.00 cap | $0.3703 (OpenRouter share) | $4.9706 / $50.00 (OpenRouter) |
| 2026-08-06 | same run, OpenAI side (nano answerer + mini judge) | — | ~$0.03 | ~$0.22 (OpenAI key) |

---

## G1.2 — Org-scoped trace clustering (session 2026-08-06, plan approved)

Hybrid design: cluster id = agent-<orgHash6>-<slug6>[-N] (sha1(orgId)[:6] — SUITE_ID_RE-
clean, fixed-arity, non-identifying on public surfaces; prefix partitions frontiers/eval
evidence/suite dirs with zero schema change on those tables) + clusters.org_id NULL
column (0020; NULL = platform/taxonomy) for ownership checks that never parse ids.
Fixes bundled: (org,trace) grouping kills the cross-org trace-id merge; SQL org predicate
kills the 500-trace starvation; nightly {} run loops distinct orgs (no pooling);
exemplar top-up + exemplarCount update on existing clusters; X-Potion-Cluster cross-org
→ same 400 cluster_not_found (no existence oracle); /api/frontiers stops listing other
tenants' clusters. Pre-G1.2 agent-* rows grandfather as NULL (demo artifacts; operators
may delete). Per-org FRONTIERS proper remain G1.6.

- [x] a. db: 0020 + clusters.org_id; listTracesForClustering org predicate + (org,trace)
      grouping; listClusters({orgId?}) + getClusterByIdForOrg; tests
- [x] b. workers: per-org nightly loop, (org,slug) buckets, hashed ids, exemplar top-up;
      e2e rewrite (the old test encoded the pooling defect as intended)
- [x] c. server: hint ownership check (contract-preserving 400), /api/frontiers scoping;
      tests incl. cross-org matrix
- [x] d. full sweep + walkthrough + two-org manual proof + docs + commit

**G1.2 DONE (2026-08-06)** — clusters are tenant data now: (org,trace) grouping kills the
cross-org trace-id merge; SQL org predicate + per-org nightly loop kill starvation and
pooling; cluster ids agent-<orgHash6>-<slug6> partition frontiers/eval evidence/suite
dirs for free (SUITE_ID_RE-clean, non-identifying publicly); clusters.org_id (0020)
backs ownership checks — X-Potion-Cluster cross-org returns the same 400 as unknown (no
existence oracle), /api/frontiers lists platform + own only. Exemplar top-up bug fixed
(pre-G1.2: exemplars written only at creation, count never updated). Pre-G1.2 agent-*
rows grandfather as platform (demo artifacts; operators may delete). The old workers e2e
encoded the pooling as intended behavior — rewritten. 916 pnpm tests green (db 77,
workers 28, server 308), walkthrough 15/15 (org-hashed id visible: agent-26a426-bc5772).
Zero live API calls. Per-org FRONTIERS proper remain G1.6; suite lifecycle is G1.3 (next).

---

## G1.3 — Derived-suite db storage + retention (session 2026-08-06, plan approved)

Storage decision: DATABASE (artifact store has no get/delete/list; db gives read-back-
merge, org attribution, transactional version bumps, retention deletes). Discriminator:
agent- prefix (authored suites stay repo files). derived_suites provenance rows carry the
org id disk manifests never had; derived_suite_items carry source_trace_id + created_at
so retention can purge by time window. Purge: days>0 deletes items past cutoff; days=0
empties items, keeps provenance stub. STANDING DECISION (recorded, deferred to G1.6):
frontiers/eval_results built from purged items are NOT cascade-deleted — mock-only +
provenance-guarded today; evidence-retirement policy belongs to the per-org frontier
rework. Dead eval_items table noted, untouched. Cache-key/version comment corrected
(per-item keys already make appends incremental).

- [x] a. db: 0021 + derived_suites/derived_suite_items + repo (upsert/load/list/purge)
      + tests (merge/cap/version/purge-window/cascade)
- [x] b. harness: runner loader split (agent-* from db via crossCheckItem, authored from
      files, clear error without db) + tests
- [x] c. workers: cluster write path → repo upsert; purge hook (+result counts); tests
      file-assertions → db queries
- [x] d. server test env cleanup + walkthrough copy removal + full sweep + proof + docs
      + commit

**G1.3 DONE (2026-08-06)** — derived suites in governed db storage (0021):
org-attributed provenance rows (the disk manifests never carried an org),
time-windowed items (source_trace_id/created_at), merge/cap/version semantics
preserved exactly. Retention: purge deletes items past the span cutoff;
retention-0 empties items but keeps the provenance stub. Runner loads agent-*
ids from db through the same crossCheckItem gate; authored suites stay repo
files. Walkthrough's suites-copy protection removed (no file writes remain).
STANDING DECISION (deferred to G1.6, recorded): frontiers/eval_results built
from purged items are NOT cascade-deleted — mock-only + provenance-guarded
today; evidence-retirement policy belongs to the per-org frontier rework.
Dead eval_items table noted, untouched. 921 pnpm tests green (db 80, harness
140, workers 28), walkthrough 15/15. Zero live API calls.

---

## G1.4 — Replay fidelity + reference-anchored judging (session 2026-08-06, plan approved)

Ingest conventions (zero schema change, documented): gen_ai.completion (final answer,
last-wins), tool.result, multiple gen_ai.prompt spans = ordered user turns — all PII-
redacted at ingest (judge anchors on REDACTED references; rubric says placeholders match
equivalents). Read model gains turns/referenceAnswer/toolTranscript. Synthesis: multi-
turn prompt + tool-transcript system message + redacted reference (graceful when absent).
Judge builder: REFERENCE block BETWEEN TASK and ANSWER (mock extractor constraint),
gated + wrapped; estimator picks it up automatically (measured scaffolding; M1b delta
$0). Calibration: judgeView STRIPS reference by default (comparability with recorded
r/ρ); --reference-anchored keeps it (replay parity). LIVE anchored calibration proof
against the 0.54/0.44 reference-free baselines.

- [x] a. harness: builder REFERENCE block + calibrate strip/anchored + CLI flag + tests
- [x] b. db: read model (turns/reference/toolTranscript) + tests
- [x] c. workers: synthesis (multi-turn/system transcript/reference, rubric) + fixtures
- [x] d. server/walkthrough fixtures + SPEC §14.1 + route comment
- [x] e. full sweep + mock proof + LIVE anchored calibration (cap $2, ledger) + docs +
      commit

**G1.4 DONE (2026-08-06)** — replay fidelity + reference-anchored judging. Ingest
conventions (SPEC §14.1, zero schema change, all PII-redacted at ingest):
`gen_ai.completion` = final session answer (last in ts order wins), `tool.result`
sibling of `tool.args`, multiple `gen_ai.prompt` spans = ordered user turns. Read model
(TraceClusterSource) gains turns/referenceAnswer/toolTranscript; synthesis builds
multi-turn prompts + a tool-transcript system message (capped 2000 chars) + the redacted
reference; rubric instructs comparative judging + placeholder-equivalence semantics.
Judge builder: REFERENCE block BETWEEN TASK and ANSWER (mock-extractor constraint),
gated on item.reference, untrusted-wrapped, non-string refs JSON-stringified; estimator
picks the block up automatically (measured scaffolding; M1b regression delta $0 — no
recorded item carries a reference). Calibration strips references by DEFAULT
(comparability with recorded reference-free r/ρ); `--reference-anchored` opts in.
Serve-path judging reference-free by construction. End-to-end: server + walkthrough
fixtures now carry completions/tool results → derived items with references verified in
both. 925 keyless tests green; walkthrough 15/15.

**LIVE VERDICT — the anchored thesis is PROVEN** (extraction-potion-v2, n=50, answerer
gpt-nano, judge budget 768, provider_mode=live, persisted ×2):
- judge-class (sonnet-4.5): pearson-vs-truth **0.948**, spearman **0.967**, mAE 0.028 — OK
- gpt-mini-class: pearson **0.843**, spearman **0.936**, mAE 0.034 — OK
- cross-judge agreement 0.821
vs reference-free baselines on the SAME suite: judge-class 0.544/0.676, gpt-mini 0.439.
Reference-anchored judging clears the 0.8 contract bar — first configuration to do so.
Both judges OK (no flag, exit 0). This is the configuration replay judging uses in
production (replay items carry references; serve-path items don't and stay
reference-free/uncontracted). Note: truth remains ceiling-compressed (34/50 at 1.0) —
the anchored r is measured on the same narrow band that suppressed the reference-free
scores, which strengthens, not weakens, the comparison.

| date | run | projected | actual | cumulative |
|---|---|---|---|---|
| 2026-08-06 | LEDGER RECONCILE pre-run: authoritative OpenRouter usage $4.9866 (ledger said $4.9706; ~$0.016 drift) | — | — | $4.9866 / $50.00 (OpenRouter) |
| 2026-08-06 | G1.4 anchored calibration, extraction-potion-v2 n=50 (sonnet judge via OpenRouter; before usage $4.9866 → after $5.3020) | $2.00 cap, harness projection under cap | $0.3153 (OpenRouter share of $0.3633 total) | $5.3020 / $50.00 (OpenRouter) |
| 2026-08-06 | same run, OpenAI side (gpt-nano answerers + gpt-mini judge) | — | ~$0.048 | ~$0.24 (OpenAI key, usage-priced) |

---

## G1.5 — Per-cluster rubric generation + probe calibration + review (session 2026-08-06, plan approved)

Every rubric is a hardcoded literal today; the replay-suite rubric templates only the
tool sequence and ignores the exemplars sitting next to it. G1.5: generate the rubric
per cluster FROM exemplars (one capped, metered, admin-triggered LLM call), calibrate
the result with PERTURBATION-PROBE truth built from G1.4 references (reference=1.0,
50%-truncation=0.5, deranged-mismatch=0.0 — llm-judge items have no deterministic
truth, so truth is constructed; answererModel='synthetic-perturbation' keeps these
rows distinct from G0.2 records; mAE advisory, flag on r/rho), and gate USE behind a
customer-visible review step. Rubric identity becomes real: rubric_hash on
judge_calibrations + rubric component in the eval cache key (one-time llm-judge cache
invalidation, deliberate). Approve = transactional: demote prior approved →
superseded, restamp the suite's items to the new text (homogeneous suites). OWNER RULE
(also in lessons.md): customers see everything derived from their data, always paired
with status + evidence — drafts/rejections visible, unmistakably labeled NOT IN FORCE,
rejected rows keep their failure reason. Serve-path rubrics, rubric-cause staleness on
eval_results (recorded follow-up), and scale unification are non-scope.

- [x] a. db: 0022 cluster_rubrics (status_reason, partial unique approved index) +
      judge_calibrations.rubric_hash + repos (insert/list/approve/reject/restamp) +
      usage rollup 'rubric_gen' + tests
- [x] b. harness: buildRubricProbes + runRubricProbeCalibration + probe preflight +
      cacheKeyOf rubric hash + cli rubricHash + tests
- [x] c. workers: rubric:generate handler (env-gated provider, hardened output,
      chained probe calibration, rubric_gen metering, org isolation) + synthesis
      pickup of approved rubric + e2e tests
- [x] d. server routes (generate/list/approve/reject) + dashboard /rubrics page +
      admin island + tests
- [x] e. full sweep + walkthrough extension + mock proof + LIVE leg (cap $2, ledger)
      + docs + commit

**G1.5 DONE (2026-08-07)** — automated scorer construction. Storage: 0022
cluster_rubrics (status pending|approved|rejected|superseded + status_reason as
FIRST-CLASS data; partial unique index = at most one approved per cluster) +
judge_calibrations.rubric_hash. Generation: rubric:generate (admin-only, never
nightly) — one capped LLM call over untrusted-wrapped redacted exemplars;
output hardened (fence-strip, 80–2000 chars, marker/header/control-char
rejection = job failure, no fallback row); metered as request_logs
'rubric_gen' (rollup: cost only). Probe calibration: constructed truth from
G1.4 references (verbatim=1.0 / 50%-word-boundary-truncation=0.5 / seeded
rotation-derangement mismatch=0.0), 3n judge calls, no answerer leg, own
preflight; answererModel='synthetic-perturbation'; <3 referenced items →
uncalibrated pending rubric with reason. Review: /api/rubrics +
/rubrics dashboard page — every row pairs full text with status badge
(only approved renders IN FORCE) + calibration verdict; reject REQUIRES a
reason; rejected/superseded rows stay listed. Approve = transaction: demote
prior approved → superseded + restamp suite items homogeneous; synthesis
prefers the approved rubric (template fallback). Rubric identity: cache key
gains rubric-hash component for llm-judge items (one-time invalidation,
deliberate); CLI calibrations record rubricHash. 943 keyless tests green
(+18); walkthrough 15/15 (step 13 extended: generate → draft NOT-in-force →
approve → restamp → /rubrics renders).

**LIVE LEG (cap $2, actual $0.0664 on the successful run)** — seeded 4-session
billing-agent cluster (script packages/workers/scripts/g15-live-rubric.ts,
db .pglite/rubric-g15): sonnet (judge-class) generated a genuinely
cluster-specific 6-criterion rubric ($0.0048); live probe calibration
r=0.793 / rho=0.831 / mAE 0.171 (advisory), n=12 — honestly FLAGGED (r a
hair under the 0.8 line on a 4-item corpus; rho clears it). Approve →
restamped 4 items homogeneous. Both rubric_gen request_logs rows verified.
Live-leg findings hardened into code + tests:
1. classRepresentative picks the CHEAPEST class member → 'live' mode
   resolved to mock-judge ($0) and produced word-bank text labeled live.
   Fixed: excludeProvider('mock') in live mode + regression test (keyless
   live run must FAIL, never silently mock).
2. Sonnet ignores character bounds (wrote ~1300 chars under a 1200 cap,
   twice) → validation rejected honestly both times. Guard widened to 2000
   (anti-smuggling bound, not typography); prompt now instructs ~1000.

FOLLOW-UPS (recorded): rubric-cause staleness on eval_results (schema
change); serve-path rubric remains platform-global by design; probe truth
mid-anchor (50% truncation) revisit only if live r lands gray-zone 0.6–0.8
on larger corpora.

| date | run | projected | actual | cumulative |
|---|---|---|---|---|
| 2026-08-07 | LEDGER RECONCILE pre-run: authoritative OpenRouter usage $5.3315 (ledger said $5.3020; ~$0.03 delayed-accounting drift from the G1.4 run) | — | — | $5.3315 / $50.00 (OpenRouter) |
| 2026-08-07 | G1.5 live leg ×3 attempts (mock-alias bug $0; rejected-overlong gen ~$0.005; successful run $0.0664 = gen $0.0048 + probe judging $0.0616; sonnet via OpenRouter; before usage $5.3315 → after $5.3870) | $2.00 cap | $0.0555 (authoritative delta; endpoint lags ~$0.016) | $5.3870 / $50.00 (OpenRouter) |
| 2026-08-07 | OpenAI side | — | $0 (no OpenAI calls this item) | ~$0.24 (OpenAI key, unchanged) |

---

## G1.6 — Per-org frontiers with schema-level provenance (session 2026-08-07, plan approved)

Frontiers/eval evidence go per-org (org_id NULL=platform, org-preferred reads with
platform fallback — load-bearing for the walkthrough's fresh org), the saveFrontier
read-then-insert race gets a real fix (NULLS NOT DISTINCT unique + transactional
insert + bounded retry), and — the owner's headline — provenance becomes SCHEMA-LEVEL:
every frontier point carries a FrontierPointEvidence object (eval_results cacheKeys,
runIds, n, ci95, suiteId+version, approved rubricHash, calibrationId) in the serving
jsonb AND mirrored on frontier_points. Carried points keep their ORIGINAL evidence
verbatim (honest audit across rubric supersessions). Evidence retirement (G1.3
standing decision) RESOLVES as staleness-plus-immediate-recompute, never delete.
Share + leaderboard stay platform-pinned (owner decision); public DTOs strip
evidence. Detail-route cross-org read gap closes (uniform 404). No live leg — every
G1.6 writer is mock until G1.7.

- [x] a. db+core: 0023 (org_id ×4, evidence jsonb, backfill-before-index, unique +
      read indexes) + repos (tx insert, scope-exact latest, org-preference read,
      retireEvalResultsByItemIds, listClusters platformOnly) + FrontierPointEvidence
- [x] b. harness+pareto: evidence built in aggregateResults, passed through
      aggregateToPoint/carried points; saveFrontier opts+retry; recompute org
      predicate; tests (race, round-trip, org-fallback, isolation)
- [x] c. workers: cluster handler org+provenance ctx; evalRun org column; purge
      retirement (stale + immediate recompute + empty-version fallback) + e2e
- [x] d. server: org threading (chat/parity/playground/dashboard), detail 404,
      leaderboard pin, share comments + DTO strip + route tests
- [x] e. full sweep + walkthrough + docs (retirement decision resolved at both
      recorded sites) + commit

**G1.6 DONE (2026-08-07)** — per-org frontiers with schema-level provenance.
Migration 0023: org_id (NULL=platform) on frontiers/frontier_points/eval_runs/
eval_results with backfill-before-index (pre-G1.6 org rows attributed via
clusters.org_id — without it the new predicates would silently orphan them);
(org, cluster, version) unique NULLS NOT DISTINCT + transactional insert +
bounded 23505 retry kills the saveFrontier read-then-insert race (test: two
concurrent saves land v1/v2 with a valid chain — the old code forked the
chain silently). Version chains are SCOPE-EXACT (org v1 is parent-null).
Reads are org-preferred with platform fallback; omitted orgId PINS platform,
so share links + leaderboard are platform-only by DEFAULT (owner decision),
with the leaderboard's cluster list additionally pinned platformOnly (it
previously iterated every tenant's clusters — G1.7's live org frontiers
would have leaked cross-tenant). Detail route now 404s cross-org agent
clusters uniformly (closed a live G1.2-era read gap).

PROVENANCE (owner headline): FrontierPointEvidence {cacheKeys, runIds, n,
ci95, suiteId, suiteVersion, rubricHash, calibrationId} flows
aggregateResults → aggregateToPoint → saveFrontier(provenance ctx stamped
only where absent) → serving jsonb + frontier_points mirror. Carried points
keep their ORIGINAL evidence verbatim (honest audit across rubric
supersessions). Authed detail surface returns evidence per point (the
guarantee report's raw material); public share/leaderboard DTOs omit it.

EVIDENCE RETIREMENT (resolves the G1.3 standing decision, both recorded
sites updated): purge → retireEvalResultsByItemIds (stale, never delete —
tombstone cacheKeys stay auditable) → IMMEDIATE recompute of affected org
frontiers (clustering alone never re-saves after a purge); full retirement
saves an empty version and serving falls back to platform.

Evidence org-tagging: RunOptions.orgId stamps eval_results/eval_runs
(eval_runs.org_id is a real column now, not an options-jsonb smuggle);
aggregatesFromEvalResults isolates org vs platform both ways. G1.7 FLAG
(recorded): the eval cache key needs an org component if orgs ever eval
SHARED suites (safe today — org evidence only comes from org-partitioned
agent item ids). 954 keyless tests green (+11); walkthrough 15/15 (fresh-org
platform fallback is load-bearing and exercised by steps 3/6/share). NO
live leg — every G1.6 writer is mock until G1.7; $0 spend.
