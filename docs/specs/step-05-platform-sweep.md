# Step 5 spec — Platform live sweep

Phase-one document per the binding protocol. Read before writing: the plan,
the status ledger, `frontierLiveSweepHandler` (handlers.ts:3021-3203 — the
org-scoped job this step generalizes), the platform-scope aggregation default
(`aggregatesFromEvalResults`, pareto/recompute.ts:195-230: orgId absent →
**IS NULL only**), `cacheKeyOf` (harness/runner.ts:251: org segment appended
only when org-attributed), the eval_live chokepoint (`perCallRequestLogSink`,
per-call metering from post-capstone item 1), the F10 delivery guard, and the
F12 history (boot-attribution: platform evidence re-attributed into an org by
re-running data statements — the containment lesson this spec must encode as
a test). Build-phase deviations get recorded here, never silently.

This step is **rule-2 core work**: a new job kind in `packages/workers`, a
platform suite map, and (at most) an additive optional field on frontier
provenance. Zero semantic changes to any existing handler, route, or repo
function; `frontier:live-sweep` (the org job) is untouched. And its build
phase **spends real provider money** — the second half of this spec exists so
the operator approves a cap against a forecast, not a hope.

## What Step 5 delivers

Today the platform frontier layer is 2/10 SIMULATED: the seed computes
platform frontiers for code-gen and extraction from mock evidence, and the
other eight taxonomy clusters have no platform frontier at all. Serving's
fallback — what every org without private frontiers rides — is therefore
either mock-evidenced or absent. After this step: **all ten taxonomy clusters
carry a platform frontier whose latest version aggregates exclusively
live-evidenced rows**, published through the existing save-chain (the mock
seed versions remain as history, superseded, never deleted).

## Coverage definition

### Clusters × suites

All ten taxonomy clusters, each mapped to its committed platform suite. The
map is a constant in the handler with a both-directions completeness test
(the Step 2 discipline: every taxonomy cluster has a mapping; every mapping
resolves to an existing suite with ≥1 items).

| Cluster | Suite | Kind | Items |
|---|---|---|---|
| code-gen | `code-gen-potion-v2` | v2 authored | 60 |
| extraction | `extraction-potion-v2` | v2 authored | 50 |
| classification | `classification.jsonl` | v1 | 51 |
| multi-step-reasoning | `multi-step-reasoning.jsonl` | v1 | 51 |
| rag-answer | `rag-answer.jsonl` | v1 | 51 |
| agentic-tool-use | `agentic-tool-use.jsonl` | v1 | 15 |
| code-review | `code-review.jsonl` | v1 | 15 |
| creative | `creative.jsonl` | v1 | 15 |
| rewrite-edit | `rewrite-edit.jsonl` | v1 | 15 |
| summarization | `summarization.jsonl` | v1 | 15 |

338 items total. Noted honestly: v1 and v2 suites use different-generation
scoring, so quality numbers are not comparable **across** clusters — which is
fine, because frontier points only ever compete **within** a cluster.

### Candidates per cluster

- **Three single-model points** — the registry's live class representatives
  for `cheap`, `mid`, `strong` (`classRepresentative`, exactly the org
  sweep's mechanism, key-reachability filtered, `MockAliasInLiveRunError`
  backstopped). Singles are non-negotiable per cluster: the tool-bearing
  partition and every composite's dominance analysis need pure single-model
  coordinates to compare against.
- **One composite** — `cascade` cheap→strong. It gives the frontier its
  interior (the cost/quality trade the product sells). Build-phase
  verification item: confirm the cascade's `confidenceMethod` is valid for
  the live representatives (the m1b sweep precedent); if calibration for
  `self-report-calibrated` is missing on a live model, record the deviation
  here and run `logprob` or drop the composite for that cluster — never
  silently substitute.

Deliberately bounded: no draft-verify, no best-of-n in this sweep. Each
added candidate multiplies the frontier-class spend line (see table); the
operator can commission more candidates as a later, cheaper incremental sweep
— cached cells make re-runs pay only for the new candidate.

## Projected spend — BEFORE any live call

### Ceiling model (fail-closed: caps, not hopes)

