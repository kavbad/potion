# Potion Workers — direction (v1, 2026-08-31)

**Status: adopted law.** This document is the surgeon's review of the
operator's "Potion Workers: Product + Architecture Direction" (75 sections,
operator-shared 2026-08-31) and the build plan that follows from it. It is
the successor doctrine to `docs/LAB-DIRECTION.md` (v3/v4) and supersedes
the remaining unbuilt portions of `docs/HARNESS-BUILD-PLAN.md`. The X-ladder
that plan ordered is fully shipped (X1–X8, BYO-MCP, P3, P5, gallery/H2);
what follows is the next ladder.

## The review verdict

The operator's document is **adopted as law, with four amendments**. Its
central thesis is correct and is now the product's spine:

> Evidence determines authority. Production generates evidence. Evidence
> creates candidate improvements. Candidates mutate the whole harness.
> New generations must prove superiority. Authority transfers only where
> the proof remains valid.

Its §8 factual audit was verified claim-by-claim against the code on
2026-08-31 and **every claim is true**:

| Claim | Verified at |
| --- | --- |
| Native loop has deliberately no already-authorized branch | `packages/lab-runtime/src/loop.ts:705` — "its absence is the point" |
| OpenClaw gate holds one mutable runId across sessions | `packages/lab-openclaw/src/gate.ts:39,67` |
| Audit/pore identity keyed on toolName+argsHash | `gate.ts` pore/resolve API |
| Custom short hash where sha256 exists | `gate.ts:106-115` (16-hex charCode roll) |
| Exemplar copy contradiction | `lab-actions.tsx:738` says "not stored"; `spec.exemplar` is stored and the judge reads it |
| "Hard cap" enforced by a flat heuristic | `loop.ts:671` — `(totalTokens/1000) * $0.01`, not a provable price bound |

## The four amendments

**A1 — The evidence graph is a DERIVATION of the durable record, never a
parallel store.** The document asks for lineage on every conclusion (§32);
it does not name the asset that makes lineage cheap and honest: the
replay theorem. Every EvidenceObservation must point at `(runId, seq)` in
a verified record. "Why does G19 hold this permission?" is answered by
replaying records, not by trusting a mutable side-table. Competitors bolt
observability onto their runtimes; Potion derives it from a record that
proves itself. This is the moat under the moat, and every phase below is
constrained by it: **a gateway decision, evidence row, or promotion that
cannot be re-derived from records does not ship.**

**A2 — The already-authorized branch was removed FOR CAUSE; autonomy
returns by a different door.** Step 12's L2/L3/L4 findings were real
exploits: an approval bound to a trigger type was consumed by a different
act. The Action Gateway must restore native autonomy via **standing
grants consulted at act time** — validity re-checked on every action,
decision recorded as a typed step, replay-derivable — never by
resurrecting an in-loop "already approved" flag. One-shot answer
consumption (the pore) and standing-grant consultation (the gateway) are
different mechanisms and stay different.

**A3 — Prove the generational loop on machine-verifiable work first.**
The §69 invoice demo needs Gmail + NetSuite OAuth that does not exist yet
(operator-side sprint). Coding and data workers have ground truth TODAY:
tests pass or fail, files exist or don't, the sandbox runs or errors.
The flywheel (observe → diagnose → mutate → prove → promote → trust
migration) gets proven end-to-end on a coding/data worker family, then
ported to AP/ops work when the connectors land. Evidence-density doctrine
unchanged — this is its application.

**A4 — Every phase ends at the surface.** 2026-08-31's lesson, learned
twice in one day: capability tests green ≠ felt value. Each phase below
names its user-visible deliverable, and the phase is done only after the
surgeon drives it on prod as a naive user and is persuaded by what came
back. No phase is pure substrate.

