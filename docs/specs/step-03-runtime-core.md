# Step 3 spec — Runtime core

Phase-one document per the binding protocol. Read before writing: the plan,
the roadmap, the status ledger, the Step 2 spec and `@potion/lab-spec`, and
the core surfaces cited inline (serving response shape `chat.ts:687,312`,
trace ingest `traces.ts:49-63`, the F5 schema-derived cascade meta-test
`org-delete.test.ts:113-117`, queue drivers, `readiness`/budget semantics).
Build-phase deviations get recorded here, never made silently.

## What Step 3 delivers

`@potion/lab-runtime`: the loop executor. A harness runs headless from a
file; every model call goes through serving as a client; per-step
checkpoints; pause-for-human as a first-class state; a mid-run budget hard
stop provably kills it; checkpoints survive the kill. Plus the harness
memory store and OTel span emission per the A3-verified ingest shape.

## One thing to push back on, and one tension to rule on

**Pushback — "always-on" is not in this step, and the spec refuses to fake
it.** The run loop is leg-per-invocation from day one: a run is durable rows
plus a resumable cursor, never a long-lived process. This is the plan's own
L4 sequencing ("heartbeat-shaped before always-on") pulled forward into the
architecture, so nothing built here has to be un-built.

**Tension for operator ruling — L0 says "zero core changes"; Step 3's memory
store says "org-scoped, deletion-cascade compliant." Both cannot be
literally true.** A deletion-cascade-compliant store means org-FK tables in
`@potion/db`, and the F5 meta-test (`org-delete.test.ts:113-117`) *derives
cascade obligations from the schema* — new org-FK tables fail the build
unless `deleteOrgCascade` handles them or they are exempted with a reason.
Three options:

1. **Recommended: narrow db addition.** New migration(s) for `lab_*` tables;
   `deleteOrgCascade` extended to erase them (an additive edit to one core
   file, forced by the F5 meta-test — the designed mechanism working). No
   guarantee code path reads these tables; guarantee *semantics* are
   untouched, which is what the additive contract protects.
2. Lab-private storage (files/SQLite): dodges the repo's tenancy machinery
   entirely — org-scoping and erasure become Lab-only promises with none of
   the structural tests behind them. The worse outcome dressed as
   compliance.
3. Defer the memory store: leaves the memory slot decorative, which the plan
   explicitly forbids for check-ins and by extension here.

The spec below assumes option 1. If the operator rules otherwise, this
section gets the recorded deviation.

## Package: `@potion/lab-runtime`

Dependencies: `@potion/lab-spec`, `@potion/core` (types, prices),
`@potion/db` (run/memory stores). **Not** `@potion/providers`, **not**
`@potion/harness`, **not** `@potion/queue` (no queue in this step —
triggers are L4). Dev-only: `@potion/server` (tests boot the real serving
surface). Two guards make "serving strictly as a client" structural:

- a dependency-list test asserting `@potion/providers` appears nowhere in
  the runtime's dependency tree (the mock-eligibility inventory will also
  flag any provider-resolution grep hit — welcome);
- all outbound calls go through one `ServingClient` module wrapping `fetch`
  against a `POTION_API` base URL + serving api key. In tests that URL is a
  real `buildServer()` instance listening on an ephemeral port — the actual
  route, the actual chokepoints (budget 429s, rate limiter, metering,
  breaker), mock providers behind them. There is no in-process shortcut to
  `execute()`; the route IS the contract.

## The run-state machine

```
pending ──▶ running ──▶ completed
              │ ▲           
              │ └──────── resuming (new invocation, verified identity)
              ├──▶ awaiting-human ──(answer recorded)──▶ running
              ├──▶ killed-budget     (serving 429 budget_exceeded — terminal)
              ├──▶ killed-operator   (explicit kill — terminal)
              └──▶ failed            (step error after retries — terminal)
```

- States are **rows, not process states**: `lab_runs.state` transitions are
  written before the transition's effects proceed, so a crash between
  transition and effect resumes conservatively (the F10 lesson: claim, then
  act).
- **`awaiting-human` is first-class.** A check-in trigger fires → the
  runtime writes the question + full checkpoint, flips state, and EXITS the
  invocation. Nothing polls. The answer arrives by CLI in this step
  (`lab-runtime resume <runId> --answer "…"`), is recorded as its own row
  (question, answer, asked-at, answered-at — the L5 bench replays these),
  and the same command continues the loop in the current process.
