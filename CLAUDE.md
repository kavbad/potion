# Potion — Claude Code project context

Potion sells a QUALITY GUARANTEE behind an OpenAI-API-compatible endpoint:
a customer supplies real traffic; we build a quality/cost Pareto frontier
for THEIR workload over models AND compositions (single, cascade, best-of-n,
draft-verify, …); they set a policy floor ("quality ≥ 0.9, then minimize
cost"); we serve, continuously measure rolling quality, and treat breaches
as first-class incidents. pnpm monorepo; Fastify server (`apps/server`),
Next dashboard (`apps/dashboard`), packages for providers/strategies/
harness/cluster/pareto/db/workers/etc. Repo: `~/Projects/potion` (git;
history starts at the M1b-complete baseline commit).

## Positioning (2026-08-06)

Potion is a quality guarantee, not a router. Generic selection is a free
incumbent's game: OpenRouter's Auto Beta (task classification + cost-quality
dial on community-popularity signals) and coding "Pareto Router" (third-party
benchmark percentiles) ship at 100T tokens/month scale. We do not compete
there. We sell what they structurally lean away from:

1. First-party MEASURED quality — they route on popularity and benchmark
   proxies; we score real outputs and put a number in the contract.
2. Per-customer workload measurement — nothing of theirs evaluates on the
   customer's actual traffic; our frontier is built from it.
3. Compositions — every OpenRouter router picks ONE model per request; the
   M1b sweep shows compositions creating frontier points no single model
   reaches (agentic-tool-use: cascade 0.943 @ $6.85/1K vs sonnet 0.957 @
   $19.31/1K — 98.5% of the quality at 35% of the cost).

Product loop: customer traffic in → per-customer frontier over models AND
compositions → policy floor (`min_cost(qualityFloor)` is the flagship shape,
already implemented in core/select.ts) → OpenAI-compatible endpoint →
continuous rolling quality measurement → breach ⇒ first-class incident.
Sales-assisted, design-partner-first: hand-issued keys, invoiced billing
(Stripe deliberately absent).

## State as of 2026-08-06

- 875 pnpm tests green (13 packages 559 + server 305 + chaos 11) + TS SDK 14
  + python SDK 13. M1b live eval complete (Gate-3 + 8-suite sweep,
  OpenRouter, $3.88 spent). Ledger + execution report: `tasks/todo.md`.
  Committed M1b evidence: `artifacts/` (regression-test fixture).
- Cost estimator fixed (commit c248d74): projections now DOMINATE actuals by
  construction — max_tokens enforced on every live transport, protocol calls
  capped at PROTOCOL_MAX_TOKENS, per-suite output ceilings
  (SUITE_OUTPUT_CEILINGS), domination regression-tested against the recorded
  M1b sweep ($12.99 projected vs $3.37 actual).
- Honest-stub convention: unbuilt paths throw loudly or self-label
  (Stripe backend, SMTP, cloud-KMS, python scorer). Preserve this. Never
  add a silent fallback or a mock that impersonates live output.

## Known defects / debt (verified 2026-08-06 exploration)

1. Guarantee measurement is now real AND statistically defensible (G0.1 +
   G0.3, 2026-08-06): sampled answers judge-scored (serve-judge, spend
   metered); breaches fire only on a seeded bootstrap CI95 upper bound
   below the floor, on strictly-keyed (org, policy, cluster, strategy)
   evidence incl. error-path quality-0 samples; verdicts re-derivable from
   the incident detail (ci95/seed/resamples); configurable minSamples
   (floor 5). Judge-trust calibration (G0.2, 2026-08-06): judges calibrate
   against DETERMINISTIC ground truth, preflight-capped, persisted to
   judge_calibrations (staleness-correct keys), surfaced per policy on
   /api/guarantee/status, flagged calibrations exit 3. Live G0.2 findings on
   record: gpt-5-class REASONING judges are unusable under
   PROTOCOL_MAX_TOKENS=128 (reasoning eats the completion budget → empty
   output, parse 0); current n=12-30 suites yield (near-)constant truth with
   competent answerers → INDETERMINATE calibrations (G0.5 suite scaling is
   the fix); gpt-4.1-mini as judge rubber-stamps ≈1.0. STILL OPEN:
   `shadow:judge` remains `{stub:true}` and shadowScore is still
   Jaccard-vs-primary (labeled); /v1/completions parity route has NO
   guarantee wiring; sampling is uniform (no per-stratum quotas); no serving
   gate on calibration state (surfaced only). Serving API keys hold role
   `admin` and can resolve incidents — lift their own rollback (G2.3).
2. Frontiers/eval evidence remain GLOBAL by design contract (per-org
   frontiers = G1.6). Trace clustering is org-scoped as of G1.2
   (2026-08-06): per-org nightly loop, (org,trace) grouping, cluster ids
   agent-<orgHash6>-<slug> partition agent frontiers/suites for free,
   clusters.org_id ownership checks (hint + /api/frontiers). Synthesized
   agent suites are still mock-evaluated only and can never serve live
   (provenance guard, correctly). Derived suites moved to governed db
   storage with retention tied to trace retention (G1.3, 2026-08-06);
   evidence-retirement on purge is a recorded G1.6 decision. Replay
   fidelity (G1.4, 2026-08-06): ingest conventions gen_ai.completion
   (final answer, last-wins) / tool.result / multi gen_ai.prompt turns
   (SPEC §14.1, all PII-redacted at ingest); derived items carry the
   redacted original answer as `reference`, user turns as separate
   messages, and a tool-transcript system message; the judge prompt gains
   a REFERENCE block (between TASK and ANSWER) and judges comparatively
   when a reference exists. Calibration stays reference-FREE by default
   (comparability with recorded r/ρ); --reference-anchored opts in
   (replay parity). Serve-path judging is reference-free by construction.
3. Trace ingestion (G1.1, 2026-08-06): PII redacted AT INGEST via the
   platform redactor (@potion/core redact.ts — card+Luhn/SSN/IBAN/phone/
   JWT/etc., deterministic+idempotent); raw prompts never at rest; backfill
   job traces:redact for pre-G1.1 rows; worker pass kept as defense-in-depth.
   RESIDUAL: names/addresses/narrative PII (NER territory) undetected —
   documented; derived suites still live on worker-local disk with no
   lifecycle (G1.3).
4. Eval suites (G0.5): deterministic clusters scaled — code-gen 60 tiered
   items (permanent sandbox self-pass gate), extraction 50 discriminative,
   classification/multi-step-reasoning/rag-answer 50 each. Gate-2 LIVE:
   96.00% on OpenAI embeddings (POTION_CLUSTER_THRESHOLD=0.2 recommended;
   mock-tuned 0.62 collapses to 6% live — artifacts/m1b-gate2-live.log).
   STILL OPEN: 5 llm-judge breadth suites remain n=14; frontier-capability
   outpaces authored item difficulty (nano solves 56/60 incl. hard tier).
   Judge verdicts on record (extraction-potion-v2, n=50): reference-FREE
   judge-class r=0.544/rho=0.676 — below the 0.8 bar; reference-ANCHORED
   (G1.4) judge-class r=0.948/rho=0.967, gpt-mini 0.843/0.936 — first
   configuration to clear 0.8. Replay judging (items with references) is
   contract-grade; the reference-free SERVE path remains below the bar.
5. 8 pre-existing lint errors (unused imports) block `pnpm verify`.
6. Rate limiting + assignment cache are per-replica in-memory (Redis store
   is a designed seam, `apps/server/src/middleware/ratelimit.ts`).
7. [DONE 2026-08-06] Gate-2 live: 96.00% (see #4).
8. Server has 305 tests but the serving hot path has gaps: guarantee
   override query runs on EVERY request ungated; pre-auth failures logged
   under org_demo; per-request jsonb-path incident queries unindexed.

## Roadmap (guarantee product; owner-ordered)

- **Phase G0 — make the measurement real** (a guarantee on a fake metric is
  fraud, not debt): (1) real judge scoring in the guarantee sampling path —
  live judge, protocol-capped, spend metered against org budgets; replace
  the Jaccard stub; (2) judge trust: calibration against reference-scored
  items + agreement reporting, per-workload; (3) contract-grade breach
  statistics — CI-lower-bound decisions (reuse researcher gate.ts
  bootstrap), stratified sampling incl. error-path, cluster-correct sample
  attribution; (4) [DONE 2026-08-06] cost estimator dominates actuals
  (commit c248d74); (5) Gate-2 live embeddings + suites to 50–100+
  items/cluster.
- **Phase G1 — per-customer workload pipeline:** (6) ingest-time PII
  redaction (real pass, not 3 regexes; raw prompts never at rest) +
  org-scoped trace clustering; (7) [DONE 2026-08-06] derived-suite storage
  with lifecycle (G1.3) + replay fidelity — reference answers, tool
  results, multi-turn (G1.4); (8) automated scorer
  construction: per-cluster rubric generation + calibration on customer
  suites; (9) per-org frontiers [ARCHITECTURE: org_id NULL=platform +
  fallback-to-global; ~7 loadCurrentFrontier sites; org-scoped recompute];
  (10) live capped evals of customer suites; (11) researcher loop → per-org
  refresh (thread suiteV2Ids/suitesV2Dir/org through cycles; gate
  unchanged).
- **Phase G2 — guarantee as product surface:** (12) customer-visible
  guarantee report (quality time series; completion-id column on
  request_logs so quality joins spend/latency); (13) incident SLAs — alert
  on the in-process breach path, breach→notification bound, auto-restore
  semantics, serving keys must NOT resolve incidents (role split);
  (14) targeted server tests on the serving hot path; (15) Redis rate
  limiting + shared caches; (16) compound policy: quality floor + latency
  bound in one policy (none exists today); (17) operator onboarding:
  org-creation route + hand-issued key runbook (invoice CLI exists).
- **DEMOTED indefinitely:** public model/pricing page, catalog breadth,
  self-serve signup funnel, SDK publishing, cloud-KMS custody (BYOK works),
  SMTP (dev-link hand-delivery suffices for partners), Stripe (LAST;
  invoiced billing already works — `pnpm --filter @potion/server invoice`).

## Working conventions (owner's rules)

- Plan mode for any non-trivial task; write the plan to `tasks/todo.md`
  with checkable items and check in before implementing.
- After any correction, add the pattern to `tasks/lessons.md`; review it
  at session start.
- Never mark done without proving it works: run tests, show output, diff
  behavior. Would a staff engineer approve it?
- Simplicity first, root causes only, minimal blast radius. If a fix feels
  hacky, implement the elegant version instead. Don't over-engineer
  simple fixes.
- Fix bugs autonomously from logs/failing tests; don't ask for
  hand-holding.
- Keep the spend ledger in `tasks/todo.md` current for ANY live API run:
  projected vs actual vs cumulative, before and after.

## Commands

- `pnpm install` · `pnpm build` · `pnpm test` (per-package:
  `pnpm --filter @potion/<pkg> test`) · `pnpm verify` (currently fails on
  pre-existing lint) · server: `pnpm --filter @potion/server dev`
  (PGlite + demo seed when DATABASE_URL unset; demo key in
  `apps/server/src/seed.ts`) · evals: `pnpm harness -- --suite-v2 <id>
  --provider <mock|live> --cap <usd> --resume [--max-output-tokens <n>]` ·
  sweep: `pnpm tsx scripts/m1b-sweep.ts --cap <usd> --resume`
- Live runs read `OPENROUTER_API_KEY` (etc.) from env/`.env`; persistent
  results: `DATABASE_URL=pglite://<abs-path>` + `--resume`.