Smaller sharpenings, also law:
- **IR primitives are pulled by shipping archetypes, never pushed by the
  vocabulary list** (§11's table is a menu, not a backlog).
- **Selective trust inheritance v1 runs at spec-section granularity**
  (mission/superpowers/rules/contract diffs → affected action classes);
  IR-node granularity arrives with the IR, not before.
- **The hard-cap fix is a caption-vs-provenance instance**: "hard cap" is
  a caption; the enforcement must provably bound, or the caption changes.
- **Evaluation spends real money**: replay/holdout/shadow get their own
  fuel budgets in the improvement policy, first-class like run fuel.
- **Evaluators ride their own dials** (the judge-slot lesson, 2026-08-31):
  every evaluator gets its own quality-floored policy, never the worker's.

## The fifth amendment — the flagship binding (added same day, on the
operator's challenge "do you fully think this is the right plan?")

**A5 — The ladder is pulled by a flagship, and the plan names its own
external dependency.** As first written, the W-ladder was horizontal —
layers of trust/evolution machinery whose fuel (production evidence)
does not yet exist, because usage does not yet exist. Two corrections:

1. **A flagship worker family is committed now and treated as a product:
   the Spreadsheet Analyst first** (zero external dependencies, proven
   10/10 end-to-end on prod 2026-08-31), **the Codebase Surgeon second**
   (tests-as-ground-truth; the strongest evolution testbed once GitHub
   connects). Every W-phase from W2 onward is scoped to what the
   flagship's real runs actually produce — evidence classes, eval cases,
   mutations — never built abstractly ahead of demand. W4 (IR) is
   explicitly conditional: it waits until a concrete worker is blocked
   by the loop's shape.
2. **The critical path is one path.** Evidence-driven evolution needs
   evidence; evidence needs users; users need the operator-side work
   (OAuth sprint, Stripe, demo clicks, distribution). The W-ladder
   interleaves with that work — it cannot succeed around it. W1 remains
   urgent independent of scale because it is an honesty defect TODAY:
   an OpenClaw worker's earned grant is honored while a native worker's
   identical grant is ignored.

## Adopted vocabulary

**Workers** is the user-facing noun (hire, job, responsibility, work
history, generations). "Harness" moves to Machinery/API/docs vocabulary.
The gallery positioning is "hire workers that own real jobs" — universal
architecture, focused surface (§48).

## The W-ladder

Phases are ordered by the same discipline as the X-ladder: each lands
whole, with tests, replay mirrors where the loop changes, and a driven
surface proof. W0 is small; the ladder is sequential except where noted.

### W0 — Truth & seams (the §8 closeout)

1. **Gate session isolation**: `PotionGateClient` keeps per-sessionKey
   state (map of sessionKey → runId), never one mutable runId.
2. **Cryptographic fingerprints**: `argsHashOf` becomes
   `sha256(canonicalJson(params))` from @potion/core; the custom charCode
   hash dies. Human authorization binds to a real hash.
3. **Audit identity**: `runId + actionId` (per-call unique), not
   toolName+argsHash — identical concurrent actions must not collide.
4. **Approval rendering law**: every external tool SHOULD implement
   `describeAction` (browser_act shipped 2026-08-31); a renderer must
   never truncate a parameter whose omission could change the meaning of
   the approval. Add renderers for git/web/mcp external tools.
5. **Exemplar truth**: one reality — the spec stores it, the judge reads
   it; the UI copy says so.
6. **Honest cap**: enforce the cap against a per-policy ceiling price
   that provably upper-bounds (max published price across the policy's
   reachable strategies), or the UI caption becomes "estimated cap" until
   it does. Metered truth continues to settle afterward.
7. **Workers naming pass**: dashboard copy Agents → Workers.

*Surface proof: an approval on prod that names its action in human words,
a cap the code can defend, the Workers noun everywhere.*

### W1 — One gate (the headline)

**Universal Action Gateway**: one decision system for every consequential
action from every runtime (native loop, OpenClaw, future adapters):

canonical action class → Action Constitution ceiling → standing-grant
consult (validity re-checked at act time) → situation/distribution check
(v1: explicit semantic features) → decision `BLOCK | HOLD | ALLOW |
ALLOW+AUDIT` → recorded as a typed step → execution → outcome collection.

- **Action Constitution v1** in the spec: per-action-class maximum
  authority (autonomous-earnable / ask-forever / never) + consequence tag,
  authored at hire, inferred where possible, operator-editable,
  hash-bearing (a constitution change is a new generation).
- **Event-driven tightening**: evidence arrival enqueues immediate grant
  re-evaluation; the gateway refuses grants whose evidence went stale.
  Bad evidence reduces authority NOW, not at next inspection.
- **Replay mirror**: gateway decisions are steps; replay re-derives them
  from the recorded grants/constitution state. Goldens regenerate.
- Native workers can then genuinely act alone where earned — the grant
  system's word becomes one truth across runtimes.

*Surface proof: a demo-org worker with an earned grant performs the same
action twice — once supervised (before), once alone with an audit-sampled
record (after) — and the permission ledger explains both.*

### W2 — Evidence honesty (approval ≠ correctness)

- **Evidence taxonomy** (§4's table) as typed observations: intent
  approval, correction, rejection, execution validity, deterministic
  validation, outcome success, reversal, incident, sampled audit,
  business outcome. Every row derives from `(runId, seq)` (A1).
- **Graduation re-weighted**: validation/outcome evidence outweighs
  approval volume; approvals alone cannot graduate a class whose outcomes
  are measurable.
- **Outcome ABI v1**: an endpoint for external systems to report success/
  failure bound to actionId.
- **Situation features v1** recorded per action (explicit semantic
  features: bands, known/unknown entity, source, params shape);
  out-of-distribution autonomous actions escalate at the gateway (§6).

*Surface proof: the permission ledger answers "why?" — evidence counts by
class, coverage, and the records behind them.*

### W3 — Generations & proof

- **Entities**: WorkerFamily, WorkerGeneration (content-addressed; the
  harness hash generalizes), lineage DAG, typed Mutations, EvalSet/Case/
  Run, GenerationComparison, Promotion, Rollback.
- **Eval sets grow from production**: corrections, incidents, goldens,
  holdout, synthetic edges. The F7 suite-certification law (content-hash
  binding, docs in `plan` history) lands here.
- **Shadow**: candidates run against recorded inputs with external
  actions stubbed — the record grammar already supports this.
- **Multidimensional comparison** (§28's table) — never one scalar.
- **Selective trust inheritance v1** at spec-section granularity.
- **The §60 card + Improve inbox v1**: "what I noticed / what I changed /
  why / proof / permission impact / action" — backed by correction
  clustering (learning-period machinery generalizes).

*Surface proof: Potion proposes a descendant with receipts and the
operator promotes it from the Improve inbox.*

### W4 — Harness IR (conditional — waits for a puller, per A5)

- The existing loop **compiles into** IR — it becomes one particular
  graph, not legacy. The durable step grammar is unchanged; the replay
  theorem survives; steps gain a typed purpose field (§65).
- Nodes added only as shipped archetypes pull them: validator/code/map
  for the data+coding family; wait/trigger formalize standing/watchdog;
  transactions/compensate wait for a worker that needs them.
- **Inference objectives per node** = the dialPolicy slot system
  generalized (brain/tools/judge slots already ship; nodes declare
  quality/latency/cost envelopes and the compiler emits the strategy).
- Machinery view renders the compiled graph (visualize, not author).

*Surface proof: the same worker, same behavior, now explainable node-by-
node in Machinery — and one new archetype (planner/executor or pipeline)
ships on IR alone.*

### W5 — The evolution engine (the milestone)

defect clustering → causal diagnosis → typed mutation → candidate
generation → automated replay + holdout proof → shadow → promotion
proposal → trust migration — proven end-to-end on the coding/data family
(A3), against the §72 gate, adopted verbatim:

> **Potion can observe a worker, identify why it performs poorly, create
> a modified descendant, prove the descendant is better, promote it, and
> correctly determine which permissions survive the change.**

Then W6 (organizations: persistent specialists, delegation evidence,
manager workers) — after the milestone, not before. **W6's chapter is
written:** `docs/RESEARCH-FLEET.md` (2026-09-01) — the Potion Research
fleet, adopted with six amendments as the W6 flagship. Direction now;
built at its ladder turn, unless the operator names it the distribution
interleave (its R1 allows either, and either way it is built ON Workers,
never beside them).

## Live views (adopted 2026-09-02, operator-directed)

Watching the work is part of the product's felt value. The rule: a live
view is always a RENDERING OF THE DURABLE RECORD (or of the workspace
that record governs) — never staged, never animated for show, so the
pane can never claim progress the record does not hold.

1. **The workbench — SHIPPED.** The run page's artifact pane: every
   workspace file is a tab; xlsx renders as a real grid (sheet tabs),
   csv as a grid, images inline, text as text; content-hash change
   detection over the polling DTO flashes tabs and refetches the open
   view (a size-equal rewrite still counts — the sandbox collection
   lesson); a now-strip carries the newest narrated step with an
   elapsed clock. Repo-scale runs (> 16 files) keep the tree card.
2. **Live sandbox stdout — QUEUED.** Stream Python/shell output into
   the now-strip while the call runs (today it lands as one block after
   completion; a long computation reads as a hang). Needs incremental
   output from the sandbox exec — record stays the completed step.
3. **The browser view — v1 SHIPPED (the operator's "internet stuff").**
   For browser-hand runs, what the worker's browser sees: after every
   successful open/act the service frames the page (JPEG, from the same
   Chromium the hand drives) into the workspace as browser/screen.jpg —
   ONE overwritten file, so the workbench's content-hash detection makes
   the tab live with zero new UI. Best-effort by law: a failed capture
   never touches the tool result, and no capture dep means no screenshot
   requests at all. Later: frame history / streamed screencast if the
   live screen earns it.
4. **A cursor in real external apps** (e.g. a live Google Sheet) is NOT
   this — that requires connector-side acts and stays out of scope
   until the connector exists.

## Explicitly not now (§72, adopted + extended)

No visual canvas. No integration breadth push (MCP covers it). No
template sprawl beyond the flagship few. No cosmetic trust scores. No
generic self-prompting. No swarm theatrics. No cross-tenant learning
until the priors abstraction provably cannot leak content. No new
importable-runtime adapters beyond OpenClaw until the gateway is one.

## Standing doctrine (merged from §73, binding)

Workers are the product; harnesses are how they operate. A generation
never changes — learning creates descendants; workers do not self-modify,
they reproduce; every descendant proves itself. Human intervention is
evidence; corrections are defect reports. Permission is earned, local
(generation × action × situation), and tightening is automatic while
loosening is conservative. Risk beats volume. Memory records what a
worker knows; generation defines how it works. Models are implementation
details behind declared requirements. Determinism beats intelligence
where possible. Every decision has lineage (A1). Generality belongs
underneath; simplicity on top. And from this repo's own history: numbers
never claim provenance they lack, and nothing is done until it has been
driven on prod and felt.