- **Terminal means terminal.** `killed-budget` does not resume — the F10
  discipline: re-running against a spent budget is how double-spend
  incidents start. A new run may be started from the old run's checkpoint
  explicitly (that is a FORK, a new runId, deliberate), never an implicit
  continuation.

### What "resume" means across sessions — precisely

A run is durable state; resuming is a **new invocation adopting it**:

1. Load `lab_runs` row + latest checkpoint + any unconsumed check-in answer.
2. **Verify identity before executing anything**: the stored spec content
   hash must equal the hash of the spec being resumed with
   (`harnessSpecHash`, Step 2). Mismatch → typed refusal
   (`spec-drift`): a run resumed under an edited spec is a *different
   harness* wearing the same runId — the F7 lesson applied to runs. The
   remedy is an explicit fork, never a silent continuation.
3. **Claim the run** (single-writer): `resume` performs a compare-and-set on
   `(state, invocation_seq)` — `awaiting-human → running` or
   `running@seq=N → running@seq=N+1` only if unchanged. Two concurrent
   resumes: one wins, one gets a typed refusal. Modeled on
   `job_executions`' claim-then-act.
4. Execute from `checkpoint.seq + 1`. Steps already checkpointed are never
   re-executed — a resumed run **must not re-buy step N's tokens** (the F10
   invariant at the run level).

## Checkpoint granularity — the contract Steps 4 and 16 build on

One checkpoint per completed step, and the checkpoint captures **what the
step actually saw and did, verbatim — never re-derivable inputs**. The
capstone lesson is standing: re-derivation is where drift hides.

Per-step record (`lab_run_steps`, one row per step, jsonb payload):

| Field | Why |
|---|---|
| `seq`, `runId`, `kind` (`model` \| `tool` \| `check-in`) | ordering + shape |
| `requestPayload` — the EXACT body sent to serving (messages after memory/rules injection, tools, stream flag) | Step 4 replay re-sends THIS, not a reconstruction; Step 16 fork edits from THIS |
| `responseText`, `toolCalls`, `finishReason` | what came back |
| `completionId` (`chatcmpl-…`, `chat.ts:687`) | the authoritative join to `request_logs` — spend, latency, provenance |
| `frontierTrace` (the `x-frontier-trace` header, verbatim) | cluster/strategy/policy/provenance per step, as served |
| `usage` (prompt/completion tokens from the response body) + `estCostUsd` (tokens × price table, **labeled estimate**) | per-step cost attribution NOW; the completionId join stays the truth |
| `toolInput` / `toolOutput` (tool steps) | replay substitutes these; fork can edit them |
| `memoryReads` (key → value **as seen**), `memoryWrites` | replay must not depend on the live store |
| `rngSeed`, `clockMs` (injected clock reading) | the two nondeterminism taps, recorded so replay can pin them |
| `checkInQuestion` / `checkInAnswer` (check-in steps) | bench replays the conversation with the human |

**Replay (Step 4) contract:** mock-mode replay = run the same loop with a
substituting ServingClient that answers step N's `requestPayload` with step
N's recorded response; byte-compare the resulting step stream.
**Fork (Step 16) contract:** fork-at-k = new run seeded with steps 1..k
verbatim; execution continues live from k+1. Both are possible from this
schema without rework because nothing in a step is re-derived from outside
the step.

Checkpoint write is transactional with the state cursor: step row + cursor
advance commit together (a crash never leaves a half-recorded step).

## The memory store

`lab_harness_memory(org_id FK, harness_hash, key, value, updated_at)`,
PK `(org_id, harness_hash, key)`.

- **Scoped by (org, harness), readable across runs of the same harness,
  never across harnesses** — enforced by key structure, not query
  discipline: every repo function takes `(orgId, harnessHash)` and there is
  no cross-harness read function to misuse.
- **Tenancy**: org-scoped by construction; the two-org isolation test
  pattern (`tenancy.test.ts`) applies as-is.
- **Deletion cascade**: erased by `deleteOrgCascade`, proven by the F5
  schema-derived meta-test the moment the FK exists (see the tension above).
- Writes go through the runtime only during a run, and each write is also in
  the step's `memoryWrites` — the store is a projection of the run history,
  which is what makes replay independent of it.

## Serving strictly as a client — the mechanics

