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

## Naming (2026-09-04, operator directive — read docs/NAMING.md)

**Potion is a COMPILER, never a router — internally and externally.** Tagline:
*The Compiler for Inference*. A router picks a road; a compiler designs the
route. What Potion emits, per org and versioned, is the **plan** (shipped as
the model id `potion/<org>`). Storage and wire spellings (`router_versions`,
`routerVersion`, `/api/router`, `compileAndMintRouter`) are deliberately NOT
renamed — `docs/NAMING.md` says why and lists them.

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
SELF-SERVE (2026-09-02, b1504a3 "the front door matches the distribution
push"): signup is open in production — any email provisions an org. The
operator path (hand-issued keys via POST /operator/orgs) remains for
partners; it is no longer the default or the only way in. Billing is still
invoiced (Stripe rails implemented, charging off until the live-key test).

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
2. [RESOLVED 2026-08-07] Frontiers/eval evidence are PER-ORG as of G1.6:
   org_id (NULL=platform) on frontiers/frontier_points/eval_runs/
   eval_results; reads org-preferred with platform fallback (share +
   leaderboard PINNED platform by owner decision; detail route now 404s
   cross-org agent clusters); saveFrontier race fixed (scope-exact unique
   NULLS NOT DISTINCT + tx insert + retry); SCHEMA-LEVEL PROVENANCE (owner
   rule): every frontier point carries evidence (eval cacheKeys, runIds, n,
   ci95, suite id+version, approved rubricHash, calibrationId), carried
   points keep originals verbatim, public DTOs strip it. Evidence
   retirement on purge RESOLVED: stale-never-delete + immediate recompute,
   empty frontier → platform fallback. Live org evals (G1.7, 2026-08-07):
   frontier:live-sweep — env-gated, ownership-checked, org-budget-refused
   FAIL-CLOSED before spend, key-availability-filtered live class reps,
   spend metered as request_logs 'eval_live' (budgets/invoices inherit via
   the rollup chokepoint); cache key gained `|org:`/`|live` suffixes
   (resolved flag — live never cache-hits mock, orgs never share evidence);
   runner gained judgeMaxTokens/judgeModelOverride/MockAliasInLiveRunError;
   "once live, never regress" taint rules at both recompute sites. Live org
   frontiers are servable via the org-preferred read + provenance guard.
   Trace clustering has been org-scoped since G1.2
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
   Rubrics (G1.5, 2026-08-07): per-cluster rubrics GENERATED from redacted
   exemplars (rubric:generate — admin-triggered, capped, metered as
   request_logs 'rubric_gen'), probe-calibrated against constructed truth
   from G1.4 references (reference=1.0 / 50%-truncation=0.5 / deranged
   mismatch=0.0; answererModel='synthetic-perturbation'; mAE advisory, flag
   on r/rho), and gated behind a customer-visible review surface
   (/rubrics + /api/rubrics): only an APPROVED rubric is in force (partial
   unique index), approval restamps the suite homogeneous, rejections stay
   listed with their reason. Rubric identity is real: rubric_hash on
   judge_calibrations + rubric component in the eval cache key. OWNER RULE
   (lessons.md): customer-derived artifacts always ship with status +
   evidence attached. STILL OPEN: rubric-cause staleness on eval_results
   (needs schema change — recorded follow-up); serve-path rubric stays
   platform-global by design.
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
  results, multi-turn (G1.4); (8) [DONE 2026-08-06]
  automated scorer construction: per-cluster rubric generation +
  probe calibration + customer review (G1.5); (9) per-org frontiers [ARCHITECTURE: org_id NULL=platform +
  fallback-to-global; ~7 loadCurrentFrontier sites; org-scoped recompute];
  (10) [DONE 2026-08-07] live capped evals of customer suites (G1.7);
  (11) [DONE 2026-08-07] researcher per-org refresh (G1.8: org cycles over
  owned derived suites, gate.ts unchanged, recipe_status stays platform,
  cycle/lineage surfaces tenant-scoped). PHASE G1 COMPLETE.
- **Phase G2 — guarantee as product surface** (owner-reordered 2026-08-07;
  queue of record G2.7 → G2.1 → G2.2 → G2.3 → G2.4 → G2.6 → G2.8 → G2.5):
  (17-FIRST) [DONE 2026-08-07] operator onboarding + TRUE-CASCADE org
  deletion (G2.7: fail-closed POTION_OPERATOR_TOKEN /operator/* surface,
  self-serve auto-provision gated behind POTION_SELF_SERVE, deleteOrgCascade
  across 26 tables with per-table report, walkthrough step 14 proves
  create → pipeline → delete → nothing derived survives; runbook
  docs/ONBOARDING-RUNBOOK.md);
  (12) [DONE 2026-08-07] customer-visible guarantee report (G2.1: incumbent
  designation as the retention baseline, TRUST HIERARCHY — advisory serve
  leg / contractual suite leg via guarantee:suite-verify, retention
  headline report + monthly artifact + CLI, completion-id correlation,
  serve-path judgeMaxTokens stray closed; walkthrough step 15); (13) [DONE 2026-08-08] incident SLAs (G2.2: measured
  breach→notification latency bound to the advisory clock, starved
  verification — durable attempt ledger + sweep retries + once-only
  'guarantee_unverifiable' escalation + report 'currently unverifiable'
  state, confident-recovery auto-restore with time-bounded
  recovery-unconfirmed escalation, worsening re-fire, in-process parity
  emit; walkthrough step 16); NOTE the role-split item ("serving keys must
  NOT resolve incidents") moved to G2.3 where it belongs; [DONE 2026-08-08]
  G2.3 key role split: api-key role derives from scopes (serve → member,
  serve+admin → admin, FAIL CLOSED on unknown values); exhaustive
  route-inventory fixture (apps/server/src/security/route-inventory.ts —
  all routes classified, completeness-diffed, 27 admin routes probed per-key;
  G2.4 extends the same fixture with its lenses); walkthrough step-16 leg;
  [DONE 2026-08-08] G2.4 exhaustive tenancy sweep +
  mock-eligibility audit: 14 defects fixed (cross-tenant demo-org fallback,
  platform-job leakage, global rollup rewrite, cycle-lineage leak, four
  false-live sites incl. the FIRST on the serving path, three posture items,
  three uuid-param crash/oracles found by the sweep); route inventory gains
  the tenancy lens + a cross-org probe suite (both credential kinds, four
  input classes); grep-derived mock-eligibility inventory with its own
  completeness meta-test; committed diligence exhibit
  artifacts/tenancy-classification.md; (14) targeted server tests on the serving
  hot path incl. the mock-eligibility audit of every provider-resolution
  site; (16) compound policy: quality floor + latency bound in one policy;
  (G2.8 CAPSTONE) [DONE 2026-08-09] one real workload end-to-end: 48 Claude
  Code subagent sessions → converter (scrub-then-truncate, --verify-scrub) →
  ingest → 7 clusters (real embedder @0.2; the toy embedder @0.62 fragmented
  the same corpus into 30) → 23-item derived suite → live rubric + probe →
  live org frontier → incumbent → suite-verify **contractual-breach, retention
  0.2707 CI95 [0.1754, 0.3743], 23 pairs, floor 0.9**, confidence LOW
  structurally (confidenceFor's line is 30; a cluster cannot exceed its
  tool-signature bucket). SIX defects found: tool signature unusable on real
  agents (45 sigs/48 sessions), verify-scrub flagging its own placeholders,
  truncate-before-scrub leaking key fragments, verifier scanning serialized
  JSON, the G0.5 threshold fix never reaching agent clustering, correlation
  CIs persisted at one of two sites. Parameter report
  artifacts/g28-parameters.md — notably REFUSES switching the judge gate to
  Spearman: the point estimates argue for it (r 0.605 fails / rho 0.811
  clears) but the intervals show rho STRADDLES the bar. POST-CAPSTONE QUEUE:
  (1) per-call metering — BLOCKS design-partner traffic (60% of capstone
  spend never reached request_logs; must carry provider and reconcile both
  directions); (2) step-level item synthesis — session-level replay is
  RECORDED INVALID for agentic workloads (live means 0.2000/0.0491/0.0000,
  frontier collapsed to 1 point of 3); (3) incumbent self-retention as a
  suite-validity gate, certified on the review surface like rubrics;
  (4) swarm adversarial pass; (15-LAST, deferred)
  Redis rate limiting + shared caches — only incorrect across replicas,
  build when deployment demands it (seam documented).
- **DEMOTED indefinitely:** public model/pricing page, catalog breadth,
  SDK publishing, cloud-KMS custody (BYOK works), Stripe (LAST; invoiced
  billing already works — `pnpm --filter @potion/server invoice`).
  NO LONGER DEMOTED: the self-serve signup funnel SHIPPED 2026-09-02 and is
  on in production, and SMTP is live via Resend — both were listed here as
  indefinitely deferred for eight days after the decision that reversed
  them, which is how a Sept 5 audit came to file the open signup default as
  a defect. This product is self-serve.
- **Potion Lab (L0–L6, paper-only, gated behind Gate B):** the
  harness-builder product line — see `docs/LAB-ROADMAP.md` (assumption
  verification: `docs/LAB-ROADMAP-VERIFICATION.md`). Build ladder:
  `docs/LAB-BUILD-PLAN.md` (Steps 1–17, operator-stepped, spec-then-build
  per step; status ledger `docs/LAB-BUILD-STATUS.md`). No Lab code before
  the operator names the step; Gate A (deployment) is unchanged and first.

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
