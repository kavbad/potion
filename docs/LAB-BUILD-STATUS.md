# Lab build — status ledger

One row per completed step of [LAB-BUILD-PLAN.md](LAB-BUILD-PLAN.md). A step
appears here only when its definition of done is **proven** — walkthrough-
style where applicable, never asserted. Residual risks are recorded, not
smoothed over. The binding protocol (spec phase → operator approval → build
phase) lives in the plan; this file is the record of what actually happened.

| Step | Name | Date | Commit | Status |
|---|---|---|---|---|
| 1 | File and consolidate | 2026-08-11 | `3829cf9` | **complete** |
| 2 | Harness spec | 2026-08-11 | `4862b78` | **complete** |
| 3 | Runtime core | 2026-08-12 | `fe5dd27` | **complete** |
| 4 | Run records and deterministic replay | 2026-08-12 | `2b18136` | **complete** |
| 5 | Platform live sweep (rule-2 core work) | 2026-08-12 | `64b3ea8` | **complete** (awaiting operator countersign on the reconciliation sheet) |
| 6 | Intent → spec generation | 2026-08-12 | `13c7665` | **complete** |
| 7 | The dial | 2026-08-13 | `4932e55` | **complete** |
| 8 | The novice loop, ugly | 2026-08-13 | cfa7dda | **complete** — [step-08-novice-loop.md](specs/step-08-novice-loop.md); ten-minute clock 3.2s/$0, custody + catalog + activation + posture proven by test, live felt leg $0.0418 under KEY_RISK_ACCEPTED=2026-08-13 (operator countersign pending) |
| 9 | The derived form [design gate] | 2026-08-13 | 22df242 | **complete** — gate APPROVED WITH CHANGES (sign-off in the ledger = the exit); audit machine-checked in CI, no template UI as primary, live re-render via /edit proven, 12 review findings fixed with pins; clock 3.2s/$0 |
| 10 | MCP client and token custody | 2026-08-14 | 0af962b | **complete** (operator-accepted; live OAuth leg **bound to Step 12 DoD**, not pending) — [step-10-mcp-custody.md](specs/step-10-mcp-custody.md): BYOK envelope extracted to packages/custody (suite moved unchanged); hosted-only packages/lab-mcp; db 0038 grants w/ split repo surface + import fence + inventory-driven absence sweep; redactor-before-gate (raw/base64/url/**hex**/fragments); typed expiry+revocation mid-run; 4 OAuth PKCE routes; healed/hollow/cut filament. $0 proof: walkthrough severed→healed→gated→revoked + **7 exfiltration fixtures fail by test**. Pre-commit adversarial review: 2 findings fixed w/ pins (hex redaction; grant-scoped dollar caps), 2 refuted-but-hardened; deviations in spec §12. Verify unfiltered green (custody 20, lab-mcp 35, db 191, lab-runtime 54, lab-form 24, workers 151, server 539). The one DoD item not $0-provable — per-tool caps tripping under a REAL GitHub OAuth grant — is bound to Step 12 (§13): `scripts/step10-live-mcp.ts` is ready; the hands-on sitting happens once, inside Step 12, with the OAuth-app instructions pre-written. |
| 11 | Superpower packaging and catalog | 2026-08-14 | — | **spec ready** — [step-11-superpowers.md](specs/step-11-superpowers.md): NEW packages/lab-superpowers — the SuperpowerPackage format (manifest + authored usage w/ token budget + per-tool read/act classification + typed failures + versioned content-hashed mini-eval) compiling DOWN to the Step 10 ConnectorDef; read/act → the pore (act fires, read skips, unclassified→act fail-closed, per-package pore-fires proof); authored descriptions REPLACE the server's untrusted tools/list text (closes a Step 10 residual); per-connector injection fixtures held at the structural floor (model-persuasion = Step 12); honest 3-tier provenance (fixture-authored / fixture-recorded / live-proven, never conflated); least-privilege default scopes (meta-tested); catalog surface w/ Step 10 badges. Pushback: "25 fixture-proven" not "25 live"; classification is a curation claim owned by Step 12. Awaiting build approval |
| 12 | Adversarial pass on the Lab surface | — | — | not started — **carries the Step 10 live-leg binding**: its DoD includes the hands-on live OAuth leg (real GitHub grant, per-tool caps tripping live, revoke + ledger after) run ONCE against the real grant flow; its adversarial pass runs against that real flow; and its spec must include the exact operator instructions for the read-only GitHub OAuth app (callback URL, scope set, master-key one-liner) so the sitting happens once with everything ready. Named owner + verifiable exit — the toolPolicy-precedent deferral. |
| 13 | Deploy and the Gate C flip | — | — | not started |
| 14 | Deployment surfaces for harnesses | — | — | not started |
| 15 | North-star run | — | — | not started |
| 16 | Pro instruments | — | — | not started |
| 17 | The command layer | — | — | not started |

---

## Step 1 — File and consolidate (2026-08-11)

**Done when:** docs committed; zero code touched. **Both hold.**

What was done:

