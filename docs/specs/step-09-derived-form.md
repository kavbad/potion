# Step 9 spec — The derived form [design gate]

Phase one of Step 9 per `docs/LAB-BUILD-PLAN.md`. This is the design gate:
the operator's taste review is part of the exit, so this phase produces
**artifacts to look at** — a browser-viewable motion study driven entirely
by measured data (`docs/design/step-09-motion-study.html` +
`step-09-captured-data.json`) — alongside this implementation spec. The
build phase starts only on operator approval; deviations land here, never
silently.

**Standing decisions binding this step** (docs/LAB-ROADMAP.md): *derived
form* — the harness is visualized as a living form computed from real
configuration and telemetry, no skeuomorphism, no borrowed bodies; depth is
continuous zoom (living form → labeled anatomy → schematic → file). *Dial
honesty* — no control without measurement underneath. Step 9 owns the first
two depths ONLY; schematic and file belong to Step 16 (scope-guarded
below). **The governing sentence: if a pixel is beautiful, it is beautiful
because it is true.**

## 1. The form grammar

One organism per harness. Four anatomical systems, each computed — never
drawn for its own sake:

**The core** is the brain slot. Its *radius* is the dial's current quality
position normalized over the ladder; its *hue* is the policy type (the
three-value palette below); its *surface* is the serving strategy's shape —
a single strategy is a smooth orb, a compound/cascade is faceted with one
facet per stage (the felt leg showed two rungs serving two different
strategies — the form must show that difference without a label). A second,
smaller nucleus appears only when `brain.toolPolicy` exists — the tools
slot made visible. *Inclusions* inside the core are memory entries (count
and recency from the real store); `memory.enabled: false` renders a clear
core.

**The membrane** is the spec's protections. *Thickness* is laminations —
one per rule (`spec.rules`). The *fuel reservoir* is an arc along the
membrane: its depleted fraction is the EST spend fraction (labeled est in
the anatomy), and discrete *notches* along it are metered truth from the
`request_logs` join — the est-vs-metered two-number rule carried into
pixels, never one blended arc. `hardStop: true` closes the arc's far end
with a terminal cap; false leaves it open. *Pores* are check-ins: an
`on-budget-fraction` pore sits AT its fraction along the fuel arc; a
`before-external-action` pore sits at the filament root junction. The
*silhouette* is the mission kind: a task is bilateral with a head end
(motion has a destination); a standing mission is radially symmetric with
cyclic breathing (no destination).

**The filaments** are superpowers — one per declared superpower, branch
tips per scope, root aperture sized by its per-tool spend cap.
**Not-connected is a structural encoding, not a dimming** — this is the
FOURTH place the pre-MCP posture surfaces (after the harness DTO, the run
DTO, and the report struggle): a not-connected filament is SEVERED — rooted
at the membrane, then a visible gap ring, then a short unluminous free end.
No pulse ever crosses the gap. When Step 10 connects a superpower, the
filament becomes continuous and pulses traverse it; the difference between
"declared" and "can act" is legible at far zoom with no text.

**The luminosity** is telemetry. *Base glow* is run state: pending faint;
running breathes at the run's own measured cadence (the mean inter-step
interval from step `createdAt` deltas — never an invented rhythm);
awaiting-human holds bright and still at the asking pore; completed is calm
and steady; failed gutters with a visible scar; killed-budget dims against
a fully depleted reservoir; killed-operator dims with a clean cut mark.
*Pulses* are events: exactly one per model step that arrives from the API,
amplitude from that step's cost — solid-centered when the cost is metered,
hollow-centered while it is still the labeled estimate (the ticker's rule
in pixels); pulse tint by slot (brain vs tools). *Anomalies* are never
smoothed away: a step whose trace carries `fallback=1` or
`latency_violated=1`, or a felt sample returned divergent, renders a
chromatic fringe on its pulse and deposits a persistent anomaly bead on the
membrane (enumerated at mid zoom). *Provenance* is global: any
mock-provenance serving renders the ENTIRE form in the house SIMULATED
treatment (desaturated field + badge at mid zoom); nothing mock ever glows
live.

