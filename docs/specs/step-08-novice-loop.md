# Step 8 spec — The novice loop, ugly

Phase-one document per the binding protocol. Read before writing: the plan
(Step 8: chat-to-harness end to end, plain UI permitted; live narration
from run records; cost ticker from per-step attribution; the check-in
surface; memory view/edit; run report v1; "done when a novice-shaped
session goes intent → running harness → report with zero documentation,
timed under ten minutes"), the status ledger, the Step 6 spec (interview,
generation, sidecar) and Step 7 spec (dial, selection context, and the two
carried DoD items recorded there), the dashboard app's auth (magic link →
session cookie, walkthrough leg 0), the server's org scoping + role guards
(G2.3 `roleForApiKey`, route inventory + exhaustive enforcement test,
G2.4 tenancy sweep), and the runtime's read surfaces (`getLabRun`,
`listLabSteps`, `pendingQuestion`, `answerLabRun`, `getLabMemory`,
`StepPayload.estCostUsd`). Build-phase deviations get recorded here, never
silently.

## What Step 8 delivers

The first human surface: a novice types a mission into a plain page and
ten minutes later has a generated harness, a completed (or honestly
paused) trial run they watched happen, and a report that tells the truth
about cost and struggle. Ugly is permitted; dishonest is not. The two
carried DoD items land here by name: **the toolPolicy activation leg**
(Step 7's exit criterion) and **the first live felt leg**
(ATTESTED_ON-gated, human-read).

## The vehicle — the existing dashboard app, justified

The Lab surface lives in **apps/dashboard** (pages) + **apps/server**
(routes), because everything a new app would need already exists there
with proofs attached: magic-link auth and session cookies (walkthrough leg
0), org scoping through `OrgContext`, the G2.3 role chokepoint with the
EXHAUSTIVE route inventory (every new route must be classified or the
build fails — exactly the discipline a new surface should be born into),
the G2.4 tenancy sweep that auto-probes cross-org access on inventory
rows, the SIMULATED-badge convention (dial honesty has a house style), and
the Gate 6 walkthrough harness for scripted end-to-end proof. A separate
app would duplicate auth and tenancy while dodging the inventory — refuted.
Lab pages sit under `/lab/*` behind the existing session auth; Gate C
(self-serve org creation) is untouched.

### Routes (apps/server, all `/api/lab/*` — every row in ROUTE_INVENTORY)

| Route | Guard | Purpose |
|---|---|---|
| `POST /api/lab/harnesses` | member | interview answers → `generateSpec` (Step 6) → persisted spec+sidecar, or draft/refusal passthrough |
| `GET /api/lab/harnesses` | viewer | list org harnesses |
| `GET /api/lab/harnesses/:hash` | viewer | spec + sidecar + dial views (Step 7 context) |
| `POST /api/lab/harnesses/:hash/dial` | admin | apply a dial position (motion + materialize) |
| `POST /api/lab/harnesses/:hash/felt` | member | felt sweep (cap-bound; cached) |
| `POST /api/lab/runs` | member | start a trial run (enqueue `lab:run`) |
| `GET /api/lab/runs/:id` | viewer | run row + steps — the narration/ticker read |
| `POST /api/lab/runs/:id/answer` | member | check-in reply → `answerLabRun` → re-enqueue |
| `POST /api/lab/runs/:id/kill` | admin | operator stop (`killLabRun`) |
| `GET /api/lab/runs/:id/report` | viewer | run report v1 |
| `GET /api/lab/memory/:hash` | viewer | memory entries, plain-language view |
| `PUT /api/lab/memory/:hash/:key` | member | edit an entry |
| `DELETE /api/lab/memory/:hash/:key` | admin | delete an entry (permanent) |

Every handler org-scopes through the session org (the Step 3 repos already
require orgId on every read/write — cross-org ids 404, never 403, the
existence-oracle rule). The tenancy sweep's crossOrgProbe covers each row.
**Mock/live separation**: run and felt surfaces render the provenance the
trace reported — a mock deployment shows SIMULATED badges on narration,
felt, and report; nothing model-generated is ever labeled live.

### Persistence for harnesses (schema-additive, rule 2, 0037)

Generated harnesses need a home: **`lab_harnesses`** (orgId FK NOT NULL,
harnessHash PK-with-org, name, specText, sidecar jsonb, clusterId,
createdAt) — the Step 3 ruling pattern; cascade coverage at birth via the
F5 meta-test; org-delete extended in the same commit. Runs already
reference specs by frozen copy (Step 3), so this table is the CATALOG, not
the runtime source of truth.

## The loop end to end

Interview page (the Step 6 four questions + optional constraints, one
plain form) → `POST /api/lab/harnesses` → generation result rendered
honestly: complete (spec summary + dial default + provenance), draft (the
open question, answerable inline), refusal (the typed reason, verbatim).
"Run a trial" → `POST /api/lab/runs` → **worker job `lab:run`** (new kind,
additive registration exactly like Step 5's; NOT spend-bearing beyond the
harness's own fuel, but SINGLE_ATTEMPT + delivery guard anyway — legs
resume, retries must not double-run) executes legs until terminal or
awaiting-human.

**Serving credentials for trial runs (custody design):** api_keys stores
hashes only, so the job cannot recover a raw org key. Each run mints an
EPHEMERAL run-scoped serve key (`lab-run-<runId>`, raw held only inside
the job invocation, hash stored via the existing key machinery, policyId =
the harness's materialized brain policy row, revoked at any terminal
state). The ServingClient rides it with the Step 7 pin headers
(`X-Potion-Policy` per slot, `X-Potion-Cluster` from the harness's
assigned cluster). Key mint/revoke are existing repo surfaces; the revoke
at terminal is asserted by test.

**Live narration** is polling over DURABLE rows — no streaming infra: the
run page polls `GET /api/lab/runs/:id` (1–2s) and renders the step
timeline (model step → excerpt; tool step → name+result excerpt; check-in
→ the question). Honest by construction: the narration IS the checkpoint
record (Step 4's replay reads the same rows).

**The cost ticker tells metered truth.** `StepPayload.estCostUsd` is the
runtime's deterministic FUEL estimate (flat token rate — measured fact,
recorded here), not attribution. The ticker joins each model step's
`completionId` to `request_logs` (the Step 7 `requestLogCostLookup`
pattern, batched) and shows **metered** cost per step and cumulative;
steps whose join hasn't resolved show the estimate LABELED "est." — two
numbers, two labels, never blended.

## The check-in surface (Step 3's pause machinery meets its first person)

An awaiting-human run renders `pendingQuestion` prominently with an answer
box. `POST /api/lab/runs/:id/answer` → `answerLabRun` (org-scoped by the
session org — the repo's own authz; a cross-org answer is a 404) →
re-enqueue `lab:run` → the leg resumes with consume-on-use semantics (one
answer, one external action — Step 3's rule, now user-visible). The page
shows the answer as a timeline entry. Authz test: user in org B cannot see
or answer org A's run (tenancy sweep row + direct test).

## Memory — view and edit in plain language

`GET /api/lab/memory/:hash` lists (key, value, updatedAt). Plain language
v1: string values render as text; structured values render as pretty JSON
with an "edit as text" box that stores `{ note: <text> }` on save —
recorded as the v1 simplification (Step 9's derived form does better).
**Deletion semantics, stated:** DELETE is permanent and immediate (no
tombstone); runs in flight are unaffected mid-leg because legs snapshot
`memoryReads` at leg start (Step 4's self-containment — replay of past
runs still works, their records carry what they read); the NEXT leg reads
the store as edited. Org deletion already cascades the table (0035).

## Run report v1 — evidence before advice

Assembled deterministically in `lab-runtime/src/report.ts` from durable
rows ONLY:

1. **What happened**: mission, outcome (completed / killed-budget /
   awaiting-human / failed+reason), step timeline summary, wall duration.
2. **What it cost**: metered total (request_logs join), per-step table,
   fuel cap and headroom; estimate-vs-metered labeled.
3. **Where it struggled — TYPED evidence, ranked:** the struggle taxonomy
   is a closed union assembled from recorded facts: `budget-killed`,
   `awaiting-human-wait` (duration), `not-connected-superpowers` (declared
   but unwired — see tool posture), `serving-retries` (rate-limit steps),
   `latency-violated`/`fallback-served` (from step traces), `spec-drift-refused`,
   generation-time gaps carried from the sidecar
   (`cluster-uncertain` answered late, `frontier-not-live`, …).
4. **Exactly ONE suggested upgrade**, chosen by a DETERMINISTIC priority
   ladder over the typed evidence (e.g. not-connected → "connect X (comes
   with superpowers)"; budget-killed → "raise worth/fuel"; latency
   violations → "loosen the latency tolerance"; no evidence → "raise the
   dial one rung", from the dial's own next view). **No model-generated
   advice in v1** — the plan's sentence is satisfied by evidence-sourced
   selection; a model may PHRASE upgrades in a later step, never choose
   them. This is the strictest reading of "evidence-sourced ... before any
   model-generated advice" and it is deliberately v1-cheap.

## Tool posture pre-MCP — typed, visible, never faked

Generated specs DECLARE superpowers; nothing can execute them until Step
10. The trial run passes **no tool definitions** (the loop's `tools` stays
empty), so the model cannot emit tool calls — no fakes, no
`unknown-tool` failures. The declared-but-unwired state is FIRST-CLASS:

- the harness page and run page render each superpower with a
  **`not-connected`** badge (typed in the DTO, not a UI string);
- the report's struggle section includes `not-connected-superpowers`
  whenever the spec declares any — with the honest sentence that the trial
  ran brain-only;
- the ONE upgrade slot prefers "connect X" when this evidence is present.

Never silent: a tool-bearing mission whose trial completes brain-only says
so in three places.

## The toolPolicy activation leg (carried DoD item 1 — Step 7's exit)

The loop learns slots (lab-runtime, additive): `StepPayload.slot:
'brain' | 'tools'` stamped per model step; calls that carry toolDefs are
`tools` steps served under `toolPolicy ?? brain` (its materialized ref via
per-call pin — ServingClient gains per-request header override, additive);
the loop issues one DELIBERATE tool-free call — the **final wrap-up step**
(a short "summarize what you did and whether the done-definition is met"
call with no tools) — served under `brain.policy`'s ref and stamped
`brain`. This wrap-up text also feeds the report's "what happened."
**The exit leg, verbatim from Step 7's criterion:** one walkthrough run
(with a test-local executable tool) whose step payloads carry BOTH slot
values, each call's `x-frontier-trace` showing `policy_override=` of its
slot's row. Replay note: goldens regenerate in the same commit (the loop's
request shape changes — Step 4's regeneration discipline applies and is
called out here in advance).

## The first live felt leg (carried DoD item 2)

Preconditions, all blocking: `ATTESTED_ON=<ISO date>` in env (the standing
rule — the script refuses without it), OPENROUTER key only (unset peers —
the Step 5 leg-script guard pattern), **cap $1.00** stated here, ledger
row before and after. Vehicle: boot the real server against the Step 5
campaign db (`.pglite/platform-sweep-step5` — ten LIVE platform
frontiers), felt 2–3 dial positions on 1–2 clusters through the real
route, **a human reads the samples** — the operator; the leg's output is
pasted into the ledger/status entry with the operator's read noted at
countersign. Expected spend at or- prices: $0.01–0.10; the $1 cap is
generous headroom and fail-closed (Step 7's sweep cap machinery).

## The ten-minute clock — how the DoD is measured

A SCRIPTED novice-shaped session (`apps/dashboard/scripts/lab-walkthrough.ts`,
the Gate 6 harness pattern, its own budget): boots server+dashboard
fresh-db, then performs ONLY what the UI affords, in order — sign in →
open /lab → type the four interview answers → submit → read the generated
summary → start the trial → poll the narration until the check-in appears
→ answer it → poll to completion → open the report and assert all four
sections render (including the single upgrade). **Wall clock from
interview submit to report rendered; asserts < 600s**; the script contains
zero knowledge a novice wouldn't have (no ids, no db reads on the driving
path — assertions may read the db to VERIFY, never to advance). Runs in
verify as the Lab's own gate leg, mock providers, $0.

## Review outcomes (operator approval, 2026-08-13) — folded in as binding

0. **Standing-rule amendment (docs-first, committed before code):** the
   ATTESTED_ON rotation attestation is superseded by the operator's
   risk-acceptance gate — `KEY_RISK_ACCEPTED=<ISO date>`, fail-closed;
   the operator accepts live spend on the current chat-transited
   OPENROUTER key on the basis of its provider-side cap; a future
   rotation supersedes. The Step 5 spec's open attestation item is closed
   by pointer.
1. **Serve-key death at EVERY terminal state, including fence/reclaim:**
   a fenced zombie invocation's ephemeral key is revoked or dies with the
   fence — proven BY TEST across the outcome enumeration (completed,
   killed-budget, failed, kill route, awaiting-human invocation-end, and
   the reclaim path revoking the zombie's key on entry).
2. **Catalog edits never touch run-frozen specs:** after editing a
   `lab_harnesses` row, a pre-edit run still replays byte-identically —
   proven by test, tying 0037 to the Step 4 invariants.
3. **The live felt leg runs under `KEY_RISK_ACCEPTED=2026-08-13`** with
   the $1 cap against the Step 5 campaign frontiers; the operator's
   reading of the samples is recorded as part of the leg's evidence (the
   samples land verbatim in the ledger; the reading completes at
   countersign).

## Package layout / touches

- `apps/server/src/routes/lab.ts` + ROUTE_INVENTORY rows + tenancy
  classification regeneration; DTOs strip internals (the G1.6 discipline).
- `apps/dashboard/app/lab/*` — plain pages (interview, harness, run,
  report, memory); `scripts/lab-walkthrough.ts`.
- `packages/workers`: job kind `lab:run` (registration checklist from
  Step 5), ephemeral-key mint/revoke inside the handler.
- `packages/lab-runtime`: slot stamping + wrap-up step + per-call policy
  ref override; `report.ts`; goldens regenerated same-commit.
- `packages/db`: 0037 `lab_harnesses` + repos + org-delete + (no other
  schema).
- Scripts: `step8-live-felt.ts` (ATTESTED_ON-gated, $1 cap).

## Test plan ($0 except the named live felt leg)

- Route inventory: every new row present (exhaustive test enforces);
  tenancy sweep crossOrgProbe green; role guards per table above.
- Loop: slot stamping (both values in a tool-bearing run; brain-only in a
  toolless run); wrap-up step exists and is tool-free; per-slot
  policy_override trace proof (the Step 7 exit leg); goldens regenerated
  byte-identical.
- Check-in: question surfaces; answer resumes; org-B blocked (404).
- Memory: edit round-trip; delete permanent; in-flight leg unaffected
  (memoryReads snapshot pin); next leg sees the edit.
- Report: each struggle-taxonomy code produced by ≥1 fixture (completeness
  both directions); the upgrade ladder deterministic (same evidence → same
  single upgrade); estimate-vs-metered labeling pin.
- Tool posture: declared superpowers → not-connected DTO badge + report
  evidence + upgrade preference; trial passes no toolDefs (structural pin
  on the run path).
- Ephemeral keys: minted at start, policy-bound, revoked at EVERY terminal
  state incl. kill (test enumerates outcomes).
- The ten-minute leg: wall-clocked, asserted < 600s, in verify.
- Gate 6 walkthrough stays green; verify unfiltered.

## Risks and pushback

- **The ten-minute clock in CI measures the mock path** — real novices face
  live latency. Recorded: the clock is the DoD's own definition
  (scripted, zero documentation); live timing arrives with real users.
- **Ephemeral keys add key-table churn** (one row per trial run, revoked).
  Bounded and auditable; a cleanup pass belongs to run retention (later).
- **Polling narration** (1–2s) is deliberately unsophisticated — durable
  rows are the truth; SSE/streaming is Step 9+ polish and would add a
  liveness surface with no honesty gain.
- **Report v1 without model phrasing** reads dry. Deliberate: the one
  upgrade must be evidence-chosen before it is ever well-worded.
- **The `lab:run` job executes user-authored missions in worker
  processes** — the fuel hard-stop, leg caps, and serving-side budget
  gates bound it; no tool execution exists pre-MCP. The adversarial pass
  over this surface is Step 12 by plan, noted here.

## Not in scope

MCP execution / OAuth / real tool wiring (Step 10); the derived form and
any visual polish (Step 9); SSE/streaming; model-phrased report prose;
user-supplied probe examples beyond the interview (recorded Step 6 debt);
standing-mission scheduling; multi-run dashboards (Step 14/16 surfaces).

## Build findings (recorded during the build phase, per protocol)

- **Calendar-rotted fixtures in pre-existing workers tests (2026-08-13).**
  On entering the build, 22 pre-existing tests across
  `packages/workers/src/traces.test.ts` and `suite-verify.test.ts` were
  failing with zero Step 8 involvement: their trace fixtures hardcoded
  `'2026-08-06T…'` timestamps, and the clustering window is `sinceDays: 7`
  back from *now* — the fixtures aged out of the window the day the
  calendar reached 2026-08-13 (one file's own comment says "recent sessions
  so the 7-day clustering window sees them"; they were recent when
  written). Fix: a module-level `FIXTURE_BASE_MS = Date.now() − 24h` base
  with minute offsets replacing every date literal, preserving relative
  ordering; the `2026-08-09`/`08-10` literals in suite-verify (still
  inside the window, due to rot within days) were converted in the same
  pass. Test-only change, no product code touched; determinism tests
  unaffected (they compare id/prompt/reference, and the base is constant
  within a run). Both suites green after: traces 32/32, workers 136/136.

- **Mock extraction fixture (additive, providers).** The mock provider had
  no answer shape for the generator's mission-interview extraction prompt —
  under a real mock deployment every interview refused
  `extraction-unparseable`, making the $0 novice loop impossible. Added
  `labExtractionFixtureText` behind `LAB_EXTRACTION_MARKER` in
  `packages/providers/src/mock/fixtures.ts`, the same Phase 1 additive
  discipline as the CONFIDENCE/PICK/decompose fixtures: a prompt that
  requests a machine-readable shape gets that exact shape, derived
  deterministically from the prompt's own embedded answers (no rng draws;
  ordinary prompts byte-identical).

- **Standing missions check in at half fuel (lab-gen assembly).** As
  specced, generated specs carried a check-in only when tool-bearing
  (`before-external-action`) — a trigger that structurally cannot fire
  pre-MCP (no toolDefs → no tool calls), while task missions complete on
  their first done-shaped answer. The scripted session's "poll until the
  check-in appears" leg was therefore UNREACHABLE for any generated spec.
  Resolution: `assembleSpec` now gives STANDING missions
  `{ trigger: 'on-budget-fraction', fraction: 0.5 }` — "a standing mission
  has no natural run in the user's head; a check does" (Step 6 review
  outcome 1's own rationale). The walkthrough novice builds a standing
  mission and hits the pause honestly. lab-gen goldens regenerated in the
  same commit (Step 4 regeneration discipline).

- **Mock tool-echo becomes call-then-answer (additive, providers).** The
  tool-call echo fixture answered EVERY tools-bearing request with another
  tool call, so no tool-bearing run could ever complete against the mock
  route (the activation leg's wrap-up was unreachable). Added: once the
  transcript carries a `[tool … result]` message, the mock answers with
  text — the call-then-answer shape of real models. Transcripts without
  tool results are byte-identical (all pre-existing fixtures/tests hold).

- **Where the Step 8 proofs live.** Key custody enumeration:
  `packages/workers/src/lab-run.test.ts` (10 tests — every exit + the
  fence/reclaim sweep, incl. terminal-no-op reaping and org/run scoping).
  Catalog-edit replay invariance:
  `packages/lab-runtime/src/catalog-invariance.test.ts`. toolPolicy
  activation (both slots, per-slot `policy_override=` trace proof, tool-free
  wrap-up): `packages/lab-runtime/src/walkthrough.test.ts`. Report ladder /
  taxonomy / est-vs-metered pins: `packages/lab-runtime/src/report.test.ts`.
  Tool posture in all three places: `apps/server/test/lab-posture.test.ts`.
  The ten-minute clock: `apps/dashboard/scripts/lab-walkthrough.ts`
  (measured 3.2s of the 600s budget at $0, mock).

- **The live felt leg's first run caught a leg-script custody bug — via the
  product's own divergence detector.** The script materialized BOTH rungs of
  a cluster under one harness-hash prefix; the dial-policy row name embeds
  only the first 12 chars of the hash, so both rungs shared one row, the
  second materialization overwrote the first, and rung 0's felt call served
  rung 2's policy. Step 7's strategy-mismatch detection returned the sample
  TYPED as divergent (expected 6efe8a56, served 10b2d052) and refused to
  cache it — exactly the failure mode the surface was built for, caught on
  its first live exercise. Fix: the rung discriminator leads the hash
  (`s8r<k><cluster>`), one policy row per rung; the re-run was clean (all
  samples match their views; zero divergence). Both runs are ledger rows.

## Pre-commit adversarial review (2026-08-13, standing practice)

Five-dimension finder swarm over the Step 8 diff (custody/tenancy, money,
replay/catalog, serving contract, concurrency/crash), 21 claims, each
adversarially verified by two independent refuters; verification was
completed by the operator's agent in the main loop for the eight claims
whose refuter agents died on usage-credit exhaustion (process note — the
verdicts below were reached by reading the code, same standard).

**Confirmed and FIXED (each with a pinned regression):**

1. Route-scoped `lab-io` ephemeral keys had NO reaper (unlike the lab-run
   keys' sweep) — a crash or swallowed revoke failure left a live
   credential row forever. Fix: hard `expiresAt` (15 min) on lab-io keys;
   the lab-run keys gained a 6h belt to the sweep's suspenders.
2. POST /api/lab/runs' cross-org probe was VACUOUS — the resource id
   travels in the body, which the sweep never substituted; all three probe
   arms were byte-identical. Fix: `resourceBodyField` on the inventory row
   + body substitution in the sweep — applied to the four pre-existing
   same-class rows too (live-sweep, research/cycle, rubrics/generate,
   certifications/run), all of which pass with REAL foreign ids (their org
   scoping was correct; only the probe was vacuous).
3. The answer route dropped `answerLabRun`'s guarded-update verdict — a
   lost race got a 202 and a spurious enqueue while the answer vanished.
   Fix: 409 `answer_not_accepted` when the guard loses.
4. The felt ROUTE materialized every position onto ONE policy row (the
   same 12-char name-prefix collapse the live leg exposed in the script) —
   every probe rode the last position's policy and clobbered an in-flight
   run's pin rows. Fix: per-position leading discriminator, disjoint from
   run pins.
5. The zombie-key sweep could revoke a LIVE invocation's key when a
   duplicate lab:run job arrived mid-leg. Fix: the sweep is gated on no
   unexpired claim — a dead winner's lease expires and the next entry
   sweeps; a healthy run is never disarmed.
6. Replay falsely diverged on a legitimately recorded tool-bearing run
   whose wrap-up FAILED at runtime (the loop tolerates that; replay did
   not). Fix: the wrap-up is optional under replay, matching the loop's
   own rule.
7. A FUEL check-in answer doubled as before-external-action authorization
   — "yes, keep going" would have approved an external action the human
   never saw. Fix: the recorded answer authorizes an external action only
   when the answered check-in WAS the external-action gate.
8. The wrap-up was a paid call issued even after the fuel cap was crossed.
   Fix: skipped when fuel is exhausted (the report already tolerates a
   missing wrap-up).
9. The live felt leg script NaN'd its ledger arithmetic and crashed on an
   unresolved metered cost. Fix: unresolved cost consumes the remaining
   cap (the sweep's own fail-closed rule) and prints as UNRESOLVED.

**Confirmed as ACCEPTED v1 semantics / residual risks (recorded, not
fixed this step):**

- Fuel is denominated in the flat token-rate ESTIMATE — premium rungs can
  meter well above `maxUsdPerRun` before the est-cap trips. This is the
  labeled Step 6 fuel currency; the org-level metered budget hard stop
  remains the outer belt, and the recorded WORTH_TO_FUEL_RATIO
  re-derivation path (from observed Step 8 traffic) is where fuel becomes
  measurement-priced.
- `lab:run` reads the catalog row per invocation for the serving
  clusterHint — an in-place catalog edit can redirect the remaining legs
  of an existing run to a different cluster. The frozen spec and replay
  are unaffected (steps record what was served); freezing the hint on the
  run row is a schema-additive follow-up, deferred.
- A dial move that lands on an ALREADY-CATALOGED hash replaces that row's
  sidecar — the catalog holds the LATEST provenance per content-addressed
  spec; both sidecars bind the same specHash, so nothing is orphaned.
- A worker crash mid-leg leaves the run 'running' until its lease expires;
  no automatic re-enqueue exists — the kill route is the operator
  recovery, and run retention owns the cleanup story.
- Refuted/vacuous claims from the finder pass (report torn reads,
  walkthrough poll masking, dashboard answer-box clearing, ensureLabIoPolicy
  insert race) were either killed by the refuters or fall below the
  fix-now line and ride the same v1-simplicity ledger as polling narration.