- Plan filed **verbatim** at `docs/LAB-BUILD-PLAN.md` (diff-verified against
  the operator's source file).
- This ledger created.
- The three verification carry-forwards folded into `docs/LAB-ROADMAP.md`:
  1. **L1 single-strategy-tools partition** (A2) — new bullet in L1: tool-
     bearing slots draw only single-model frontier points; serving's 400 on
     composite-plus-tools is its documented contract and unreachable from
     Lab-generated configs.
  2. **Gate C flips only with explicit `POTION_SELF_SERVE=1`** (A5) — Gate C
     definition amended; unset means ON under the dev-auth bypass, so only
     the explicit value counts as the decision.
  3. **Platform-scope live sweep named as rule-2 work** (A1) — recorded in a
     new "Verification outcome" section, cross-referenced to build-plan
     Step 5; honest autopilot cold start is blocked on it.
- CLAUDE.md roadmap index now points at the build plan and this ledger.

Deviation from the plan's binding protocol, operator-authorized: the spec
phase was skipped for this step only, per the operator's instruction
("docs-only, so skip the spec phase for this step only").

Residual risks: none — no code was touched, so nothing can have regressed.
Step commit: `3829cf9`; this hash was stamped by the follow-up ledger commit
(the hash cannot be known before the commit exists).

Proof: `git show --stat 3829cf9` lists only `docs/LAB-BUILD-PLAN.md`,
`docs/LAB-BUILD-STATUS.md`, `docs/LAB-ROADMAP.md`, and `CLAUDE.md`.

---

## Step 2 — Harness spec (2026-08-11)

**Done when:** "spec package passes exhaustive validation tests and every
adversarial fixture is rejected with a typed reason." **Proven** — the corpus
run is this step's walkthrough-equivalent:

- `@potion/lab-spec` (new package; deps `@potion/core` + zod, dev-only ajv;
  no runtime, routes, db, or spend): types, strict zod schemas, content hash
  (`sha256(canonicalJson)` minus the embedded `hash` field — F7 discipline),
  `parseHarnessSpec`/`parseHarnessSpecText` collecting ALL issues with 12
  typed reason codes, published JSON Schema (draft 2020-12).
- **25-fixture corpus** (5 valid / 9 invalid / 11 adversarial), every fixture
  asserted fails-for-the-RIGHT-reason. Completeness meta-tests in every
  direction: every file classified, every classification has a file, every
  one of the 12 issue codes produced by ≥1 fixture, every parse↔ajv
  divergence carries a stated layer reason. Sample proof lines:
  `adversarial/proto-key.json → parse=dangerous-key, ajv=invalid`,
  `adversarial/hash-tampered.json → parse=hash-mismatch, ajv=valid (layer:
  hash truth is not expressible as shape)`,
  `valid/injection-prose.json → parse=valid, ajv=valid` (the boundary pin:
  scary prose is data, the parser is the attack surface).
- Package suite 40/40; each test file also green in isolation (standing
  rule); full `pnpm verify` green end-to-end (exit 0; 1,494 tests
  repo-wide).

**Deviations** (recorded in `docs/specs/step-02-harness-spec.md`): (1)
`LabPolicySchema` is a PROVEN strict subset of core `PolicySchema`, not a
reuse — core's objects strip unknown keys and carry serving-side
shadow/guarantee config a harness runtime would not honor; the subset
relationship is enforced by test, so "one dial vocabulary" is a fact, not a
comment. (2) The ajv agreement is scoped per-fixture with explicit layer
reasons instead of "identical classification" — JSON Schema cannot express
size/secret/control-char/relational/hash checks, and the meta-test makes any
unexplained divergence a build failure.

**Residual risks:** one workers test failed in the FIRST full-verify run and
did not reproduce in two subsequent full runs (workers 121/121 both times,
final verify exit 0). Its identity was lost because that verify's output went
through a grep filter — a process error, recorded: verify output is retained
unfiltered from now on. Plausible cause is CPU contention (two concurrent
vitest invocations ran alongside that verify; the same session earlier saw a
900s test under the same contention). If it recurs with a name, it gets
filed properly. Also standing: the secret-material patterns are deliberately
DUPLICATED from the G2.8 scrubber (scripts are not importable) — Step 10's
custody tests re-verify both copies.

Proof: `git show --stat 4862b78` — the step touches only
`packages/lab-spec/**`, `docs/specs/step-02-harness-spec.md`, this ledger,
and lockfile/workspace wiring. Zero changes to guarantee-product code.

---

## Step 3 — Runtime core (2026-08-12)

**Done when** (plan): a harness runs headless from a file, every model call
writes its own metered row, a mid-run budget hard-stop provably kills it, and
a walkthrough leg shows checkpoints survive the kill. **All proven**, plus the
three review additions, walkthrough-style against the REAL serving route
(`buildServer` on an ephemeral port — actual metering, budget gate, rate
limiter; no in-process shortcut exists in the test file).

What landed:

- **`@potion/lab-runtime`**: ServingClient (the ONE outbound module,
  touchpoint 1; `potion-auto` label; budget/rate-limit 429 taxonomy), the leg
  executor (leg-per-invocation, checkpoint-per-step, fenced writes,
  awaiting-human first-class with consume-on-use answer semantics), the
  secret gate on every checkpoint, llm.call span emission per the A3 shape,
  CLI (run/resume/answer/kill/show).
- **Migration 0035 + `@potion/db` repos** (operator ruling: schema-additive
  core under rule 2): `lab_runs` (state machine, cursor, fence, lease),
  `lab_run_steps` (verbatim step records), `lab_harness_memory`
  ((org, harness)-scoped). `deleteOrgCascade` extended and the F5
  schema-derived meta-test green in the same commit.

Proof lines (all green; every new test also green in isolation):

- db store: 9/9 — one CAS winner, expired-lease reclaim with the ZOMBIE'S
  LATE WRITE FENCED OUT, ordered appends, unfenced operator kill fencing the
  running invocation, terminal-refuses-with-fork-remedy, spec-drift refusal,
  awaiting-human answer lifecycle, cross-org invisibility of runs/steps/
  memory, cascade erasure with counts.
- runtime: 10/10 — tool execution with memory projection, suspend BEFORE the
  external tool runs → answer → resume completes with exactly one send,
  fuel kill mid-run with surviving checkpoint, secret-in-checkpoint typed
  failure (model step kept, leaky tool step refused), structural
  no-provider-imports test.
- walkthrough legs vs the real route: headless completion with the METERING
  JOIN (every model step's completionId ↔ exactly one request_logs row, our
  org) + spans ingested idempotently; org-budget 429 → killed-budget,
  terminal, resume refused; fuel hard stop mid-run through the real route
  with checkpoint surviving; spec-drift refusal end to end.
- Full `pnpm verify` exit 0 (unfiltered log retained): 1,513 tests repo-wide;
  guarantee-product dashboard walkthrough 18/18 untouched. The Step-2 workers
  flake did NOT recur across this step's four full verify runs.

**Findings, recorded not smoothed** (details in the spec file's deviations):

1. **Some mock-stack serving calls meter `usage.costUsd = 0`** (measured: a
   fallback-path call landed cost 0; a code-gen call landed $0.00009). An
   org-budget MID-RUN kill keyed to metered mock spend is therefore
   nondeterministic by construction — leg 2 proves the org 429 first-touch
   and the mid-run kill at the fuel layer (token-derived, deterministic).
   Deployment checklist item: re-prove the org-layer mid-run kill on live
   pricing.
2. **The budget gate cache is module-scoped**: a second `buildServer` in the
   same process shares it. F18 observed from inside a test — an in-process
   "new session" is not a new session. The cross-session resume story in the
   walkthrough uses the same db with a fresh client instead.
3. `brain.policy` does not yet drive serving selection (Step 6/7); recorded
   so the slot is not read as live.

Residual risks: checkpoint payload growth is O(context²) per run (accepted
v1, bounded by fuel; Step 4 revisits); cron check-ins are inert until L4
triggers exist; the CLI is programmatic-first and its argv surface is
untested beyond types (exercised properly in Step 8's novice loop).

Proof: `git show --stat fe5dd27` — guarantee-product sources untouched
except `packages/db` schema-additive files and the cascade extension the
ruling authorized.

---

## Step 4 — Run records and deterministic replay (2026-08-12)

**Done when** (plan): a recorded run replays deterministically in mock, and
its steps land as eval items without converter changes. **Both proven.**

- **Playback carries the DoD** (per the approved spec): `replayRun(spec,
  steps, terminal)` — pure, no network, no db handle (the signature is the
  fence) — re-derives every model step's request using the loop's OWN
  exported helpers and compares byte-for-byte. All six golden fixtures
  replay `ok`, twice, byte-identically (`assertReproducible` discipline).
- **Golden corpus, generated**: six recorded runs (task, tools,
  suspend/answer/resume across the invocation boundary, fuel-killed,
  standing leg-cap, memory-carry) from a committed generator with fixed
  clock/ids; **regeneration is byte-identical to the committed fixtures,
  asserted by test**. Six adversarial mutants each pinned to its named
  divergence code; the dead-code meta-test covers all six codes.
- **Inertness proven as a count invariant**: six tables (`request_logs`,
  `trace_spans`, `lab_runs`, `lab_run_steps`, `lab_harness_memory`,
  `usage_daily`) byte-equal counts around a full corpus playback — playback
  cannot meter spend, which also keeps it clear of the Step 3 $0-mock-cost
  nondeterminism.
- **Steps → eval items, zero converter changes**: the emitter now carries
  `gen_ai.prompt`/`gen_ai.completion` on llm.call spans and
  `tool.args`/`tool.result` on tool spans (content from checkpoints, which
  passed the secret gate; truncation-marker contract at 8,000 chars). E2E:
  enriched spans through the REAL `POST /v1/traces` (idempotent re-emission
  asserted) → the REAL `tracesClusterHandler` → step items present in the
  `-replays-v2` suite with the recorded context as prompt and the recorded
  completion as reference. `packages/workers`, `scripts/`, and the traces
  read model: **untouched, confirmed by git status in the run log**.

**Finding (recorded in both Step 3 and Step 4 spec files):** Step 3's
checkpoint contract promised `memoryReads` and `checkInAnswer`; the Step 3
build populated neither — records were NOT self-contained, surfaced the
moment replay tried to re-derive the system prompt. Fixed in this commit
(the first step of each leg now carries the stamp); the golden corpus was
generated after the fix and pins the corrected contract.

Numbers: lab-runtime 28/28 (replay 17, synthesis 1, loop 6, walkthrough 4),
each file green in isolation; full `pnpm verify` exit 0 (unfiltered log
retained); guarantee-product walkthrough 18/18.

Residual risks: golden fixtures pin today's prompt text — a deliberate
prompt change regenerates the corpus in the same commit, reviewed as such;
the fake embedder proves the synthesis PIPELINE, not embedding quality
(real-embedder clustering belongs to Step 5's live sweep and beyond).

Proof: `git show --stat 2b18136`.

---

## Step 5 — Platform live sweep (2026-08-12)

**Done when:** all ten taxonomy clusters carry a platform frontier whose
latest version aggregates exclusively live-evidenced rows, under the
approved Tier B envelope. **Holds** — proven on the durable campaign db
(`.pglite/platform-sweep-step5`), acceptance re-read twice from fresh
processes byte-identically.

Build commit `64b3ea8` (code + pre-spend review fixes; spec:
[step-05-platform-sweep.md](specs/step-05-platform-sweep.md) carries the
approved review outcomes, the attestation record, eight recorded
deviations, and the 9-finding pre-spend adversarial review).

**Campaign:** 10 legs, one cluster each, sample 15 (small suites run whole
at their measured 14), $6/cluster sub-caps, $60 hard-stop belt on
`org_platform_ops` — **total metered $3.5774**, 18% of the estimator's
worst-case $19.58, 6% of the cap. Candidates openrouter-only by policy
(the rotation attestation covers OPENROUTER_API_KEY only; the leg script
structurally refuses other provider keys): or-deepseek / or-gemini-pro /
or-opus singles + cascade(or-deepseek→or-opus @0.72), judge judge-class.

**DoD acceptance (operator addition 3), per the recorded interpretation —
all four candidates measured live in every cluster (56–60 evidence rows =
the full grid); the published point set is what Pareto domination honestly
yields, noted per cluster:**

| cluster | pts | singles | composites | note |
|---|---|---|---|---|
| multi-step-reasoning | 4 | 3 | 1 | full candidate set on frontier (literal DoD met) |
| agentic-tool-use | 4 | 3 | 1 | full candidate set on frontier (literal DoD met) |
| rag-answer | 3 | 3 | 0 | cascade dominated |
| summarization | 3 | 2 | 1 | one single dominated |
| creative | 3 | 2 | 1 | one single dominated |
| code-review | 3 | 2 | 1 | one single dominated |
| rewrite-edit | 3 | 2 | 1 | one single dominated |
| code-gen | 2 | 2 | 0 | one single + cascade dominated |
| extraction | 2 | 2 | 0 | one single + cascade dominated |
| classification | 2 | 2 | 0 | one single + cascade dominated |

Every cluster has ≥2 singles on its frontier — the tool-bearing partition
always has single-model points to draw from. Zero SIMULATED provenance
anywhere autopilot-facing: every published point is providerMode live with
suiteContentHash provenance (F7 at birth), and the seed ratchet
(`seed-ratchet.test.ts`) pins that no future boot's mock seed can supersede
these frontiers. The two formerly SIMULATED-seeded clusters (code-gen,
extraction) are now live-evidenced.

**Containment (F12):** zero org-attributed eval_results/frontiers rows in
the campaign db; all spend under `org_platform_ops` (`status='eval_live'`);
evidence org-NULL throughout — the spend/evidence attribution split held
exactly as designed.

**Reconciliation sheet** (in `tasks/todo.md`, awaiting operator
countersign): judge-class 280 calls $1.1493 · or-deepseek 435 calls
$0.0606 · or-gemini-pro 145 calls $1.6204 · or-opus 150 calls $0.7471 —
total $3.5774.

**Walkthrough scope confirmation (operator query):** the Gate 6
walkthrough emits 20 PASS lines = 2 boot legs + numbered legs 0–17. The
"18/18" in the Step 3/4 rows counts the numbered legs; a report quoting
"17" quoted the highest ordinal. Same gate, same scope, nothing dropped.

**Residual risks (recorded, not smoothed):**
- The belt is a leg-start check; worst-case overshoot is one leg's cap
  ($6) under sequential legs (spec review §8). The operator route admits
  capUsd ≤ $60/job — token-gated, belt-bounded.
- `prices.json` version deliberately unbumped for the additive `or-opus`
  entry (spec deviation 3); the next legitimate price change must bump.
- or-opus now exists for every future OpenRouter-only registry consumer
  (org sweeps, researcher) — designed registry growth, recorded (spec
  review §7).
- Cascade self-report calibration constant was fitted on mock (spec
  deviation 4); live cascades survived domination in 6/10 clusters, so
  the composite's live behavior now has real evidence for a later
  recalibration pass.
- Process error recorded in the ledger: one code-review row was first
  written with a figure not yet read from the leg output; corrected in
  place with the error noted in the row.

---

## Standing rule — live-spend gate: operator risk acceptance (amended 2026-08-13)

**Deliberate operator decision, dated 2026-08-13, superseding the
2026-08-12 ATTESTED_ON rotation-attestation rule:** the operator accepts
live spend on the current `OPENROUTER_API_KEY` — which transited chat — on
the basis of its provider-side spend cap. The mechanism stays FAIL-CLOSED:
any live-spend script MUST refuse to start unless
`KEY_RISK_ACCEPTED=<ISO date>` is present in its environment; silence
still spends nothing. A future key rotation SUPERSEDES this acceptance —
on rotation, the gate's meaning reverts to a rotation attestation and this
entry is amended again. A script that can spend real money without this
variable set is a build defect, in scope for review the same way a missing
cap would be.

History: the original rule (2026-08-12) required `ATTESTED_ON=<ISO date>`
as a key-rotation attestation, after the Step 5 attestation arrived with a
placeholder date twice; the canary proves key validity, never novelty. The
Step 5 spec's open attestation item is CLOSED by this amendment (see
docs/specs/step-05-platform-sweep.md, attestation note).

---

## Step 6 — Intent → spec generation (2026-08-12)

**Done when:** a plain-language mission produces a valid, runnable spec
where every autopilot choice traces to a frontier point. **Proven
walkthrough-style**: Leg B generates from a live-evidenced platform
frontier seeded in the real db (choice basis = the saved frontier row's
id/version/strategyHash/suiteContentHash, binding verified), the spec
parses under lab-spec, and `startRun` executes the GENERATED file to
completion against the real server. Leg A pins the generator as a metered
model call: real route, exactly `GEN_MAX_MODEL_CALLS` (2) request_logs
rows, typed refusal when the mock provider can't speak extraction JSON.

**`@potion/lab-gen`** (new package; deps core + lab-spec + lab-runtime;
zero guarantee-product changes): four-question interview (task/standing
ASKED never inferred; worth per run / per check-cycle per review outcome
1), `WORTH_TO_FUEL_RATIO = 0.25` as a provisional labeled constant with
its re-derivation path in code, one structured-extraction call through
ServingClient (≤2, strict-zod + raw-scan gated, one repair pass),
lexical+hint cluster assignment that returns drafts with open questions
instead of guessing, autopilot knee-shaped compound policy with **the
policy as authority** (the recorded choice is what `selectPoint` actually
selects), the single-strategy partition enforced by construction, and a
two-way hash-bound provenance sidecar (review outcome 2: edited spec
orphans; tampered sidecar self-detects).

**Closure property (the load-bearing proof):** 500 seeded cases over
benign/adversarial/degenerate answers × scripted-model behaviors ×
frontier variants — an invalid spec is unrepresentable as an output;
outcome-mix floors keep the fuzz honest. Golden corpus: 11 byte-reproducible
fixtures including the review-outcome-3 minimums (standing mission,
partition demonstration, tools+composite unrepresentable, frontier-gap
draft with typed question, typed refusals), completeness meta-tests both
directions, generator regeneration byte-identical.

**Pre-commit adversarial review:** 11 raw findings, 8 confirmed (2
duplicates), 0 surviving — including two EXECUTION-PROVEN closure
violations (degenerate worth crash; knee/reselect throw on legitimate
3-axis Pareto frontiers) fixed before commit with committed regressions.
Full record in the spec's review section.

Proof: verify exit 0 unfiltered (lab-gen 48/48; all packages green), Gate
6 walkthrough OK — guarantee product untouched.

**Residual risks (recorded):** cluster assignment remains the weakest link
on real user language (visible-degrade converts silent-wrong into
asked-question; basis rides every choice for Step 8's report); the knee
default embeds taste until Step 7's dial; `WORTH_TO_FUEL_RATIO` awaits
Step 8 traffic for re-derivation; no CLI shipped (deviation 8 — the
sidecar meets users in Step 8's chat loop).

---

## Step 7 — The dial (2026-08-13)

**Done when:** a dial move produces measured, demonstrable differences, and
no Lab-generated config can request tools on a composite strategy. **Both
proven walkthrough-style** against the real serving route, five legs:

1. Felt sweep with the DURABLE cache (migration 0036): first sweep meters
   real request_logs rows, the repeat adds ZERO — the count invariant.
2. Three-surface strategy-hash agreement: dial view === felt trace === run
   step traces, under the same materialized policy row
   (`policy_override=` echoed on every step's x-frontier-trace).
3. The R/M/K flip measured through the route: a tolerance move changes
   which strategy ACTUALLY serves the same quality rung; the infeasible
   edge yields the typed gap with its evidence-sourced relax hint.
4. Partition under motion: on a cascade-dominating frontier, captured
   positions are the typed `serve-partition-divergence` refusal (the 400
   unreachable from Lab paths); feasible rungs felt-serve the exact single.
5. **The review's production scenario, executed**: 35 measured servings
   flip the SAME rung R→K under serving-grade latency substitution, in
   view AND felt, in clean agreement — the case no prior test could see.

**What landed:** `@potion/lab-dial` (geometry with exact-float ladders +
tolerance knob; **the selection-context module** reproducing serving's
context with serving's own primitives — org-preferred frontier, G2.6
latency substitution, rollback-active refusal; spec motion with carried
sidecar provenance; org-scoped policy materialization with retained
generations and loud collision errors; felt samples with divergence
detection, poison-proof caching, and a fail-closed cap incl. the
production request_logs cost join); migration **0036 lab_felt_samples**
(cascade-covered at birth); ServingClient pin headers (X-Potion-Policy /
X-Potion-Cluster — touchpoint 2 consumed exactly as serving shipped it,
zero serving changes); `AutopilotChoice.slot` widened for tool-slot moves.

**Review outcomes honored:** toolPolicy exit criterion documented (Step 8
owns activation — the tool-free-step walkthrough leg is its verifiable
exit); policy-row lifecycle proven (dial move → new row, history retained
and resolving); relax hints evidence-sourced (exact frontier-row p95).
**Carry-forward:** the FIRST LIVE FELT LEG is a named Step 8 DoD item.

**Two adversarial review rounds** (the second the strongest of the ladder:
15 confirmed, 0 contested, several proven by execution) — full record in
the spec. The headline lesson, now structural: one authority means one
function AND one selection context; the dial evaluates with serving's own
primitives on serving's own inputs or it is a parallel computation
wearing the authority's clothes.

Proof: verify exit 0 unfiltered (lab-dial 31/31; all packages green),
Gate 6 walkthrough OK — guarantee product untouched semantically (the one
core touch is additive: 0036 + cascade coverage + client pin headers).

**Residual risks (recorded):** SERVING_LATENCY_WINDOW_MIN mirrors
latency-policy.ts by value; the dial-side rollup read is uncached vs
serving's 60s cache (freshness race, visible-not-prevented class);
frontier-version races remain visible-not-prevented; toolPolicy inert
until Step 8's activation leg.

## Step 8 — The novice loop, ugly (2026-08-13)

**What was proven (walkthrough-style, all DoD items):**

- **The ten-minute clock:** `apps/dashboard/scripts/lab-walkthrough.ts` boots
  server+dashboard fresh-db and performs only what the UI affords: sign in →
  /lab → four interview answers → submit → generated summary → trial →
  narration polling → the check-in appears → answer → terminal → the report
  with all four sections and the single evidence-chosen upgrade. **Wall
  clock interview→report: 3.2s of the 600s budget, $0, mock.** The novice
  builds a STANDING mission — standing specs now carry the half-fuel
  check-in (build finding: the specced tool-gated check-in cannot fire
  pre-MCP and tasks complete on their first done-shaped answer).
- **13 `/api/lab/*` routes** (spec table verbatim) in apps/server, every row
  classified in ROUTE_INVENTORY; key-role-split 37/37 (route tree matches
  both ways), tenancy sweep 92/92 (uniform-404 probes over seeded
  labHarness/labRun rows under both credential kinds), classification
  artifact regenerated (97 routes). Dashboard pages /lab, /lab/harness/:hash,
  /lab/run/:id, /lab/run/:id/report, /lab/memory/:hash + thin proxies.
- **Serve-key custody (review outcome 1):** 10 tests
  (packages/workers/src/lab-run.test.ts) — the ephemeral run-scoped key dies
  at completed / failed / killed-budget (fuel AND org hard-stop) /
  awaiting-human / crash-rethrow; the fence/reclaim sweep reaps zombie keys
  on entry INCLUDING on terminal runs (sweep moved ahead of the terminal
  no-op — a crash between the terminal transition and the finally would
  otherwise orphan a live key forever); sweeps are run- and org-scoped.
  Missing POTION_SERVING_URL fails closed before any mint.
- **Catalog invariance (review outcome 2):**
  packages/lab-runtime/src/catalog-invariance.test.ts — after an aggressive
  lab_harnesses edit (name, specText, sidecar, clusterId), a pre-edit run's
  replay input bytes and replay verdict are identical (0037 tied to Step 4).
- **The toolPolicy activation leg (Step 7's exit, verbatim):**
  packages/lab-runtime/src/walkthrough.test.ts — one run against the REAL
  route with a test-local tool: step payloads carry BOTH slot values;
  every call's x-frontier-trace shows `policy_override=` of ITS slot's row;
  the two slots rode DIFFERENT strategies (0.8 floor vs 0); the wrap-up is
  the last model step, tool-free, under brain. (Enabled by an additive mock
  change: call-then-answer once a tool result is in the transcript.)
- **Report v1:** packages/lab-runtime/src/report.test.ts — struggle taxonomy
  complete both directions vs the upgrade ladder, deterministic first-match
  ladder (not-connected beats budget-killed), est-vs-metered NEVER blends
  (no blended field exists to leak).
- **Tool posture in three places:** apps/server/test/lab-posture.test.ts —
  a declared-account mission completes brain-only and says so typed in the
  harness DTO, the run DTO, and the report struggle; the upgrade slot
  prefers "connect calendar".
- **The first live felt leg (review outcome 3):** three runs under
  KEY_RISK_ACCEPTED=2026-08-13, $1.00/run cap, OPENROUTER only, against a
  COPY of the Step 5 campaign db. Run 1's divergent sample was the
  product's own strategy-mismatch detector catching a leg-script custody
  bug (both rungs materialized onto one policy row — the 12-char name
  prefix truncated the rung suffix); run 3 CLEAN: 3 samples, all
  provenance=live, zero divergence, the dial flip visible in live serving
  (rung 0 → 6efe8a56, rung 2 → 10b2d052). Metered $0.0418 total across the
  three runs. Samples verbatim below; **operator reading completes at
  countersign.**

**Build findings** (recorded in the spec, never silently): calendar-rotted
fixtures in four pre-existing test files (traces, suite-verify,
guarantee-report ×2 — hardcoded '2026-08-06T…' aged out of the 7-day
clustering window the day the calendar reached 2026-08-13; converted to
run-relative bases); the mock extraction fixture; the standing-mission
half-fuel check-in; the call-then-answer mock tool rule; the felt-leg
policy-row name-truncation bug caught live by divergence detection.

**Residual risks:** the ten-minute clock measures the mock path (the DoD's
own definition); polling narration is 1–2s deliberate simplicity; report
v1 prose is dry by design (no model phrasing until a later step);
lab_harnesses key-table churn cleanup belongs to run retention; the
lab:run worker's adversarial pass over user-authored missions is Step 12
by plan.

### Live felt leg — clean-run samples (verbatim, run 3)

```
━━ cluster summarization ━━
  rung 0: q=0.8571428571428573 $2.2681428571428572/1K p95=17519ms → lab-7c5f14-s8r0summariz-brain
  rung 2: q=0.9214285714285716 $5.8680714285714295/1K p95=7471ms → lab-7c5f14-s8r2summariz-brain

  ── SAMPLE (lab-7c5f14-s8r0summariz-brain) ──
  strategy=6efe8a56 provenance=live cached=false
  costUsd=$0.0003 latencyMs=11086
  output (verbatim):
  | Aggressive CDN caching for a news site offers significant performance and cost benefits but introduces critical challenges around content freshness. The primary tradeoff is between **speed and staleness**.
  | 
  | **Benefits (Why you'd do it):**
  | * **Extreme Performance:** Static assets (images, CSS, JS) and even article pages load instantly from nearby edge servers, improving user experience and SEO.
  | * **Massive Scalability:** The origin server is shielded from traffic spikes (e.g., breaking news), preventing crashes.
  | * **Reduced Costs:** Dramatically lowers origin server bandwidth, compute load, and infrastructure costs.
  | 
  | **Risks (What you sacrifice):**
  | * **Content Staleness:** The core problem. Aggressively cached articles may not reflect critical updates, corrections, or developing stories, damaging credibility.
  | * **Poor Personalization:** Cached pages cannot show dynamic, user-specific elements (e.g., "Recommended for you," logged-in status) without complex workarounds.
  | * **Complex Invalidation:** Managing cache purges (TTLs, purge APIs) for urgent updates adds operational overhead and risk if not instantaneous.
  | 
  | **The Key Balance:** Successful implementation requires a **granular caching strategy**:
  | * **Cache forever:** Static assets.
  | * **Cache with moderate TTL (e.g., 1-10 min):** Article body text, allowing a balance of performance and acceptable update latency.
  | * **Never cache:** Dynamic components (comments, live counters, user-specific modules), fetched separately via AJAX or edge-side includes.
  | 
  | In essence, aggressive edge caching is a powerful tool for a news site, but it must be applied with precise rules to avoid serving outdated news, thereby trading some theoretical freshness for resilience, speed, and cost-efficiency.

  ── SAMPLE (lab-7c5f14-s8r2summariz-brain) ──
  strategy=10b2d052 provenance=live cached=false
  costUsd=$0.0082 latencyMs=8309
  output (verbatim):
  | # Tradeoffs of Aggressive CDN Edge Caching for News Sites
  | 
  | ## Benefits
  | 
  | - **Performance**: Dramatically faster page loads for readers worldwide
  | - **Scalability**: Handles traffic spikes during breaking news without origin server strain
  | - **Cost reduction**: Lower bandwidth and compute costs at origin
  | - **Reliability**: Site stays available even if origin has issues
  | 
  | ## Drawbacks
  | 
  | - **Stale content**: Readers may see outdated headlines, incorrect information, or old versions of developing stories
  | - **Cache invalidation complexity**: Purging content across global edge nodes takes time and adds operational overhead
  | - **Personalization challenges**: Harder to serve user-specific content (paywalls, recommendations, regional variants)
  | - **Breaking news delays**: Critical updates may not reach readers immediately
  | - **Analytics gaps**: Cached responses don't hit origin, potentially skewing traffic data
  | 
  | ## Common Mitigation Strategies
  | 
  | - Use short TTLs (seconds to minutes) for frequently-updated sections
  | - Implement cache tags for selective, targeted purging
  | - Cache static assets aggressively, dynamic content conservatively
  | - Use stale-while-revalidate to balance freshness and speed
  | - Edge-side includes (ESI) to mix cached and dynamic content
  | 
  | ## Bottom Line
  | 
  | Aggressive caching works well for news sites on static assets and older articles, but requires careful tuning for homepages and breaking content where freshness directly impacts editorial credibility.

━━ cluster code-gen ━━
  rung 0: q=1 $0.10439999999999998/1K p95=14073ms → lab-7c5f14-s8r0codegen0-brain

  ── SAMPLE (lab-7c5f14-s8r0codegen0-brain) ──
  strategy=6efe8a56 provenance=live cached=false
  costUsd=$0.0005 latencyMs=40189
  output (verbatim):
  | Here's a Python function that merges two sorted lists into one sorted list:
  | 
  | ```python
  | def merge_sorted_lists(list1, list2):
  |     """
  |     Merge two sorted lists into one sorted list.
  |     
  |     Args:
  |         list1: First sorted list
  |         list2: Second sorted list
  |         
  |     Returns:
  |         A new sorted list containing all elements from both input lists
  |     """
  |     merged = []
  |     i = j = 0
  |     
  |     # Merge elements while both lists have items
  |     while i < len(list1) and j < len(list2):
  |         if list1[i] <= list2[j]:
  |             merged.append(list1[i])
  |             i += 1
  |         else:
  |             merged.append(list2[j])
  |             j += 1
  |     
  |     # Add remaining elements from list1 (if any)
  |     while i < len(list1):
  |         merged.append(list1[i])
  |         i += 1
  |     
  |     # Add remaining elements from list2 (if any)
  |     while j < len(list2):
  |         merged.append(list2[j])
  |         j += 1
  |     
  |     return merged
  | ```
  | 
  | **Example usage:**
  | ```python
  | list1 = [1, 3, 5, 7]
  | list2 = [2, 4, 6, 8]
  | result = merge_sorted_lists(list1, list2)
  | print(result)  # Output: [1, 2, 3, 4, 5, 6, 7, 8]
  | 
  | # Works with lists of different lengths
  | list3 = [1, 5, 9]
  | list4 = [2, 3, 4, 6, 7, 8]
  | result2 = merge_sorted_lists(list3, list4)
  | print(result2)  # Output: [1, 2, 3, 4, 5, 6, 7, 8, 9]
  | ```
  | 
  | **Key features:**
  | - Uses the merge algorithm from merge sort
  | - Time complexity: O(n + m) where n and m are the lengths of the input lists
  | - Space complexity: O(n + m) for the merged result
  | - Handles lists of different lengths
  | - Preserves the sorted order efficiently
  | - Works with any comparable data types (numbers, strings, etc.)

── leg complete — metered total $0.0090 of $1.00 cap ──
Samples above are the ledger evidence VERBATIM; the operator’s reading completes at countersign.
```

### Step 8 pre-commit review (standing practice) — outcome

Five finder dimensions over the diff, 21 claims, two adversarial refuters
each (eight verdicts completed by the operator's agent in the main loop
after subagent credit exhaustion — same read-the-code standard). **Nine
confirmed and fixed with pinned regressions**: lab-io key expiry (no
reaper existed), the vacuous body-carried cross-org probe (mechanism fixed
for the whole class — four pre-existing G2.4 rows now probe with REAL
foreign ids), the answer route's dropped guard verdict (now 409), the felt
route's one-row policy materialization (the live leg's own bug, in the
route), the zombie sweep disarming healthy runs (now gated on no live
claim), replay's false divergence on failed-wrap-up records, the fuel
check-in answer doubling as external-action authorization, the paid
wrap-up after the fuel cap, and the felt leg script's NaN/crash on
unresolved metered cost. **Four accepted as recorded v1 residuals**:
est-denominated fuel (outer belt = org metered hard stop; re-derivation
path recorded), per-invocation catalog clusterHint reads, latest-sidecar
catalog semantics on revisited dial positions, and lease-expiry-plus-kill
as the stranded-run recovery. Post-fix: lab-runtime 37/37, workers
147/147, server 530/530, walkthrough 3.2s/600s — all green.

## Step 9 — The derived form [design gate] (2026-08-13)

**Design gate:** phase one produced the spec + a motion study animating
ONLY captured API data; verdict **APPROVED WITH CHANGES** (provenance
recorded verbatim in the spec: delegated review adopted by the operator on
paste) — the grammar passed as shown, four binding changes + three
standing additions folded into the build. The study is frozen as the
artifact the verdict was rendered on; the changes live in the product
renderer, enumerable through the audit. **The operator's sign-off (the
gate verdict) is recorded in the ledger as this step's exit.**

**What was proven:**

- **`@potion/lab-form`** — `deriveFormState` (one pure derivation:
  config + memory + run + poll-age → a CLOSED FormState), the
  pixel-to-parameter audit as a typed table with the THREE-DIRECTION
  machine check IN CI (every FormState leaf ↔ exactly one audit row;
  every source is a fixture-executed accessor; the draw layer is
  import-fenced to FormState + THEME — unmapped decoration fails the
  suite by name), the enumerated taste surface (every THEME constant
  audited; the pulse-amp clamp carries its WORTH_TO_FUEL re-derivation
  note in source, pinned by test), diff-only discrete events (identical
  polls emit nothing — tested), typed staleness from the poll clock
  (live/stale/disconnected/static-config — a motionless form is never
  ambiguous with a dead view), a ratcheting visible degrade controller,
  and the draw-op budget enforced at the TRUE spec maxima (100 rules /
  50 superpowers via the recorded aggregation rule). 21/21.
- **The four approved changes**: signature tint propagated (reserved
  tints provably never policy-derived — they are THEME constants the
  audit marks RESERVED), far-zoom presence + breath gain as audited
  presentation constants, severance thickened in GEOMETRY (dead segment
  wider than live filaments, blunt forked terminus — shape-legible in
  monochrome), and missionKind DRAWN (task = bilateral ellipse with a
  head end, standing = radial; the silhouette branch is tested — no
  phantom parameters).
- **Server**: `POST /api/lab/harnesses/:hash/edit` (typed plain-language
  patch → NEW content-addressed catalog row, carried sidecar rebound,
  closure-gated, no-op honest; fuel re-derives through fuelFromWorth;
  declaring a superpower mirrors the generation-time external-action
  gate), `GET :hash/runs`, and typed fallback/latencyViolated flags on
  the run DTO. Inventory rows classified; key-role-split + tenancy sweep
  + lab-edit tests green (140/140 on the touched suites); classification
  artifact regenerated (99 routes).
- **The form is the page**: /lab/harness/[hash] and /lab/run/[id] render
  the derived form as the PRIMARY surface (no template UI remains as
  primary; plain-language panels at mid zoom carry the old tables'
  content through the real routes). SSR data attributes derive from the
  same DTOs the canvas draws — the walkthrough's proof surface.
- **Walkthrough** (in verify): the Step 9 leg proves live re-render
  through the REAL edit path — /edit lands a new content hash,
  laminations 0→1 on the new page, the PRIOR page still renders 0 (the
  catalog-invariance discipline visible in pixels); severed=2 from the
  declared accounts; the clock still reads 3.2s of 600s at $0; the
  report's single upgrade correctly prefers "connect calendar, email" on
  the tool-declaring scenario.

**Residual risks:** canvas is not screen-readable — the DOM overlay at
mid zoom (labels, panels, the live audit readout) is the recorded
accessibility surface; run-page narration text now lives in the report
and panels rather than a primary timeline; the felt-sample anomaly beads
await a 0036↔harness link (recorded spec deviation); per-edit catalog
rows ride the same retention story as dial moves.