Palette (three policy hues + two truth tints + anomaly fringe) and easing
curves are specified in the motion study itself — they are design-review
material, judged by looking, and every one of them is bound to a parameter
in the audit (§3): there is no "brand color" slot that answers to nothing.

## 2. Parameter inventory — every real signal available today

Sources are the Step 8 surfaces. "Cadence" is how the value reaches the
form. Reads marked **[additive]** do not exist yet and are named build-phase
work; everything else is served today.

### Configuration (GET /api/lab/harnesses/:hash — spec, sidecar, dial, posture)

| Signal | Field | Cadence |
|---|---|---|
| Harness identity | `harnessHash`, `name` | on load / after any edit (new content hash) |
| Mission kind + goal | `spec.mission.kind`, `.goal`, `.doneDefinition` | on load / edit |
| Worth (task) | `spec.mission.worthPerRunUsd` | on load / edit |
| Brain policy | `spec.brain.policy` (type, qualityFloor, p95Ms) | on load / edit |
| Tools policy (second nucleus) | `spec.brain.toolPolicy?` | on load / edit |
| Superpowers, declared | `spec.superpowers[]` (id, scopes, caps) | on load / edit |
| Superpower posture (4th place) | `superpowers[].status: 'not-connected'` (typed DTO field) | on load |
| Rules (laminations) | `spec.rules[]` | on load / edit |
| Fuel cap + hard stop | `spec.fuel.maxUsdPerRun`, `.hardStop` | on load / edit |
| Check-ins (pores) | `spec.checkIns[]` (trigger, fraction) | on load / edit |
| Memory enabled | `spec.memory.enabled` | on load / edit |
| Dial ladder + current position | `dial.brain.views[]` (quality, costPer1K, latencyP95, strategyType, strategyHash, feasible/gap) | on load / after dial move |
| Strategy shape (facets) | view `strategyType` + sidecar choice `basis` | on load / dial move |
| Generation provenance | `sidecar.choices[].basis` (frontierId, providerMode) | on load |
| Cluster | `clusterId` | on load |

### Memory (GET /api/lab/memory/:hash)

| Signal | Field | Cadence |
|---|---|---|
| Inclusion count / recency | `entries[]` (key, updatedAt) | on load; after PUT/DELETE (real edit path) |

### Telemetry (GET /api/lab/runs/:id — the same poll the run page already makes)