Per-cell upper bound = answer(in ≤ 1000 tok, out = the 1600-token
`LIVE_SWEEP_ANSWER_MAX_TOKENS` ceiling) + judge(in ≤ 3200 tok, out = the
768-token `LIVE_SWEEP_JUDGE_MAX_TOKENS` ceiling), at `prices.json` class
rates (cheap = gpt-mini-class $0.4/$1.6 per 1M, mid = haiku-class $1/$5,
strong = frontier-class $15/$75, judge-class $3/$15). Cascade bound assumes
**every** item escalates (both stages run).

| Cell | Ceiling |
|---|---|
| cheap single | $0.0241 |
| mid single | $0.0301 |
| strong single | $0.1561 |
| cascade cheap→strong | $0.1591 |
| **per item, all 4 candidates** | **$0.3694** |

**Empirical anchor:** the mid cell bound ($0.0301) reproduces the repo's own
measured constant — `SUITE_VERIFY_CAP_PER_CELL_USD = $0.03`, set with ~25%
headroom over the $0.024/cell actually metered in the G2.8 capstone at these
identical knobs. The model is calibrated against our own meter, not vendor
marketing. Expected actuals run well under ceilings (answers rarely fill the
output cap; cascades don't always escalate); the operator approves the
ceiling.

### Per-cluster ceilings, three tiers

| Cluster | Items | Tier A: full | Tier B: sample 15 | Tier C: 15, singles only |
|---|---|---|---|---|
| code-gen | 60 | $22.16 | $5.54 | $3.15 |
| extraction | 50 | $18.47 | $5.54 | $3.15 |
| classification | 51 | $18.84 | $5.54 | $3.15 |
| multi-step-reasoning | 51 | $18.84 | $5.54 | $3.15 |
| rag-answer | 51 | $18.84 | $5.54 | $3.15 |
| agentic-tool-use | 15 | $5.54 | $5.54 | $3.15 |
| code-review | 15 | $5.54 | $5.54 | $3.15 |
| creative | 15 | $5.54 | $5.54 | $3.15 |
| rewrite-edit | 15 | $5.54 | $5.54 | $3.15 |
| summarization | 15 | $5.54 | $5.54 | $3.15 |
| **Total ceiling** | 338 | **$124.86** | **$55.41** | **$31.55** |

- **Tier A — full**: every item, all four candidates. Frontier-class output
  ceilings dominate (~85% of the bound is the strong single + cascade
  escalation). Maximum statistical weight on the three 51-item and two
  authored suites.
- **Tier B — sampled (recommended)**: deterministic 15-item sample per
  cluster (items sorted by id, first N — byte-stable, so cache keys are
  stable and a later Tier A top-up pays only for the unsampled items).
  Per-cluster sub-cap **$6**, total cap **$60**. Uniform per-cluster sample
  size also makes cross-candidate comparisons equally powered everywhere.
- **Tier C — minimum honest**: singles only, 15 items. Produces valid
  frontiers with no interior points; the composite value proposition stays
  unmeasured. Per-cluster sub-cap $3.50, total $35.

I recommend **Tier B**. Pushback recorded against the obvious cost lever:
shrinking `maxOutputTokens` for the strong class only would cut the bound
nearly in half, but per-candidate ceilings change what is being measured
(quality depends on room to answer) — uniform ceilings or sampling, never
asymmetric ceilings.

**Drift check (build phase, before any live call):** leg 0 re-derives the
projection with the repo's own estimator (`runEval`'s G0.2 projection
preflight) per cluster and prints it beside this table. If the estimator's
projection exceeds this spec's ceiling for any cluster by >20%, the live legs
do not start until the discrepancy is explained here.

## Job design — `frontier:platform-sweep`

