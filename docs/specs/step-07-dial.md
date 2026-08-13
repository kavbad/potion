# Step 7 spec — The dial

Phase-one document per the binding protocol. Read before writing: the plan
(Step 7: compound policy read per slot and per harness — touchpoint 2; the
partition enforced by construction; felt samples as eval runs at dial
points; "done when a dial move produces measured, demonstrable differences,
and no Lab-generated config can request tools on a composite strategy"),
the status ledger, the Step 6 spec (the **policy-is-the-authority**
resolution and the executed 3-axis R/M/K counterexample), core's
`selectPoint` (select.ts:20 — compound = min cost within quality floor ∩
latency bound, ties → higher quality) and `fastestQualityQualifyingPoint`,
the serving chat route's **existing** per-request pins (`X-Potion-Policy`
policy override, chat.ts:420-458; `X-Potion-Cluster`, chat.ts:460+; both
recorded in request_logs and echoed on `x-frontier-trace`), the ten live
platform frontiers from Step 5, and the Step 3 loop's tool attachment
(loop.ts:241 — tools ride EVERY model call of a tool-bearing harness).
Build-phase deviations get recorded here, never silently.

## The grounding discovery that shapes everything

**Touchpoint 2 already exists in serving, fully formed.** `X-Potion-Policy`
is a per-request policy override resolved within the caller's org, applied
through the same `selectPoint` that serves every request, logged to
`request_logs.policy_id`, and echoed on `x-frontier-trace`
(`policy=<type>;policy_override=<name>`). The dial therefore needs ZERO
serving changes: a dial position becomes an org policy row, the runtime and
the felt sampler send its ref, and serving's own selector — the single
authority — resolves it. "Displayed and served cannot diverge" stops being
a discipline and becomes an assertion against the trace header.

## What Step 7 delivers

`@potion/lab-dial` (new package): dial geometry over live platform
frontiers, per-harness and per-slot positions, spec motion (a dial move is
a spec edit — new text, new hash, new sidecar), policy materialization
(touchpoint 2 as it exists), felt samples through ServingClient with
durable caching, and typed degradation throughout. Headless: the dial is
an API operation until Step 8.

## Dial geometry — a path through a 3-axis space, defined exactly

The frontier is a finite Pareto set over (quality, costPer1K, latencyP95).
A 1-D dial over a 3-axis space must choose its projection honestly:

- **Eligible set `E(slot)`**: the latest platform frontier's points for the
  harness's assigned cluster; **all points must be providerMode live**
  (any SIMULATED point → typed `frontier-not-live`, the Step 6 consumer
  gate reused verbatim); filtered to `type === 'single'` when the slot is
  tool-bearing — the partition applied BEFORE ladder construction, so no
  position in a tool dial's domain can map to a composite. **Unrepresentable
  through motion**, not checked after it.
- **The quality ladder `Q`**: the distinct quality values of `E`,
  ascending, **exact floats copied from frontier rows** (the Step 6
  no-rounding discipline). The ladder is the dial's primary axis.
- **The latency tolerance `T`**: the second, optional knob. Default =
  `ceil(max latencyP95 over E × 1.5)` — deliberately never binding until
  the user tightens it.
- **A DialPosition** = `{ qualityIndex k, toleranceMs? }` →
  **emitted policy** = `compound { qualityFloor: Q[k], p95Ms: T }`.

**3-axis knees and ties are what the tolerance knob EXPOSES, not a
problem to smooth over.** The Step 6 counterexample (R cheap/0.9q/1300ms,
M mid/0.3q/40ms, K pricier/0.9q/900ms — mutually non-dominated): the
ladder is [0.3, 0.9]; at q=0.9 with default tolerance, `selectPoint`
serves R ($1.00); tighten T below 1300ms and it serves K ($1.15); tighten
below 900ms and the position is **`position-infeasible`** — a typed dial
outcome carrying a relax hint (the minimum tolerance that restores
feasibility, computed from `E` and labeled a HINT — the one value not
sourced from a selected point, and marked as such). Equal quality AND
equal cost ties resolve inside `selectPoint` (higher quality, then its
comparator) — the dial inherits, never reimplements.

## One selection authority

Every projection shown for a dial position — strategy, cost, quality,
latency, provenance — is read from **the point `selectPoint(policy, E)`
returns**, and nothing else. The module never reads point fields except
through that result. Three layers, one function:

1. **The view** (`dialViews`): local `selectPoint` from `@potion/core`.
2. **The felt sample**: serving's `selectPoint` under the same policy via
   `X-Potion-Policy` — the strategy hash parsed from `x-frontier-trace`.
3. **The run**: the runtime's calls under the same header.

The view records `frontierId`/`frontierVersion`; the walkthrough asserts
view.strategyHash === felt trace strategy === run trace strategy on the
same frontier version. A version race between read and serve is visible
(versions differ), never silent.

## Per-harness vs per-slot, and the precedence truth

