# Step 4 spec — Run records and deterministic replay

Phase-one document per the binding protocol. Read before writing: the plan,
the status ledger, the Step 3 spec (including its recorded deviations — the
$0-mock-cost finding and the module-scoped budget cache), the checkpoint
schema (`packages/lab-runtime/src/checkpoint.ts`, `lab_run_steps`), and the
step-synthesis read model (`packages/db/src/repos/traces.ts:261-297`).
Build-phase deviations get recorded here, never silently.

## What Step 4 delivers

Two things, per the plan: **a recorded run replays deterministically**, and
**its steps land as eval items through the existing step-synthesis path with
zero converter changes**. Plus the golden corpus that makes both claims
regression-proof.

## The two meanings of "replay" — and which carries the DoD

**1. Pure playback (CARRIES THE DEFINITION OF DONE).** Re-run the loop with a
`PlaybackClient` that answers from the record: step N's `requestPayload` is
answered with step N's recorded response; tool executions are substituted
from recorded `toolOutput`; memory reads come from recorded `memoryReads`;
clock and RNG are pinned from recorded `clockMs`/`rngSample`. **Zero provider
calls, zero serving calls, zero network.** What playback actually proves is
the load-bearing property: *the record is self-contained and the loop is a
deterministic function of it* — given the recorded responses, the loop
re-derives every request byte-identically and re-reaches the same terminal
state. That is exactly the property Step 16's fork-from-step needs (fork = a
playback prefix that goes live at k+1), so the DoD sits here.

**2. Mock re-execution (NOT the DoD — a diagnostic, deliberately).** A fresh
run against real mock serving under injected clock/RNG. Not deterministic
end-to-end **by the codebase's own measurements**: strategy selection moves
with frontier state, and Step 3 recorded that cluster routing can land a
fallback path (the $0-cost finding). Re-execution equivalence is a *drift
detector* — divergence is information, not failure — and belongs to the L5
bench.

**Pushback (recorded):** the plan's phrase "deterministic mock-provider mode
for harness runs" reads as a runtime-owned mock mode. Building one would
duplicate serving's mock path inside the Lab and create a second
mock-vs-live boundary to police — the false-live class re-armed. This spec
satisfies the sentence's *intent* (deterministic replay under mock/live
invariants) with playback + the real mock serving, and builds no
runtime-private provider mode. If the operator wants re-execution machinery
now rather than at L5, that is the one scope question to settle at review.

## The equivalence relation, precisely

Replay produces a step stream; equivalence to the record is checked per step
and for the stream as a whole:

**Must match byte-for-byte** (via `canonicalJson`):
- per step: `kind`, `requestPayload` (the loop RE-DERIVES this during
  playback — this comparison is the theorem), `toolName`, `toolInput`,
  `memoryReads`, `memoryWrites`, check-in trigger/question/answer;
- stream shape: step count, seq order, kinds sequence;
- terminal state + state reason class (`completed` / `killed-budget(fuel)` /
  `awaiting-human` at the same seq).

**Copied from the record, so equal by construction** (asserted anyway, cheap):
`responseText`, `toolCalls`, `finishReason`, `completionId`, `frontierTrace`,
`usage`, `clockMs`, `rngSample`.

**Excluded, with reasons:** database row timestamps (`created_at` — not part
of the record's meaning); `estCostUsd` recomputation is asserted equal since
its inputs are recorded.

### The divergence report — typed, like every refusal in this repo

```ts
type ReplayDivergenceCode =
  | 'request-drift'      // re-derived requestPayload differs at seq N — THE failure
  | 'stream-shape'       // step count / kind sequence differs
  | 'terminal-state'     // replay ended in a different state or at a different seq
  | 'record-exhausted'   // loop asked for a step the record does not contain
  | 'record-unconsumed'  // record has steps the replay never reached
  | 'payload-mismatch';  // a copied field failed its consistency assertion

interface ReplayDivergence { code; seq; field?; expectedHash; actualHash; excerpt }
replayRun(...): { ok: true; steps } | { ok: false; divergences: ReplayDivergence[] }
```

All divergences collected, not first-failure (the Step 2 discipline).
Hashes rather than full payloads in the report; excerpts capped.

## Inertness — playback writes NOTHING, proven

Playback constructs its run state **in memory**: no `lab_runs` row, no
`lab_run_steps` writes, no memory-store writes, no spans, and above all **no
`request_logs` rows and no metered spend** — playback never speaks to
serving, so the Step 3 $0-mock-cost nondeterminism cannot touch it.

Proven as a table-count invariant, not an assertion of intent: the replay
test snapshots `count(*)` of `request_logs`, `trace_spans`, `lab_runs`,
`lab_run_steps`, `lab_harness_memory`, `usage_daily` before and after a full
playback and asserts all six unchanged. A future edit that makes playback
write anything fails this test by construction.

Structural guard in the same style as Step 3's no-provider-imports test:
`replay.ts` and `playback-client.ts` must not import `ServingClient` or
anything from `@potion/db`'s write surface (they receive *loaded steps*, not
a db handle — the type signature is the fence: `replayRun(spec, steps[])`).

## The golden corpus — generated, never hand-written

`packages/lab-runtime/fixtures/golden/*.json`, produced by a committed
generator script (`fixtures/generate-golden.mjs`, the Step 2 pattern): each
fixture is a **recorded run** — spec + ordered step payloads + terminal
state — captured by running the real loop against a scripted client with
**fixed ids** (deterministic runIds, sequenced completionIds, fixed clock
start, the run-seeded RNG). Regenerating produces byte-identical files; a
test asserts that (the generator IS reproducible, not just its output
committed).

