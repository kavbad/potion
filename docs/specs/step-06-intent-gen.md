# Step 6 spec — Intent → spec generation

Phase-one document per the binding protocol. Read before writing: the plan
(Step 6: interview → autopilot slot-filling → first-class harness file,
"done when a plain-language mission produces a valid, runnable spec where
every autopilot choice traces to a frontier point"), the status ledger
including the Step 5 close (ten live platform frontiers, every point
providerMode-live with `suiteContentHash` provenance; ≥2 singles per
cluster), `@potion/lab-spec` (strict schemas, 12 typed issue codes, the
closure target), the compound-policy read surface (`Policy` union incl.
`compound {qualityFloor, p95Ms}` at core/types.ts:347-360, hard latency
bound; `selectPoint(policy, frontier)` core/select.ts:20), and
`loadCurrentFrontier` platform scope. Build-phase deviations get recorded
here, never silently.

## What Step 6 delivers

`@potion/lab-gen` (new package): a mission interview whose plain-language
answers become a **valid, hashed, runnable harness spec**, with every
autopilot decision carrying provenance to a live platform frontier point.
No UI, no MCP execution — superpowers in generated specs are declarations
only (scope guard, held by test).

## The mission interview — minimum question set

Four questions, one optional. Each maps to named slots; nothing else is
asked, nothing unasked is inferred silently.

| # | Question (plain language) | Slots filled |
|---|---|---|
| Q1 | "What should it do?" (free text) | `mission.goal` (normalized), cluster-assignment input, `name` (slug) |
| Q2 | "Is this a one-off task or a standing job?" — task: "how will it know it's done?"; standing: "what's the standing declaration?" | `mission.kind`; task → `mission.doneDefinition`; standing → goal carries the declaration; `memory.enabled` (standing → true, task → false) |
| Q3 | "Which accounts/services does it touch?" (list, may be empty) | `superpowers[]` — **declarations only**: name, description, `external: true`; no tokens, no config (Step 10 custody). Non-empty ⇒ a `checkIns` entry gating external actions (the runtime's consume-on-use answer semantics already enforce one-answer-one-action) |
| Q4 | "What is one run worth to you, in dollars?" | `fuel.maxUsdPerRun` (derivation below), `hardStop: true` (schema literal — non-negotiable) |
| Q5 (optional) | "Anything it must never do?" | `rules[]` verbatim (bounded by lab-spec's size caps) |

**Task vs standing is asked, never inferred** — the single highest-impact
mislabel a model extraction could make, so it is the one place the
interview refuses to guess.

**Worth → fuel derivation (product decision, flagged for review):**
`maxUsdPerRun = clamp(round(worth × 0.25, cent), $0.05, $5.00)`. A run
should cost a fraction of what it's worth (0.25 keeps 4× headroom between
value and spend); the $5 ceiling matches the org live-sweep default cap
scale. Pushback welcome — this constant is taste, and it is the only
unvalidated number in the mapping.

## Interview execution — the generator is a model call

Answer normalization (goal cleanup, done-definition sharpening, name slug,
cluster hint) is **one structured-extraction model call through
`ServingClient`** — the runtime's ONE outbound module, `potion-auto`,
metered per call into `request_logs` under the calling org, subject to the
org budget hard-stop like every other call in the product. Hard bounds:
**≤2 model calls per generation** (extraction + at most one repair pass),
extraction output is strict-zod-validated, and a second failed parse is a
typed refusal (`extraction-unparseable`) — the generator never free-writes
spec fields from model prose. Everything else — fuel arithmetic, scaffold
assembly, hashing, validation — is deterministic code. This split is what
makes the closure property provable.

## Cluster assignment — typed, degrades visibly

The mission maps to **one primary taxonomy cluster** (the brain slot's
serving cluster):

1. Deterministic lexical score against the ten cluster descriptors, plus
   the extraction call's cluster hint (the model may only choose from the
   taxonomy list — enforced by the extraction schema's enum).
2. Both agree with margin → `assigned(clusterId, basis)`.
3. Disagreement or low margin → **`cluster-uncertain`**: the generator
   returns a DRAFT (all deterministic slots filled) plus an open question
   naming the top candidates — it does not guess. Autopilot never fills a
   slot it cannot trace.

**Frontier gaps are typed, never smoothed** — for the assigned cluster:
`frontier-missing` (no platform frontier), `frontier-not-live` (any point
lacks `providerMode: 'live'` — the SIMULATED exclusion applied at the
consumer, exactly what Step 5's provenance was built for),
`no-single-points` (tool-bearing mission but no single-model points
survive on the frontier — impossible today per the Step 5 acceptance
table, structurally guarded anyway). Each yields the draft-plus-gaps
result, never a silently degraded spec.

```ts
type GenerationResult =
  | { kind: 'complete'; specText: string; spec: HarnessSpec; choices: AutopilotChoice[] }
  | { kind: 'draft'; partial: DraftSpec; gaps: GenerationGap[] };  // typed, per-gap remedies
```

## Autopilot slot-filling — provenance per choice

The Step 6 slot set is the **brain slot** (`brain.policy`); Step 7 grows
the per-slot dial. Filling:

- Load the assigned cluster's **latest platform frontier**; verify all
  points live (above).
- **The single-strategy partition, enforced by construction here** (ahead
  of Step 7's serving-side work): `superpowers.length > 0` ⇒ candidate
  points are filtered to `strategyConfig.type === 'single'` BEFORE
  selection; tool-free missions keep the full composite frontier. A
  Lab-generated spec can never pair tools with a composite — the partition
  is a filter in the generator, not a hope about serving's 400.
- Default dial position: the **quality knee** — the candidate point with
  the greatest quality-per-cost marginal gain (ties → higher quality).
  Expressed in the spec as the Lab policy subset's `compound`:
  `qualityFloor` = knee quality (floored to 2 decimals), `p95Ms` = knee
  `latencyP95` × 1.5 headroom — so the spec's policy REPRODUCES the choice
  through core's own `selectPoint` at serve time rather than naming a
  model. Step 7 makes this position user-movable; Step 6 records that the
  default embeds taste (knee) and flags it.
- **Every choice carries provenance**:

```ts
interface AutopilotChoice {
  slot: 'brain.policy';
  decision: LabPolicy;
  basis: {
    clusterId: string; frontierId: string; frontierVersion: number;
    strategyHash: string;               // the knee point
    providerMode: 'live';               // asserted, not assumed
    suiteContentHash?: string;          // Step 5's F7-at-birth stamp, carried
  };
  partition: 'single-only' | 'full';    // why the candidate set was what it was
  alternatives: number;                 // points considered
}
```

Choices ride a **sidecar** (`choices` in the result / `<name>.choices.json`
from the CLI), NOT inside the spec. Pushback recorded: embedding
generation metadata in the spec would either bloat the strict schema's
attack surface or force a hash-exclusion carve-out that muddies the F7
tamper-evidence story. The spec stays pure lab-spec; the DoD's "every
choice traces to a frontier point" is proven from the sidecar plus tests.

## The generated artifact

A first-class harness file: canonical JSON, embedded `hash` computed by
`harnessSpecHash`, **byte-identical through
`parseHarnessSpecText(specText)`** — the file the runtime runs is the file
the generator proved. `startRun` on a generated spec is the walkthrough
leg's final act.

## Closure property — generated specs always validate

**Property test (the load-bearing proof):** a seeded generative loop
(≥500 cases, no new deps — the repo's existing fuzz style) over interview
answers: benign, adversarial (injection prose — VALID by the Step 2
boundary pin, it is data), oversized fields, control characters, secret
material, empty/degenerate answers, every mission kind × superpower
combination. Invariant: the generator returns either `complete` with
`parseHarnessSpecText(specText).ok === true`, or a typed
refusal/draft-with-gaps — **an invalid spec is unrepresentable as an
output**. Secret material in answers is a typed refusal
(`secret-in-answers`, reusing lab-spec's `scanRawValue` at the earliest
layer) — never scrubbed-and-continued, because a spec whose provenance
includes a secret the user pasted is Step 10's custody problem born early.

**Golden interview fixtures (Step 2 style):** committed
`fixtures/golden/*.json` — interview answers + scripted extraction result
+ expected spec + expected choices, generated by a committed
byte-reproducible generator script (scripted ServingClient; the real model
call is exercised by the metering leg, not the goldens). Corpus:
task-simple, standing-memory, tools-external (partition = single-only),
tools-free-composite, cluster-uncertain (draft), frontier-not-live (gap),
secret-refusal, adversarial-prose. Completeness meta-tests both directions;
every `GenerationGap` code produced by ≥1 fixture.

## Test plan (all $0 — mock/scripted; live behavior inherits Step 5's frontiers)

- Mapping units: each question → slot, worth→fuel clamp edges, task/standing
  asymmetry (doneDefinition presence), memory default, checkIn injection
  for external superpowers.
- Partition: tool-bearing fixture frontier (singles + composites) → chosen
  point is single, `partition: 'single-only'`; composite-only frontier +
  tools → `no-single-points` gap, never a composite choice.
- Knee selection: hand-computed 4-point frontier fixture → exact expected
  point; the emitted compound policy re-selects the SAME point through
  core's `selectPoint` (the reproduce-through-serving pin).
- Provenance: choice basis matches the fixture frontier row byte-for-byte;
  `providerMode` 'live' asserted; mock-point frontier → `frontier-not-live`.
- Closure property loop + golden corpus + generator byte-reproducibility.
- Metering walkthrough leg: real `buildServer`, real route — one generation
  performs ≤2 metered calls attributed to the org, and the generated spec
  then RUNS (`startRun` → completed) against the same server: intent →
  valid spec → running harness, end to end.
- Scope guard: structural test that `@potion/lab-gen` imports no MCP/UI
  surface and generated superpowers carry no token/config fields.

## Review outcomes (operator approval, 2026-08-12) — folded in as binding

1. **Worth→fuel 0.25 approved as a provisional labeled constant**: named
   (`WORTH_TO_FUEL_RATIO`), rationale attached in code ("spend at most a
   quarter of the outcome's stated worth"), re-derivation path recorded —
   once Step 8 traffic exists, re-derive from observed
   cost-per-successful-run distributions. Interview phrasing: worth **per
   check/cycle** for standing missions, per run for tasks.
2. **The provenance sidecar is BOUND to the generated spec's content
   hash**: the sidecar carries `specHash = harnessSpecHash(spec)`; an
   edited spec visibly orphans its provenance (recompute ≠ recorded),
   proven by test via a typed binding-check helper.
3. **Golden corpus minimums**: one standing mission, one tool-bearing
   mission demonstrating the partition (tools+composite unrepresentable
   as output), one frontier-gap draft carrying its typed open question,
   one typed refusal.

## Build-phase deviations and notes (recorded, never silent)

1. **Exact-float qualityFloor, not "floored to 2 decimals"** as this spec
   originally wrote. Rounding down could admit a cheaper, lower-quality
   point above the rounded floor, and `selectPoint`'s min-cost comparator
   would then quietly re-select it at serve time. The knee's exact quality
   (a value copied from the frontier row, so byte-stable) makes the
   reproduce-through-serving assertion airtight; the assertion itself runs
   inside `fillBrainSlot` and throws on mismatch.
2. **`sanitizeVerbatim` added for user-verbatim rules** (control characters
   → spaces, trimmed): lab-spec rejects control characters, and a verbatim
   pass-through would have turned a pasted escape byte into a closure-gate
   crash instead of a working spec. Deterministic, tested.
3. **The extraction output is raw-scanned post-zod** (`scanRawValue` on the
   parsed extraction): a model echoing control characters or key-shaped
   content is a repairable parse failure, never something the assembler
   forwards. This closes the one model-written path into the spec.
4. **`GenerationResult` carries `refused` as a first-class kind**
   (`secret-in-answers` | `extraction-unparseable` | `serving-error`) —
   the spec's prose said "typed refusal"; the union now says it in types.
5. **Walkthrough legs split exactly as the test plan predicted**: the mock
   provider cannot emit extraction-schema JSON, so Leg A (real route)
   proves the metering join + call bound through the typed refusal path
   (2 metered calls, then `extraction-unparseable`), and Leg B proves the
   DoD end-to-end with scripted extraction + real frontier + real run
   (`startRun` → completed against the real server).
6. **Closure-property fuzz shape**: the first run produced only 18
   completes in 500 (a uniformly random cluster hint almost never agrees
   with the lexical scorer); the harness now draws matched hints 80% of
   the time, and the test enforces outcome-mix floors (>50 complete,
   >50 draft, >20 refused) so the property can never silently degenerate
   into a single-path fuzz.

## Pre-commit adversarial review (build phase, $0)

A two-lens review (closure/partition/provenance, contract/scope/fuel) with
two refuters per finding: 11 raw, **8 confirmed** (two describing the same
worth defect), 1 contested. The heavyweights were CONFIRMED BY EXECUTION —
the refuters ran the code. All fixed with pinned regressions:

1. **[high] Degenerate `worthUsd` (0/negative/NaN) crashed task
   generation** — raw copy into `mission.worthPerRunUsd` (z.positive())
   blew the closure gate as a throw, and the fuzz's worth pool was all
   positive. Fixed: deterministic pre-validation → typed refusal
   `invalid-worth` before any model call; worth pool now includes 0/-5/NaN;
   golden fixture added.
2. **[high] The knee/reselect assertion threw on legitimate 3-axis Pareto
   frontiers** (cheap high-quality slow + pricier equal-quality fast points
   coexist; the knee-derived policy admits the cheaper one and selectPoint
   picks it) — whole clusters would become ungenerable. Fixed by making
   **the policy the authority**: the recorded choice IS
   `selectPoint(policy, candidates)` — what serving will actually select —
   and the knee only shapes the policy. The R/M/K executed counterexample
   is now a committed regression test.
3. **[medium] One-way sidecar binding**: choices content wasn't bound by
   anything — a rewritten basis passed verification. Fixed: the sidecar
   carries `choicesHash` and `verifyChoicesBinding` checks both directions
   (edited spec orphans; tampered sidecar self-detects).
4. **[medium] Aggregate MAX_TOTAL_BYTES overflow**: per-field caps can all
   pass while the serialized spec exceeds 64KB → closure throw. Fixed:
   byte-length gate → typed refusal `answers-too-large`.
5. **[medium] Sanitation could CREATE a secret pattern** the raw scan
   missed (whitespace-dependent patterns completed by control-char→space).
   Fixed: the ASSEMBLED spec is re-scanned; hits are the same
   `secret-in-answers` refusal.
6. **[medium] Silent truncation of governance** (rules/accounts sliced to
   caps): violated "nothing unasked is inferred silently". Fixed: overflow
   is a typed `answers-too-large` refusal — truncated governance is
   corrupted governance.
7. **[medium] The model-echoes-control-char fuzz case was inert** (the
   intended control byte had been lost in authoring). Fixed with a direct
   repair-path unit test using an explicit `\\u0007` escape.
8. **[contested, recorded] The spec's CLI mention** (`<name>.choices.json`)
   — no CLI shipped this step; the sidecar is the library result and the
   walkthrough consumes it directly. Deviation: the CLI surface belongs to
   Step 8's chat loop, where the artifact actually meets a user.

## Risks and pushback

- **Cluster assignment is the weakest link** on real user language; the
  visible-degrade design converts silent-wrong into asked-question, so the
  residual is wrong-but-confident agreement between two weak signals.
  Recorded: the basis rides every choice, and Step 8's report is where it
  becomes user-visible.
- **The knee default embeds taste into autopilot.** Deliberate for Step 6
  (there must be a default before there is a dial); Step 7 makes it
  user-controlled. Flagged, not hidden.
- **Worth×0.25 fuel constant** — the one arbitrary number; operator review
  requested above.
- **Interview depth**: four questions cannot capture rich missions; rules
  and check-ins beyond the defaults arrive with Step 8's chat loop. The
  minimum set is a floor, recorded as such.
- Generation cost is negligible (≤2 small calls) but NOT free — it meters
  like everything else; the walkthrough leg proves the join.

## Not in scope

UI of any kind (Step 8); MCP execution, OAuth, token custody (Step 10);
the dial and felt samples (Step 7); per-superpower slots beyond the brain
slot; standing-mission scheduling; any change to serving, lab-runtime, or
lab-spec semantics (lab-spec gains nothing — closure is proven against it
as it stands; if the build phase discovers a needed schema change, that is
a recorded deviation requiring its own justification).