New kind, **one job per cluster** (payload `{clusterId, capUsd, sampleN?,
judgeMaxTokens?, maxOutputTokens?}` — no `orgId`, that absence is the
point). Added to `SINGLE_ATTEMPT_KINDS` and wrapped in `withDeliveryGuard`
(F10: this handler spends; a redelivery must not buy the same tokens twice —
guard scoped by jobId with org `undefined`, the guard's designed-for case).

The refusal ladder generalizes the org sweep's, refusal-for-refusal:

1. **Env gate** — `POTION_EVAL_PROVIDER=live` or refuse. Never degrade to
   mock: a "platform live sweep" that mocked would stamp SIMULATED evidence
   as live at platform scope — the false-live pattern at maximum blast
   radius, since every fallback-riding org inherits it.
2. **Cluster gate** — cluster must exist AND `cluster.orgId IS NULL`
   (taxonomy cluster). The mirror image of the org sweep's ownership check,
   and containment's front door: an `agent-*` tenant cluster is refused by
   name.
3. **Cap gate** — `capUsd` is **required**; absent → refuse. The org sweep's
   `DEFAULT_LIVE_SWEEP_CAP_USD` fallback is deliberately not inherited:
   platform spend is operator money and only an explicitly approved number
   authorizes it.
4. **Budget belt** — platform spend meters under a reserved operations org
   (below). If the operator sets a hard-stop budget row on that org (the
   recommended second belt), the org sweep's fail-closed pre-check runs
   verbatim: `mtd + capUsd > monthlyCap` → `OrgBudgetRefusalError`, no spend.
5. **Suite + registry gates** — suite map lookup (committed platform suites,
   not derived suites); key-reachability-filtered registry; refuse on empty.

Then the run, with the three platform deltas that make containment
structural rather than aspirational:

- **`runEval` without `orgId`** — cache keys carry `|live` but no `|org:`
  segment (`cacheKeyOf` appends the org part only when attributed), and
  eval_results rows land with `org_id NULL`: the platform default the G1.6
  comment documents. `resume: true` + per-call metering give the resumable
  leg-per-invocation property for free: a killed or crashed sweep has
  already billed and cached every completed cell, and re-enqueueing the same
  job re-executes only the remainder — cache hits meter zero (the pinned
  cache-zero property).
- **Spend home** — `request_logs.org_id` is NOT NULL by design, so platform
  spend needs an org to bill under: a reserved **`org_platform_ops`** row
  (created idempotently by the handler; NOT `DEFAULT_ORG_ID`, which is the
  unauthenticated-noise bucket). This is **spend** attribution — operator
  money made visible through the same usage-rollup chokepoint as everything
  else (`status='eval_live'`, clusterId stamped) — and it is deliberately
  distinct from **evidence** attribution, which stays org-NULL. The F12
  lesson cut precisely along this line.
- **Publish** — `aggregatesFromEvalResults(clusterId, strategies,
  pricesVersion, { providerMode: 'live' })` with no org (reads IS NULL rows
  only, live rows only — mock seed rows at the same coordinates are excluded
  by the G1.7 taint rule) → `computeFrontier` → `saveFrontier` at platform
  scope → next platform version, mock seed versions superseded as history.
  Provenance stamps `{suiteId, suiteContentHash}` where `suiteContentHash` =
  sha256(canonicalJson of the committed suite's items, sorted by id) — the
  F7 discipline applied at birth: the evidence is bound to what the
  instrument WAS, not to a filename whose contents can drift. If the
  provenance type is closed, it gains one optional field (additive, rule 2).

## Provenance and the SIMULATED exclusion

Every published point traces to org-NULL, providerMode-live eval_results rows
via the existing evidence links; the frontier row's provenance carries the
suite content hash. The standing rule this step must leave enforced: nothing
autopilot-facing ever consumes SIMULATED platform evidence. Concretely
pinned by test, not policy: the latest platform frontier for a swept cluster
aggregates zero mock rows even though mock rows exist at the same
(cluster × strategy) coordinates — the seed's own rows are the adversarial
fixture. `hasLiveEvidence` remains the gate consumers use; this step feeds
it, changes nothing about it.

## F12 containment — platform rows stay platform

The failure F12 taught: platform evidence silently re-homed into a tenant
org. The sweep must be provably incapable of the reverse trip in either
direction:

1. **Repo-level (no handler needed):** with mixed rows planted at identical
   coordinates — org-attributed and org-NULL, live and mock —
   platform-scope aggregation returns only the NULL+live rows and org-scope
   aggregation returns only that org's rows; `saveFrontier` at platform
   scope writes `org_id NULL` and never touches the org's frontier chain.
2. **Handler-level:** after a sweep, zero new eval_results/frontiers rows
   with non-NULL org exist; the only org-attributed writes are request_logs
   under `org_platform_ops`. Asserted as before/after set differences, not
   intent.
3. **Boot invariance extended:** the F12 boot-attribution test already pins
   that reboots don't re-home platform evidence; re-asserted over the
   post-sweep state (new frontier versions included) in the same commit.
4. **Front door:** the cluster gate refusal (org-owned cluster → typed
   refusal, no spend) is its own test.

## Test plan (all $0, mock/unit — the live path is proven by the legs)

- Refusal ladder: no env gate; org-owned cluster; unknown cluster; missing
  capUsd; empty registry — each refuses **before any spend** (request_logs
  count unchanged), fails-for-the-right-reason.
- Suite map completeness, both directions.
- Containment suite (§ above).
- Provenance: suiteContentHash present and stable across re-reads
  (`assertReproducible` treatment); mock-exclusion pin with seed rows as the
  adversarial fixture.
- F10: second delivery of the same job no-ops (the existing guard-claim test
  pattern for the new kind).
- Cap preflight: estimator projection > capUsd → refusal, no spend.
- Sampling determinism: same sampleN → identical item set and cache keys.
- Existing walkthrough 18/18 and full verify, output unfiltered — the
  additive-contract proof that the org sweep and everything else moved not
  at all.

## Build-phase execution plan (live legs)

- **Leg 0 ($0):** full test suite green; estimator-derived projection table
  printed per cluster; drift check against this spec's ceilings (>20% →
  stop and explain here).
- **Leg 1 (canary):** one 15-item cluster (summarization) under its sub-cap.
  Before proceeding: verify per-call metering landed under
  `org_platform_ops`, frontier published at platform scope with live-only
  evidence, containment assertions green against the real post-leg state.
- **Legs 2–10:** remaining clusters, cheapest first, one ledger row per leg
  (the standing constraint: ledger rows for ANY live run), each with its
  fail-closed sub-cap. A killed leg is re-enqueued, resumes from cache,
  meters only the remainder.

## What the operator must supply for phase two

Stated plainly, both blocking:

1. **Rotated provider keys.** The keys currently in `.env` transited chat;
   this step refuses to spend on them. I cannot verify rotation
   programmatically, so the build approval must carry an explicit
   attestation — "keys rotated on <date>" — and the live legs will not start
   without it. Minimum coverage: `OPENROUTER_API_KEY` (the registry's routed
   equivalents let one key cover answer models and judge); native provider
   keys optional.
2. **The approved cap.** A tier (A: $125 / B: $60 / C: $35) or a custom
   number, which becomes the per-cluster `capUsd` payloads. Recommended
   alongside: a hard-stop budget row on `org_platform_ops` at the approved
   total, so the existing budget machinery is the second belt.

## Risks and pushback

- **Frontier-class ceilings dominate** (~85% of the bound). The honest
  levers are sampling (Tier B) or fewer candidates (Tier C) — not
  asymmetric output ceilings, which change the measurement.
- **Cascade calibration on live models** is a build-phase verification item
  (recorded above); the fallback is `logprob` or dropping the composite for
  that cluster, recorded as a deviation.
- **Fallback behavior shift:** publishing live platform frontiers changes
  what fallback-riding orgs are served for code-gen/extraction (mock →
  live evidence) and lights up eight clusters that had no platform frontier.
  This is the step's purpose, but it is a serving-visible change the moment
  each frontier publishes — sequenced cheapest-first so the canary leg
  surfaces any surprise at minimum spend.
- **v1 suite age:** the three 51-item and five 15-item v1 suites predate v2
  authoring standards. Adequate for frontier ordering within a cluster;
  flagged as future debt (suite v2 migration), not blocking.
- **$0-mock-cost finding (Step 3)** does not apply here: live pricing makes
  metering deterministic — this sweep is, incidentally, the first
  system-wide exercise of live platform-scope metering since G2.8.

## Review outcomes (operator approval, 2026-08-12) — folded in as binding

Approved: **Tier B** — 15-item deterministic sample per cluster, $6/cluster
sub-caps, $60 total hard cap. Four additions, each now part of this spec:

1. **Second belt is required, not optional:** a fail-closed hard-stop budget
   row on `org_platform_ops` at $60 exists before the first live call, so
   job caps and the org budget layer enforce independently.
2. **Leg 0 drift guard stands:** estimator-derived projection per cluster;
   >20% over this spec's table → stop for re-approval.
3. **DoD acceptance check:** after the sweep, every cluster's published
   platform frontier shows ≥3 live single-model points and ≥1 composite,
   with zero SIMULATED provenance anywhere autopilot-facing. (If Pareto
   domination drops a candidate from the *frontier point set* for some
   cluster, the interpretation applied and recorded here will be: all four
   candidates measured live and present in the aggregation; the published
   point set is whatever domination honestly yields — any such case gets an
   explicit note per cluster rather than a quiet pass.)
4. **Reconciliation sheet at close:** per-model spend from `request_logs`
   under `org_platform_ops` laid against provider-dashboard totals for the
   operator's confirmation — "ledgered and reconciled" is the operator's to
   countersign, not mine to declare.

**Attestation note (recorded, not silent; corrected by operator
interjection, 2026-08-12):** the operator's key-rotation attestation in the
approval message arrived with a literal `<DATE>` placeholder. A follow-up
interjection re-attested — "OPENROUTER_API_KEY rotated, old key revoked" —
explicitly replacing the placeholder, though its date field was again a
template placeholder ("<fill in the real date>"); the interjection's direct
instruction to proceed to the live legs is the operative authorization, and
both are recorded here verbatim rather than smoothed over.

**Correction (operator ruling, superseding the earlier backstop claim):**
the canary backstop covers only a revoked-but-stale key in `.env` — it
fails closed on the first call. It does NOT cover an unrotated,
still-valid key: **the canary proves validity, never novelty.** The dated
operator attestation is the only control for that second case and remains
blocking for any future live campaign.

## Build-phase deviations and findings (recorded, never silent)

1. **Measured suite sizes correct the coverage table.** The five small v1
   suites carry **14** items, not 15, and the three large v1 suites **50**,
   not 51 — the spec's counts came from `wc -l`, which counts each file's
   provenance comment line. Consequence: a Tier B sample of 15 runs the
   small suites whole (74 fewer billable cells than forecast across the
   sweep). Ceilings only go DOWN (14-item cluster: $5.17 vs $5.54); the
   approved caps stand unchanged.
2. **OpenRouter-only coverage gap found and closed.** With only
   `OPENROUTER_API_KEY` set, `classRepresentative(registry,'strong')` was
   `null` — no `or-*` alias carries a strong-classifying name segment and
   all sat under the $3 price band — so the org sweep's mechanism would
   have silently produced a two-single sweep, under-measuring the DoD by
   construction. Closed two ways: (a) a new `or-opus` entry in
   `prices.json` (openrouter-routed `anthropic/claude-opus-4.5`, $15/$75 —
   the frontier-class prices the forecast already assumed), pinned by test;
   (b) the handler REFUSES (`class-unrepresented`) whenever any answerer
   class is unrepresented, rather than degrading.
3. **`prices.json` version deliberately NOT bumped** for the additive
   `or-opus` entry. Bumping would be a semantic core change the Lab
   contract forbids mid-step: `aggregatesFromEvalResults` exact-matches
   `pricesVersion`, so every existing evidence row (org and platform)
   would vanish from fresh aggregations, and judge-calibration rows record
   the version string. Adding an alias changes no existing row's meaning.
   The impurity — version string no longer uniquely describes the price
   set — is accepted and recorded here; the next legitimate price CHANGE
   must bump and absorbs it.
4. **Cascade contingency resolved.** `'self-report-calibrated'` has no
   calibration-data gate anywhere in the code — the "calibration" is the
   hard-coded linear map `SELF_REPORT_CALIBRATION` (fitted against the
   mock provider's logprob ground truth; that origin is the honest gap,
   recorded). The m1b sweep ran this method live (or-gpt-mini→or-sonnet,
   escalate below 0.72, $3.37 metered); the sweep adopts that precedent:
   cheap→strong, `confidenceBelow: 0.72`.
5. **The belt is structural, not procedural** (strongest reading of review
   outcome 1): the handler refuses (`belt-missing`) unless a HARD-STOP
   budget row exists on `org_platform_ops` — a soft belt is not a belt —
   and then runs the org sweep's fail-closed mtd pre-check verbatim.
6. **`itemSampleN` added to the harness runner** (additive `RunOptions`
   field, rule-2): sort by item id, first N, applied BEFORE the false-live
   guard and the preflight projection so both bind to the set that runs.
   Pinned by tests including the Tier-B→full upgrade path (sampled cells
   reuse as cache hits; the remainder alone bills).
7. **`suiteContentHash` rides FrontierPointEvidence** (+ the provenance
   context), both additive optional fields; the hash function is F7's own
   `suiteContentHash` from `@potion/core`, applied to the committed suite's
   items. `SINGLE_ATTEMPT_KINDS` also gained a barrel re-export from
   `@potion/queue` (it was module-local; the membership pin needed it).
8. **Operator route added**: `POST /operator/frontiers/platform-sweep`
   (token-gated, fail-closed like the rest of the operator surface), body
   zod-capped at the approved envelope ($60); status reads via the
   existing `/operator/jobs/:id` mirror because platform jobs carry no
   orgId and tenant-gated `/api/jobs/:id` 404s them by design.

## Pre-spend adversarial review (build phase, before any live call)

A three-lens review (spend safety, containment/false-live, additive
contract) with two adversarial refuters per finding ran over the full diff:
15 raw findings, **9 confirmed, 0 contested**. Resolutions, all fixed and
re-proven before the first live call:

1. **[high/spend] Script db guard accepted evaporating databases.** Bare
   `pglite://` is IN-MEMORY and typo'd/relative paths silently create
   fresh dbs — belt, month-to-date meter, and resume cache would reset per
   invocation while provider spend stayed real (the $60 belt degraded to
   per-process). Fixed: the leg script refuses any `DATABASE_URL` that is
   not byte-exactly the canonical durable dir.
2. **[medium/spend] Script re-armed the belt every run** (unconditional
   upsert back to $60/hardStop would overwrite an operator-tightened
   mid-campaign cap). Fixed: belt created only when absent; an existing
   belt is operator-owned and untouched.
3. **[medium/containment] The demo seed would clobber the live platform
   frontier**: the first server boot against the durable sweep db (no
   org_demo policies) re-seeds and saves MOCK platform frontiers for
   code-gen/extraction as vN+1 over the paid live ones. Fixed: the G1.7
   "mock never clobbers live" ratchet extended to the seed's platform
   save (per-cluster guard; unreachable before this step since platform
   live evidence could not exist), pinned by `seed-ratchet.test.ts` both
   directions. This is the one guarantee-product source file this step
   touches semantically — in exactly and only the situation this step
   creates.
4. **[high/contract] or-opus was priced at Opus-4.1 rates** ($15/$75)
   while the routed model claude-opus-4.5 really bills $5/$25 — metering
   and the reconciliation sheet would have overstated ~3× on every strong
   call. Fixed to the real routed price (every other `or-*` entry carries
   real routed prices). Leg 0 re-derived: worst-case total **$19.58**
   against the $60 cap ($1.50–$2.43/cluster).
5. **[medium/contract] Leg-0 assumed openrouter-only; the handler uses
   env-key reachability** — with `OPENAI_API_KEY` present in `.env` the
   live candidate set would have diverged from the approved forecast, and
   would have spent on a key with NO rotation attestation. Fixed
   structurally: the leg script refuses if any non-OpenRouter provider key
   is set (the attestation covers `OPENROUTER_API_KEY` only), making
   handler reachability ≡ the forecast's candidate set.
6. **[medium+low/contract] The containment test's org-purity assertion was
   tautological** (selected WHERE org IS NULL, asserted org is null).
   Fixed to a set equality: the entire org-attributed row set for the
   cluster is exactly the tenant's own 3 rows. The spec's handler-level
   before/after containment check runs against the REAL durable db after
   the canary leg and is recorded in the ledger.
7. **[high/contract, accepted as designed] or-opus changes future
   OpenRouter-only org sweeps and researcher candidate sets** (strong rep
   now exists where it was null). Handler code untouched; registry growth
   is the designed path (`new-model` is a frontier trigger), no existing
   evidence row changes, and tenant sweeps remain bounded by their own
   caps + projection preflight. Recorded, not "fixed".
8. **[low/containment, accepted with bounds] The belt is a leg-START
   check** (no mid-run re-check) and the operator route admits capUsd up
   to $60/job. Bounds: every leg is separately capped by `capUsd` through
   the runner's projection preflight and per-call metering; the campaign
   runs legs sequentially, so worst-case overshoot past the belt is one
   leg's cap ($6); the route is token-gated and the belt bounds any month
   at $60 regardless of job slicing. Recorded as residual risk.

## Not in scope

Autopilot consumption of these frontiers (later Lab steps); org-facing
changes of any kind; changes to `frontier:live-sweep`, serving fallback
logic, or the researcher; suite re-authoring; scheduled/recurring sweeps
(this step is operator-triggered legs, one ledger row each).