Corpus (each also a replay test case, plus completeness meta-tests both
directions in the Step 2 style):

| Fixture | Exercises |
|---|---|
| `task-simple` | one model step, completion |
| `task-tools` | model → tool → model, memory write projected |
| `checkin-suspend-resume` | suspend at external action, answer, resume, complete — replay crosses the invocation boundary |
| `fuel-killed` | partial record ending in `killed-budget(fuel)` — replay reproduces the kill at the same seq |
| `standing-legcap` | leg cap, non-terminal record |
| `memory-carry` | second run of the same harness reading memory the first wrote — `memoryReads` recorded as seen |

Adversarial replay fixtures (corrupted copies, generated from the golden
ones): a step deleted (`record-exhausted` or `stream-shape`), a
`requestPayload` byte flipped (`request-drift`), terminal state edited
(`terminal-state`) — each asserted to produce its named divergence code,
fails-for-the-right-reason.

## Steps → eval items, zero converter changes

**The measured gap:** the synthesis read model consumes
`gen_ai.prompt` / `gen_ai.completion` on `llm.call` spans and
`tool.args` / `tool.result` on `tool.*` spans, builds `contextBefore` from
the running sequence, and **skips any llm.call span with no completion**
(`repos/traces.ts:282-297`). Step 3's spans carry tokens and completionId
but no content — so today a Lab run synthesizes to zero items. The fix is
entirely in the Lab's emitter (`spans.ts`), which is exactly what A3
predicted ("the runtime emits §14.1-shaped spans; the converter never needs
to generalize"):

- llm.call spans gain `gen_ai.prompt` (the step's *last user-visible turn*
  from the recorded requestPayload), `gen_ai.completion` (recorded
  responseText), `potion.step_index` (seq);
- tool steps emit `tool.<name>` spans with `tool.args`/`tool.result` from
  the recorded toolInput/toolOutput;
- content comes from **checkpoints, which passed the secret gate** — and
  ingest-time redaction (G1.1) still applies on the server side, unchanged.

**E2E walkthrough leg** (extends Step 3's span-ingestion leg): real-server
run with a tool → enriched spans ingested via `POST /v1/traces` →
`tracesClusterHandler` invoked exactly as `traces.test.ts` does → assert an
agent cluster forms and the derived `-replays-v2` suite contains step items
whose prompt text matches the recorded step context and whose reference is
the recorded completion. **Zero changes** under `scripts/`,
`packages/workers/`, or `packages/db/src/repos/traces.ts` — proven by the
commit diff, stated in the ledger.

One consequence to name: span payloads grow (content, not just counts).
The ingest batch cap (`TRACES_BATCH_CAP`) and per-span attribute sizes are
server-enforced already; the emitter chunks batches and truncates
`gen_ai.prompt` to the ingest limit **with a recorded marker** if a step's
context exceeds it — truncation without a marker would silently break the
"context the call saw" promise, so the marker is part of the contract.

## Package layout (extension, not a new package)

Replay is a consumer of `StepPayload` and nothing else — a new package would
add workspace surface to hold two files. Decision: extend `lab-runtime`.

```
packages/lab-runtime/
  src/playback-client.ts   answers from the record; no network, no db
  src/replay.ts            replayRun(spec, steps[]) → equivalence | divergences
  src/spans.ts             ENRICHED (gen_ai.prompt/completion, tool.* spans)
  src/replay.test.ts       corpus playback + adversarial divergences + inertness
  src/synthesis.test.ts    the E2E eval-items walkthrough leg
  fixtures/golden/*.json   + expected.ts + generate-golden.mjs
```

## Test plan

- Corpus: every golden fixture replays `ok: true`; every adversarial mutant
  produces its named divergence; completeness meta-tests (every file
  classified / every classification present / every divergence code produced
  by ≥1 fixture — the dead-reason-code rule).
- Inertness: the six-table count invariant around a full playback.
- Generator reproducibility: regenerate → byte-identical.
- Synthesis E2E as above; plus the emitter's truncation marker unit test.
- `assertReproducible` discipline: two playbacks of the same record produce
  byte-identical step streams.
- Every new test also run in isolation; verify output retained unfiltered;
  if the Step-2 workers flake recurs, capture the name, in-scope.

## Risks / what could go wrong

- **Conversation reconstruction is the theorem under test** — if Step 3's
  `conversationFromSteps` has an order-dependence bug, `request-drift` will
  surface it. That is the point; expect possible Step 3 fixes recorded as
  findings, not silently patched.
- **Span content limits**: a long run's context may exceed ingest caps —
  handled by the marker contract above, tested.
- **Fixture brittleness vs loop evolution**: golden fixtures pin today's
  request-building (system prompt text included). A deliberate prompt change
  in a later step will fail replay tests — correct behavior; the fixture
  regenerates in the same commit that changes the prompt, reviewed as such.
- **PII/secrets in fixtures**: fixtures come from scripted runs with
  synthetic content; the Step 2 secret patterns run over the generated files
  in the generator itself, refusing to write a fixture that would trip the
  checkpoint gate.

## Out of scope

The bench UI and fork-from-step execution (Step 16 — this step guarantees
their inputs); re-execution drift tooling (L5); any converter, workers, or
serving change; routes (none — still CLI/test surface only).