| Signal | Field | Cadence |
|---|---|---|
| Run state (base glow) | `state`, `stateReason` | poll (1.5s), unchanged load |
| The asking pore | `pendingQuestion` | poll |
| Pulse events | `steps[]` diff — each NEW step is one event; `at` is its measured time | poll diff |
| Pulse amplitude + truth tint | per-step `meteredCostUsd` \| `estCostUsd` + `costLabel` | poll (est→metered upgrade re-tints the SAME pulse's bead) |
| Pulse slot tint | per-step `slot` ('brain' \| 'tools') | poll diff |
| Breathing cadence | mean Δ of step `at` values (measured) | recomputed per poll |
| Anomaly events | per-step `frontierTrace` flags `fallback=1`, `latency_violated=1` (parsed server-side into typed DTO flags — **[additive]** DTO fields, trivial) | poll diff |
| SIMULATED treatment | per-step `provenance` / `simulated` | poll |
| Fuel depletion (est arc) | `cost.estPendingUsd` + Σ est over steps vs `spec.fuel.maxUsdPerRun` | poll |
| Metered notches | `cost.meteredUsd` + per-step metered | poll |
| Report struggles (scar detail) | GET `/runs/:id/report` `struggles[]` | on terminal |

### Named additive reads (build phase, inventory-classified)

- `GET /api/lab/harnesses/:hash/runs` → `listLabRunsForHarness` (db repo
  **[additive]**): the form needs "the harness's recent life" (which run
  animates when you open the harness page; run history density at mid
  zoom). Today only `getLabRun(runId)` exists.
- `GET /api/lab/harnesses/:hash/felt-samples` → `listFeltSamplesForHarness`
  (**[additive]** over 0036): felt divergences as anomaly beads on the
  harness (today felt samples are only returned inline by the sweep call).
- Typed anomaly flags on the run-step DTO (parse `frontierTrace` once
  server-side rather than in the client) — **[additive]**, no schema change.
- Per-step latency, if wanted for pulse *duration*, exists only via the
  request_logs join (same join the ticker uses) — **[additive]** DTO field;
  the form MAY ship without it (pulse duration then a fixed constant, which
  is honest because it is then explicitly NOT data — see audit rule on
  constants).

Nothing else exists. The form may not use a signal absent from this
inventory; a new signal enters by amending this table first.

## 3. The pixel-to-parameter audit — first-class artifact

The audit is a TABLE and a MACHINE CHECK, not prose.

**Shape.** The build introduces `@potion/lab-form` with one pure function:

```
deriveFormState(config: HarnessDto, memory: MemoryDto, run: RunDto | null,
                anomalies: AnomalyDto[]) → FormState
```

`FormState` is a CLOSED type — every field is a visual property. The audit
table lives beside it as a typed fixture (`audit.ts`), one row per
FormState field:

| column | meaning |
|---|---|
| `visual` | the FormState field (compile-checked: `keyof FormState`) |
| `parameter` | the named real parameter it renders |
| `source` | route + field path from §2's inventory |
| `cadence` | `on-load` \| `on-edit` \| `poll` \| `poll-diff` \| `on-terminal` |
| `interpolation` | `continuous-ease` \| `discrete-event` \| `static` |

Sample rows (the full table ships with the build; the motion study's
readout panel renders the same mapping live):

| visual | parameter | source | cadence | interpolation |
|---|---|---|---|---|
| `core.radius` | dial quality position (normalized over ladder) | harness `dial.brain.views` | on-edit | continuous-ease |
| `core.hue` | brain policy type | `spec.brain.policy.type` | on-edit | discrete-event (crossfade ≤400ms) |
| `core.facets` | serving strategy stages | dial view `strategyType` + sidecar basis | on-edit | discrete-event |
| `core.inclusions[]` | memory entries (key, updatedAt) | memory `entries[]` | on-edit | discrete-event |
| `membrane.laminations` | rules count | `spec.rules.length` | on-edit | discrete-event |
| `membrane.fuelArc.estFraction` | est spend / fuel cap | run `cost` + steps est | poll | continuous-ease |
| `membrane.fuelArc.meteredNotches[]` | per-step metered cost | steps `meteredCostUsd` | poll-diff | discrete-event |
| `membrane.pores[]` | check-ins (trigger, fraction) | `spec.checkIns` | on-edit | static |
| `filaments[].severed` | superpower posture | `superpowers[].status` | on-load | static (until Step 10) |
| `pulses[]` | model steps (at, cost, label, slot, anomaly) | steps diff | poll-diff | discrete-event |
| `glow.mode` | run state | run `state` | poll | discrete-event (≤400ms crossfade) |
| `glow.breathPeriodMs` | measured mean inter-step interval | steps `at` deltas | poll | continuous-ease |
| `simulated` | serving provenance | steps `provenance` | poll | static |

**The build-phase check — unmapped decoration FAILS** (three directions):

1. **Completeness**: a meta-test enumerates `keyof FormState` (via a
   compile-time exhaustive record) and asserts every field has exactly one
   audit row, and every audit row names a FormState field. A field without
   a row — decoration — fails the suite by name.
2. **Source reality**: every audit row's `source` is expressed as a typed
   accessor over the DTO types (`(h, m, r) => …`), so a source that stops
   existing is a compile error, not stale prose.
3. **The draw fence**: the renderer (draw layer) imports ONLY `FormState` —
   a structural fence test (the replay.ts import-fence pattern) asserts the
   draw module references neither DTO types, fetch, nor the db. A pixel
   that wants new data must route through `deriveFormState` and therefore
   through the audit.

**Constants rule**: fixed visual constants (stroke widths, easing
durations, the palette) are permitted ONLY in a single `theme.ts` whose
every export the audit lists with source `design-constant` — so "is this
pixel data or taste?" always has a checkable answer, and the taste surface
is enumerable for the operator's review.

## 4. Rendering substrate — decision, budget, degrade path

**Decision: Canvas 2D for the form; DOM overlay for mid-zoom labels and
edit panels.** Justification:

- The form's worst case is small: one core (≤6 facets), ≤`MAX_RULES`
  membrane laminations, ≤`MAX_SUPERPOWERS` filaments with ≤`MAX_SCOPES`
  tips, a fuel arc with ≤ two dozen notches, and a pulse pool ≤64. That is
  ≤450 draw ops/frame — an order of magnitude under Canvas 2D's comfort
  zone; WebGL's capability (10⁵+ instanced sprites, shaders) buys nothing
  here and costs context-loss handling, shader toolchain, and a far worse
  accessibility story. If Step 16's schematic depth someday needs more, the
  substrate decision is re-opened THERE with its own budget.
- SVG loses on the continuous path: per-frame attribute mutation of ~100
  nodes churns style/layout and GC on low-end hardware; SVG's win
  (declarative, inspectable) is exactly what the DOM overlay keeps for the
  parts that deserve it — labels and tap-to-edit panels are FORMS and get
  real focus order and ARIA from the DOM for free.
- The motion study is built on the SAME substrate (Canvas 2D + DOM) so the
  taste review judges the real thing, not a stand-in.

**Performance budget (stated, testable):** 60fps target / ≤4ms scripting
per frame on a 2019 mid-range laptop; ≤300 canvas ops/frame at far zoom,
≤450 at mid; zero per-frame allocation on the steady path (pooled pulses);
heap growth ≤5MB/hour; NO new server load — the form consumes the run
page's existing 1.5s poll and the harness DTO it already fetched. Budget
enforcement in build: a unit test drives `draw()` with a maximum-entity
FormState against a counting stub context and asserts the op ceilings;
wall-clock fps is verified in the walkthrough and recorded (the study
carries its own fps meter for the review).

**Degrade path (stated, visible, never silent):** sustained <45fps for 2s →
30fps tick; still <20fps → static form: pulse particles off, state changes
render as ≤300ms crossfades, breathing stops (glow becomes a steady level
per state). `prefers-reduced-motion` starts in static form. Degrade state
renders a small "reduced motion" glyph at mid zoom and is logged to
console once — a recorded state, not a silent one. The static form obeys
the same audit (it is the same FormState, drawn without time).

## 5. Zoom mechanics — far and mid ONLY

One continuous zoom scalar `z ∈ [0,1]` (wheel/pinch/buttons).

- **Far (z < 0.35)** — the pure form. No text, no chrome. Everything §1
  describes must be legible here: quality, protections, severed filaments,
  liveness, anomalies, SIMULATED.
- **Crossfade band (0.35–0.55)** — labels emerge anchored to their
  anatomy (they belong to parts, not to a sidebar).
- **Mid (z ≥ 0.55)** — labeled anatomy: every audit-mapped property shows
  its name and current value near its pixels (the audit made visible —
  this doubles as the operator's review instrument); anatomy parts are tap
  targets opening plain-language edit panels (§6). The not-connected gap
  ring gains its label: "declared — connects in a later step".
- **Scope guard**: z is hard-clamped at mid. The zoom control renders a
  labeled terminal stop — "schematic & the file arrive with the bench
  (Step 16)" — and no close-zoom code path exists behind it. The
  build-phase zoom test asserts the clamp and the absence of any deeper
  render mode.

## 6. Tap-to-edit through the REAL edit paths

Panels are DOM, plain-language, and save through routes that exist or are
named here as build work:

| Panel (anatomy) | Edit path | Status |
|---|---|---|
| Memory inclusions | `PUT/DELETE /api/lab/memory/:hash/:key` | exists (Step 8) |
| Dial (core radius) | `POST /api/lab/harnesses/:hash/dial` | exists (Step 7/8) |
| Check-in answer (asking pore) | `POST /api/lab/runs/:id/answer` | exists |
| Stop (whole form, running) | `POST /api/lab/runs/:id/kill` | exists |
| Rules / fuel-worth / check-ins / superpowers-declared | `POST /api/lab/harnesses/:hash/edit` | **[additive route]** |

The `/edit` route follows the dial-motion precedent exactly: a typed
plain-language patch (add/remove rule, set worth → `fuelFromWorth`
re-derivation, set check-in fraction, declare/undeclare a superpower)
produces a NEW content-addressed catalog row with carried sidecar
provenance; run-frozen specs untouched (the Step 8 catalog-invariance pin
already guards this); inventory-classified, org-scoped, member-guarded;
spec-closure gate on the emitted spec (parse-or-refuse, the motion.ts
pattern). **Live re-render**: every panel save refetches the harness DTO
and eases the form to the new derived state — the form updating live as
configuration changes IS the Step 9 done-clause, demonstrated through the
same routes a user's edits take, never through a client-side shortcut.

## 7. The interpolation honesty rule

Motion may EASE between measured states; it may never FABRICATE events.

- **Continuous-ease class** (audit column): scalar properties (core radius,
  est fuel fraction, breath period, glow level) tween ≤400ms between the
  last measured value and the new one.
- **Discrete-event class**: pulses, pores opening, anomaly beads, state
  crossfades — each drawn occurrence corresponds 1:1 to a row/field that
  arrived from the API (the steps-array diff). A poll that returns nothing
  new emits NOTHING: the form breathes (a rendering of the persisted
  `running` state) but no pulses fire. No idle heartbeats, no synthetic
  activity while waiting, no progress theater during long model calls —
  stillness is information.
- **Enforcement**: the pulse/anomaly queues are fed exclusively by the
  DTO-diff module; the audit meta-test asserts every discrete-event field's
  source is a `poll-diff` accessor, and a unit test feeds two identical
  polls and asserts zero emitted events. The est→metered upgrade re-tints
  an EXISTING pulse's residue bead (solid center), never re-fires it.

## 8. The motion study (this phase's reviewable artifact)

`docs/design/step-09-motion-study.html` — self-contained, opens from the
repo with no server, Canvas 2D + DOM overlay (the product substrate), fps
meter on. **Every animated value comes from
`docs/design/step-09-captured-data.json`** (mirrored as `.js` for `file://`
loading): verbatim `/api/lab/*` responses captured this session from a
mock deployment over a live-evidenced two-rung frontier — a real standing
harness (two declared superpowers, both not-connected), its real trial run
(15 steps, the half-fuel check-in held, the answer, the fuel kill), a real
dial move through the route (new content hash, quality 0.857→0.921, the
strategy flip), the run report, and one verbatim LIVE felt divergence from
the Step 8 ledger (strategy-mismatch, $0.0085, 9583ms). Scenarios:

1. **Trial run (measured)** — the captured run replayed on its own step
   timestamps: breathing from measured cadence, one pulse per real step
   (hollow = est), the pore holding at awaiting-human, the resume, the
   reservoir depleting to the hard stop.
2. **Dial move (measured)** — harnessBefore → harnessAfter easing: core
   radius/facets/readout from the two real DTOs.
3. **Anomaly (measured)** — the ledger's divergent felt sample as a
   chromatic-fringed pulse + persistent bead.
4. **Zoom** — far ↔ mid crossfade with anchored labels, the audit readout
   panel live at mid, and the labeled Step 16 stop.

The study deliberately does NOT show: close zoom, the file, connected
filaments (no superpower is connectable yet — showing one would fabricate
a state the product cannot reach), or any invented run.

## 9. Package layout / touches (build phase)

- NEW `packages/lab-form`: `deriveFormState` (pure; no fetch/db),
  `FormState`, `audit.ts` (the typed table), `theme.ts` (enumerated
  design constants), DTO-diff module, degrade controller. Tests co-located.
- `apps/dashboard`: the form canvas component + overlay panels on
  `/lab/harness/[hash]` (the form replaces the tables as the page's face;
  the tables remain at mid zoom as panel content — no template UI left as
  the primary surface); run-page integration reuses the existing poll.
- `apps/server`: `/api/lab/harnesses/:hash/edit` (additive, classified) +
  the two named additive reads + typed anomaly flags on the run DTO.
- No serving/core/db-schema changes. Org-delete and tenancy inherit from
  the existing tables; new routes enter the inventory with body-field
  probes where applicable.

## 10. Test plan ($0, all mock)

- Audit completeness both directions + source-accessor compile checks +
  draw-layer import fence (the three checks of §3).
- `deriveFormState` golden states from the CAPTURED fixtures (the same
  JSON the study uses — the study and the tests share one truth).
- Interpolation honesty: identical consecutive polls emit zero events;
  est→metered re-tints without re-firing; no pulse without a diffed step.
- Draw-op budget test against maximum-entity FormState (op-counting stub).
- Zoom clamp + absence-of-close-zoom test; degrade-path state machine test
  (45/20fps thresholds, reduced-motion start, visible glyph).
- Walkthrough leg: interview → form renders → dial move via panel →
  live re-render asserted from the DTO delta → rules edit via `/edit` →
  new hash + re-render → run trial → pulses equal the run's model-step
  count exactly → SIMULATED treatment asserted (mock deployment) →
  not-connected gap rings equal declared superpowers.
- Route tests for `/edit` (closure gate, new-hash semantics, tenancy row).

## 11. Risks and pushback

- **Taste is the exit, and taste may fail.** The study exists to fail
  fast: if the grammar reads wrong, the spec's §1 is revised and the study
  regenerated BEFORE build — cheaper than after.
- **The mock run's cadence is fast** (~100ms steps), so measured breathing
  in the study is quick; live runs (10–40s steps, per the felt leg) will
  breathe slowly. The study labels its timebase and offers the real 1×
  replay plus a slowed inspection rate — both driven by the same measured
  timestamps, clearly marked (a display-rate control is not event
  fabrication).
- **Sparse telemetry between polls** could tempt "liveliness" hacks; the
  honesty rule forbids them, and the stillness-is-information stance is a
  design position the operator should explicitly bless at review.
- **The `/edit` route creates catalog rows per edit** — same churn ledger
  as dial moves (retention owns cleanup; recorded Step 8 residual).
- **Canvas accessibility**: the form is not screen-readable; the DOM
  overlay at mid zoom is the accessible surface and carries the full
  audit readout — recorded as the accessibility posture for this step.

## 12. Not in scope

Close zoom / schematic / the file and two-way spec sync (Step 16, hard
scope guard in §5); connected-filament rendering beyond the severed state
(Step 10 supplies the first real connected superpower); run-history
visualizations beyond the additive reads named here (Step 14/16); any
serving or schema change; model-phrased anything.

## 13. Definition of done (build phase, restated from the plan)

The pixel-to-parameter audit complete and machine-enforced (unmapped
decoration fails the suite); no template UI remains as the harness page's
primary surface; live re-render on config change proven through the real
edit paths walkthrough-style; far/mid zoom with the Step 16 stop; the
interpolation honesty tests green; verify unfiltered; **and the operator's
taste review passes — sign-off is part of this exit, not a courtesy.**