Slots: **brain** (`brain.policy`, the per-harness default) and **tools**
(`brain.toolPolicy`, the per-slot override lab-spec already carries).
Precedence: effective policy for tool-bearing steps =
`toolPolicy ?? brain.policy`; tool-free steps always use `brain.policy`.

**Stated honestly:** the Step 3 loop attaches tools to EVERY model call of
a tool-bearing harness (loop.ts:241), so today such a harness has no
tool-free steps — both dials sweep the single-only domain and `toolPolicy`
is materialized but behaviorally equivalent to the brain dial until the
loop distinguishes tool-free steps (recorded as Step 8+ work, a
deviation-in-advance rather than a quiet fiction). Tool-free harnesses
have exactly one meaningful dial (brain, full domain incl. composites).

## Spec motion — a dial move is a spec edit

Applying a position rewrites the spec (`brain.policy` / `brain.toolPolicy`),
re-canonicalizes, re-hashes, and emits a **new sidecar** whose choice
carries the new basis (from the authority's selected point) — F7 discipline
carried through motion: the old spec+sidecar stay valid, hash-bound
history; the new pair binds two-way (`specHash` + `choicesHash`, the Step 6
mechanism unchanged). `verifyChoicesBinding` needs no changes.

## Policy materialization (touchpoint 2, consumed as it exists)

A dial position is made servable by upserting an org policy row:
deterministic id `pol-lab-<harnessHash12>-<slot>`, name
`lab-<harnessHash12>-<slot>`, config = the emitted compound policy. The
runtime's `ServingClient` gains an optional `policyRef` (and `clusterHint`)
that ride as `X-Potion-Policy` / `X-Potion-Cluster` headers — an additive
lab-runtime change, recorded. `runLeg` threads them when given. Serving
does the rest exactly as shipped in M4/M5: resolution, logging,
trace echo, and its own 400 on tools+composite stays the outer moat the
partition makes unreachable from Lab paths.

Deterministic ids make re-materialization idempotent (upsert by id); a
dial move overwrites the harness's own row and no one else's. Policy rows
are org-scoped and already covered by `deleteOrgCascade`.

## Felt samples — eval runs at dial points, through the ONE outbound module

**The probe ("the user's own task", headless):** derived deterministically
from the mission — a single user message built from `normalizedGoal` (+
`doneDefinition` for tasks), `probeHash = sha256(canonicalJson({goal,
doneDefinition}))`. One probe per harness in v1; Step 8 lets users supply
real examples.

**Execution:** `ServingClient.complete` with `X-Potion-Policy` (the
position's row) + `X-Potion-Cluster` (the assigned cluster) — touchpoint 1
holds, no provider path exists in Lab code, and serving meters the call
like any customer request. The felt result = { sample output, measured
wall-clock latency, metered cost (from the completion's request_logs join),
strategyHash + frontier version + **provenance** parsed from
`x-frontier-trace` }. A mock-provenance felt sample is LABELED simulated
in the result — dial honesty at the felt layer; it is never presented as
live feel.

**Sweep size and cap:** a felt sweep samples up to
`FELT_SWEEP_MAX_POSITIONS = 3` positions (cheapest eligible, the current
position, highest quality) under `FELT_SWEEP_CAP_USD` (default **$0.25**,
fail-closed: projected-next-call-exceeds-remaining → typed
`felt-cap-reached` with partial results). Single-position sampling is also
exposed.

**Caching (repeated positions cost nothing):** migration **0036
`lab_felt_samples`** — org-scoped rows keyed by (orgId, probeHash,
strategyHash, policy content hash, frontierId), storing output, costUsd,
latencyMs, completionId, provenance. A cache hit returns the stored sample
with `cached: true` and makes NO serving call — proven by request_logs
count invariant. Schema-additive core work under rule 2, the Step 3 ruling
pattern: org-FK with cascade coverage at birth (the F5 schema-derived
meta-test picks the table up automatically; the org-delete walkthrough leg
must stay green in the same commit).

**Live felt legs** run only under the standing `ATTESTED_ON` rule and the
stated cap. **Pushback, recorded:** this spec proposes NO live felt leg in
Step 7 — the felt mechanism's honesty (provenance labeling, caching,
metering) is fully provable at $0 against the real route with mock
providers, and live "feel" earns its money in Step 8 where a human reads
the samples. If the operator wants a live felt leg now, it is one
`ATTESTED_ON`-gated micro-leg (≤$1) using the Step 5 campaign db's
frontiers; otherwise Step 7 spends $0.

## Typed degradation — the dial's failure vocabulary

```ts
type DialGap =
  | { code: 'frontier-missing'; clusterId }        // Step 6 gaps, reused
  | { code: 'frontier-not-live'; clusterId; frontierId }
  | { code: 'no-single-points'; clusterId; frontierId }   // tool slot only
  | { code: 'position-infeasible'; position; relaxHintMs } // tolerance excludes the quality level
  | { code: 'felt-cap-reached'; sampled; capUsd };  // partial felt sweep
```
Every code produced by ≥1 golden fixture; completeness both directions
(the Step 2 discipline). A dial region with no live-evidenced points
degrades visibly at the consumer — the Step 5 provenance doing its job a
third time.

## Golden dial sweeps — byte-reproducible fixtures

Committed generator (Step 2/4/6 pattern), fixtures pinning the FULL
`DialView[]` + gap outcomes:

| Fixture | Pins |
|---|---|
| `ladder-simple` | 2-axis frontier → monotone ladder, cost strictly rises with quality |
| `three-axis-rmk` | the Step 6 R/M/K case: default T → R; T=1000 → K; T=30 → `position-infeasible` with relax hint 900 |
| `tool-partition-sweep` | tools slot on a singles+composite frontier: composite ABSENT from every position across the full sweep (unrepresentable through motion) |
| `tie-quality-cost` | equal quality+cost points → selectPoint's tiebreak, deterministic |
| `not-live` | one mock point → `frontier-not-live` |
| `felt-cache` | felt sweep twice: second pass all `cached: true` (generator uses a scripted client; the REAL cache proof is the walkthrough's request_logs invariant) |

## Test plan (all $0)

- Geometry units: ladder construction (distinct exact floats), default
  tolerance derivation, position→policy mapping, relax-hint correctness on
  the R/M/K fixture.
- One-authority structural test: `geometry.ts` reads no point fields
  outside the `selectPoint` result (source-level fence, Step 4 style).
- Partition under motion: property loop — for seeded frontiers with
  composites, EVERY position of a tool-slot sweep maps to a single; the
  serving-400 pairing is unreachable from any dial output.
- Spec motion: dial move → new spec parses (lab-spec closure), old sidecar
  orphaned against new spec, new sidecar binds two-way.
- Materialization: deterministic policy row ids, idempotent upsert,
  org-scoped; `resolvePolicyRef` finds them by name.
- Felt: cache-hit invariant (request_logs count unchanged), cap refusal
  typed with partials, provenance labeling (mock trace → simulated label).
- Walkthrough (the DoD): real `buildServer`, seeded live-labeled frontier →
  (1) dial views; felt sweep ×2, second all-cached, $0 delta;
  (2) dial move → new spec + policy row → `runLeg` with the header →
  `x-frontier-trace` strategy === the view's strategyHash — displayed and
  served identical; (3) tolerance move on the R/M/K frontier → a DIFFERENT
  measured strategy serves — a dial move producing measured, demonstrable
  differences; (4) tool harness: full sweep never touches the composite and
  serving's 400 is never triggered.
- Verify output unfiltered; Gate 6 walkthrough green (guarantee product
  untouched).

## Package layout

`packages/lab-dial/`: `geometry.ts` (pure), `motion.ts` (spec edit +
sidecar), `materialize.ts` (policy rows), `felt.ts` (probe, sweep, cache),
`gaps.ts`, `index.ts`; `fixtures/generate-golden.mjs` + `fixtures/golden/`;
tests per plan. Deps: `@potion/core`, `@potion/lab-spec`,
`@potion/lab-gen` (sidecar types + gap reuse), `@potion/lab-runtime`
(ServingClient), `@potion/db` (policy rows + felt cache). The lab-runtime
`ServingClient` header support and migration 0036 are the two touches
outside the new package — both additive, both recorded.

## Risks and pushback

- **The tolerance knob doubles the dial's cognitive surface.** Deliberate:
  a single-knob dial over a 3-axis space must either hide latency (dial
  dishonesty — the R/K distinction becomes invisible) or expose it. Step 9's
  derived form decides how it LOOKS; Step 7 makes it true.
- **`toolPolicy` is behaviorally inert until the loop distinguishes
  tool-free steps** — materialized and correct, but equivalent to the brain
  dial for tool-bearing harnesses today. Recorded above; Step 8+ work.
- **Policy-row proliferation**: two rows per dialed harness, deterministic
  ids, org-scoped, cascade-covered. Bounded by harness count; a cleanup
  pass belongs to harness deletion (Step 14 surface).
- **Felt cost model**: single probe calls at or- prices are ~$0.001–0.05;
  the $0.25 sweep cap is generous. The constant is labeled and adjustable;
  no forecast table needed at this size, but the cap is still fail-closed
  and ATTESTED_ON still gates any live leg.
- **Frontier version races** between view and serve are made visible
  (version stamped on both sides), not prevented — prevention would need a
  serving-side pin-by-version, deliberately not built at Step 7.

## Not in scope

UI (Step 8/9); per-request point pinning by strategy hash (the policy ref
is the pin); loop changes to distinguish tool-free steps; live felt legs
(proposed $0 — operator may commission the ≤$1 micro-leg); user-supplied
probe examples (Step 8); any serving change whatsoever.