- `ServingClient.complete()` → `POST /v1/chat/completions`, api-key auth,
  reads the OpenAI-shaped body + `x-frontier-trace` + completion id.
  Budget hard stop arrives as **429 `budget_exceeded`** (the F6-hardened
  path) → mapped to `killed-budget`, checkpoint retained, invocation exits.
  Rate-limit 429s are distinguished by body and retried with backoff
  honoring `retry-after`.
- Streaming: consumed when narration needs it (Step 8); this step uses
  non-stream + `stream_options.include_usage` semantics for byte-stable
  checkpoints.
- Tool-bearing steps send `tools`/`tool_choice` — valid only on `single`
  strategy points (A2). In this step the harness's `toolPolicy` is passed
  through and a serving 400 on a composite point is surfaced as a typed step
  failure; *making that 400 unreachable* is Step 7's partition, not this
  step's.
- Span emission: after each checkpoint batch, `POST /v1/traces` with
  `llm.call` spans per the verified shape (`traces.ts:49-63`) — trace_id =
  runId-derived, span per step, `gen_ai.operation.name: 'llm_call'`,
  completionId in attributes. Idempotent on (org, trace, span) so re-emission
  after a crash is safe. This is the A3 adapter, in Lab code, zero converter
  changes.

## Queue and clock semantics (driver-semantics lesson)

- **No queue.** The loop is in-process; resumability is checkpoint-based.
  When L4 adds triggers, F10's idempotency ledger already governs the job
  side; nothing here presumes queue semantics.
- **Clock and RNG are injected** (`Clock.now()`, `Rng.next()` seeded per
  run), recorded per step. The test double divergence table (required by the
  lesson): fake clock never jumps backwards, real one can (NTP) — recorded;
  fake sleep is instant, so timeout tests assert on *injected* durations,
  never wall-clock except the one real-timeout test marked as such.
- Per-step timeout via `AbortSignal` on fetch (F19 made serving honor
  cancellation end to end — the runtime rides that, another reason the
  client path is the right one).

## Definition of done (plan) → proof plan

| Plan's DoD | Proven by |
|---|---|
| harness runs headless from a file | walkthrough leg: `lab-runtime run fixture.harness.json` against a booted server, mock providers, completes a 3-step task mission |
| every model call writes its own metered row | after the run: `request_logs` rows join step `completionId`s 1:1 (count and ids asserted) |
| mid-run budget hard-stop provably kills it | walkthrough leg: org budget set so step 2 trips the 429 → state `killed-budget`, steps ≤1 checkpointed, no further serving calls (request count pinned) |
| checkpoints survive the kill | same leg: fresh process loads the run, reads steps, and a RESUME is refused with the terminal-state reason |
| pause-for-human is real | walkthrough leg: check-in trigger suspends → process EXITS → new invocation with `--answer` completes; the Q/A pair is in the run record |
| spec-drift refusal | resume with an edited spec → typed `spec-drift` refusal |
| concurrent resume | two resumes race; exactly one wins (CAS proven) |
| span emission | ingested spans visible via the traces read API, idempotent on re-emit |

Every new test also runs in isolation (standing rule). **Verify output is
retained unfiltered; if the Step-2 ledger's workers flake recurs, its name
gets captured and it becomes in-scope for this step, not noise.**

## Package layout

```
packages/lab-runtime/
  src/
    serving-client.ts   the ONE outbound module (fetch, auth, 429 taxonomy)
    state.ts            run-state machine + CAS transitions
    checkpoint.ts       step record read/write (transactional with cursor)
    loop.ts             the executor: next-step derivation, kinds, timeouts
    memory.ts           (org, harnessHash)-scoped store access
    spans.ts            llm.call emission per the ingest shape
    clock.ts            injected Clock/Rng + divergence notes
    cli.ts              run / resume / answer / kill
    *.test.ts
packages/db/drizzle/0035_lab_runtime.sql   (lab_runs, lab_run_steps,
                                            lab_harness_memory — pending the
                                            option-1 ruling above)
packages/db/src/repos/lab-runs.ts          (+ cascade extension + tests)
```

## Risks / what could go wrong

- **The cascade meta-test fires the moment 0035 lands** — that is the plan
  working; the cascade extension ships in the same commit or the build is
  red.
- **Checkpoint bloat**: `requestPayload` verbatim per step grows O(context²)
  across a long run. Accepted for v1 (correctness first), bounded by fuel;
  a size note lands in the step-record header and Step 4 revisits with
  content-addressed message storage if real runs hurt.
- **`estCostUsd` drift vs metered truth**: labeled an estimate, joined to
  `request_logs` by completionId for the truth; the walkthrough asserts the
  join, not the estimate.
- **Serving 400 on tools+composite** surfaces as a step failure until Step 7
  — documented in the runtime error taxonomy so it reads as "partition not
  yet enforced," not mystery.
- **Two sources of truth for memory** (store vs step `memoryWrites`) —
  resolved by direction: the store is a projection; replay reads steps only.

## Out of scope

Autopilot (6), dial enforcement (7), chat surface/narration (8), MCP (10),
triggers/schedules/queue (L4), deterministic replay itself (4 — this step
only guarantees its inputs exist), run routes (route inventory untouched —
CLI only).

---

## Review outcomes (operator ruling + additions, 2026-08-11)

**Ruling — memory store: option 1 confirmed.** All Step 3 org-FK tables
(runs, steps/checkpoints, memory) land in `@potion/db`: migration 0035,
`deleteOrgCascade` extended, F5 meta-test green in the same commit. L0's
"zero core changes" is hereby RESOLVED as **zero SEMANTIC core changes** —
schema-additive extensions land under rule 2, recorded as such, with cascade
coverage proven at birth. Lab-private storage rejected: it dodges the
tenancy machinery, and harness memory is the most privacy-sensitive data the
Lab will hold.

**Additions folded in as review outcomes:**

1. **Claim expiry for the resume CAS.** A winner that dies mid-run must not
   hold the claim forever. Design: lease (`claim_expires_at`) + fencing
   token (`invocation_seq`). Reclaim after expiry bumps the fence; EVERY
   write from an invocation carries its fence and is guarded
   `WHERE invocation_seq = mine` — a zombie winner's late writes are
   rejected, not merged. Tested: claim → expire → reclaim → zombie append
   fenced out.
2. **Checkpoints structurally cannot contain secret material.** The
   checkpoint writer runs lab-spec's secret scanner over the full step
   payload BEFORE write and refuses with a typed reason on any hit —
   fail-closed by construction, not review. Tested with planted key-shaped
   strings in tool output and model response.
3. **Cross-org non-readability of memory, runs, and checkpoints** proven on
   the multi-org fixture in the same commit as the tables.

---

## Build-phase deviations and findings (recorded per the binding protocol)

1. **`brain.policy` does not yet drive serving selection.** The runtime sends
   the documented `potion-auto` label; serving routes by cluster + the API
   KEY's policy. The spec's brain slot is recorded in the run but the dial
   wiring is Step 6/7 work, exactly as the phase plan sequences it — noted so
   nobody reads the slot as live before then.
2. **Check-in answer consumption semantics** (design decision made during
   build): a recorded answer authorizes the NEXT external action, once.
   Without consumption the resumed leg would re-ask on the very tool call the
   human just approved — an infinite politeness loop. One answer, one action.
3. **The org-budget mid-run kill leg was REDESIGNED after two falsifications,
   both recorded:**
   - A fresh `buildServer()` in the same process does NOT get a fresh budget
     gate cache — `hardStopCache` is module-scoped, shared across server
     instances in one process. This is F18's per-replica cache observed from
     the inside; a "new session" in-process is not a new session.
   - **Finding, ledger-worthy: some mock-stack serving calls meter
     `usage.costUsd = 0`** (measured — a fallback-path call landed cost 0
     while a code-gen-clustered call landed $0.00009). Month-to-date spend
     therefore may never cross a cap on mock, and the org gate CORRECTLY
     never fires. An org-budget mid-run kill keyed to metered mock spend is
     nondeterministic BY CONSTRUCTION. Resolution: leg 2a proves the org 429
     path first-touch (pre-seeded spend, deterministic); leg 2b proves the
     MID-RUN kill through the real route at the harness-fuel layer, which
     derives from response TOKENS (always present on mock). Live pricing
     makes the org-layer mid-run case deterministic on a real deployment —
     added to the deployment checklist rather than faked here.
4. **`releaseLabRunLease`** added to the repo (leg boundary for standing
   missions) — implied by leg-per-invocation, made explicit.
5. **`drizzle-orm` added as a devDependency** of lab-runtime (test assertions
   query rows directly); not a runtime dependency.
