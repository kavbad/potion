# Potion Lab — Roadmap Addendum

Status: paper-only, pre-Gate-A. As of Aug 11, 2026: the guarantee product is
code-complete through the swarm-pass fixes but NOT deployed — no managed
Postgres provisioned (Neon selected, not yet integrated), no host, no DNS, no
design partners signed. Nothing in this document is in flight.

Potion Lab is the harness-builder product line: anyone from novice to harness
engineer designs, tests, and deploys harnesses on Potion's serving and
measurement core. This document adds the Lab to the roadmap without altering
the existing guarantee product or its sequencing. It sits alongside the
G-phases; Lab phases are numbered L0–L6.

## Agent operating instructions — read first

For a Claude Code session receiving this document, the permitted actions
today, in order:

1. File this document at `docs/LAB-ROADMAP.md` and add a one-line pointer to
   it from the repo's roadmap/status index so it is discoverable in future
   sessions.
2. Run the "Assumptions to verify before L0" checks, read-only. Locate
   evidence (file paths, schemas, flags), write findings to
   `docs/LAB-ROADMAP-VERIFICATION.md` with one pass/fail/evidence line per
   assumption, and change no code.
3. Stop. Do not scaffold Lab packages, create Lab routes, or write Lab code
   of any kind — Gate B has not opened. Gate A (deployment) proceeds only
   when the operator provides credentials, under the existing deployment
   plan; it is unaffected by this document.

Product-vision language in the phases — the living form, zoom depths, run
narration — is design context for Gate B and after, not a build instruction
now. If anything in this document conflicts with the additive contract, the
contract wins. If an assumption fails verification, record it: the gap
becomes product-agnostic core work under rule 2, never an improvised
workaround.

## The additive contract

Three rules govern every Lab item:

1. The guarantee product is untouched. No semantic changes to serving,
   budgets, per-call metering, breakers, frontiers, certifications, or
   tenancy. The Lab consumes core through existing interfaces only.
2. Core extensions land as product-agnostic core first, under the repo's
   standing invariants: every new route classified in the route inventory
   (serving / non-serving, with reason); org-scoped by construction;
   mock/live separation preserved; all spend through the metered
   chokepoints; content-hash discipline for anything certified. The Lab must
   not reintroduce closed defect classes.
3. One product at a time. Lab code begins at Gate B, not before.

## Sanctioned core touchpoints

The Lab meets the existing codebase in exactly four places. Anything beyond
these is a contract violation to flag, not improvise around:

1. Serving, consumed as a client. Every model call the runtime makes goes
   through the existing serving surface and its chokepoints — no new
   provider-call paths anywhere in Lab code. Budgets, per-call metering,
   breaker, and hard stops are inherited, never reimplemented.
2. Frontiers and compound policy, read-only, for autopilot and the dial.
3. Suite, evidence, and certification APIs, for the proving ground.
4. One additive attribution dimension (harness id) on usage/invoicing, in
   L4, landed as product-agnostic core under rule 2.

## Assumptions to verify before L0

This document was written outside the repo. Verify each before L0 starts
(read-only — record findings in `docs/LAB-ROADMAP-VERIFICATION.md` per the
agent instructions above); where one fails, the gap lands as
product-agnostic core work first, under rule 2:

- Platform-level (non-org) frontiers exist with enough generic task-cluster
  coverage for autopilot cold start — a new user's first harness has no org
  history to personalize from.
- The serving surface supports the runtime as a client: streaming, tool-call
  passthrough, and per-call attribution adequate for per-step run records.
- Step-level synthesis can accept Lab run records as a source (converter
  work expected; do not assume the transcript converter generalizes).
- Usage/invoice aggregation can carry one additional attribution dimension
  without semantic change to existing invoices.
- POTION_SELF_SERVE remains the single flag governing self-serve posture; it
  stays off until Gate C.

## Gates

- **Gate A — standing, unchanged, first. NOT STARTED.** Provision managed
  Postgres (Neon — selected, not yet integrated), Docker host, DNS, secrets;
  container/TLS layer; BullMQ on real Redis; close the remaining
  rehearsal-coverage items; then run the design-partner motion. Nothing in
  this document modifies or reorders Gate A.
- **Gate B — Lab engineering starts.** Design partners signed and the
  guarantee motion validated, or explicitly falsified and the pivot decision
  made. Until Gate B the Lab exists on paper only: name, domain, deck slide,
  and the L0 spec RFC.
- **Gate C — public beta.** L0–L3 complete, the novice loop holds (intent to
  first live run, no documentation, under ten minutes), and the self-serve
  prerequisites are in place: payments and credits for fuel, abuse controls,
  and POTION_SELF_SERVE deliberately flipped on.

North-star acceptance test for the end state: a non-engineer assembles an
OpenClaw-class standing harness — hosted, permissioned, metered — without
touching a terminal.

## Phases

### L0 — Spec and runtime

New packages only; zero core changes.

- Versioned, content-hashed harness spec (the harness file): slots for brain
  policy, mission (task-shaped with a done-definition, or standing —
  always-on, governed by rules and check-ins rather than a done-verifier),
  superpowers, memory, rules, fuel, check-ins. The rendered form and the
  file are two zoom depths of one object from day one.
- Runtime: loop execution, tool calls, per-step checkpoints — built strictly
  as a client of serving (touchpoint 1), so budgets, metering, breaker, and
  hard stops are inherited by construction.
- Run records with per-step cost attribution, designed so checkpoints are
  replayable (feeds the L5 bench) and convertible into step-level eval
  items.

Exit: a harness runs headless from a file, fully metered, killable by hard
stop.

### L1 — Autopilot and the dial

Intent becomes a harness; the dial becomes honest.

- Intent → spec generation: the mission interview, slots filled per
  component.
- Cold start: autopilot fills slots from platform-level frontiers on generic
  task clusters; per-org and per-harness personalization accrues as runs
  generate traffic.
- Dial = the existing compound policy (quality floor + latency bound +
  minimized cost), read through touchpoint 2, surfaced per slot and per
  harness.
- Felt samples: eval runs at dial points, so moving the dial shows projected
  cost, latency, and a sample output on the user's own task — never a label.

Exit: a dial move produces measured, demonstrable differences.

### L2 — The Lab surface

The novice front door.

- Chat-to-harness: a complete harness appears autopilot-filled and
  immediately runs a trial mission with live plain-language narration and a
  cost ticker.
- The living form at far and mid zoom: the derived visual (core, membrane,
  filaments, luminosity — every property computed from real config and
  telemetry) with tap-to-edit plain-language panels; the form updates live
  as configuration changes.
- Run report v1: what happened, what it cost, where it struggled, exactly
  one suggested upgrade.

Exit: a novice reaches a real run with zero documentation.

### L3 — Superpowers

The capability catalog, ridden on MCP rather than built.

- MCP client in the runtime; hosted/remote connectors only at first — no
  user-supplied server processes.
- Catalog with OAuth, scopes, and per-tool spend caps extending Fuel. Token
  custody: superpower credentials live in the platform secret store, never
  in specs or run records.
- Packaged superpowers: connector + usage instructions + failure handling +
  mini-eval, shipped as one slottable unit.
- Injection posture: tool results are untrusted input; external actions
  require permission by default, relaxed only by explicit rule in the
  harness's Rules slot.

Exit: ~25 curated superpowers with safe defaults.

### L4 — Deployment surfaces

Harnesses leave the Lab.

- Harness identity; endpoint and cron triggers first, Slack and email after.
  Standing harnesses run heartbeat-shaped — bounded scheduled runs — before
  true always-on processes; same behavior to the user, honest infrastructure
  sequencing.
- Per-harness P&L: the one invoice-dimension extension (touchpoint 4),
  additive.

Exit: a harness runs on a schedule with its own budget and its own ledger.

### L5 — Pro instruments

The craft layer.

- The bench: replay any run, inspect the exact per-step context the model
  saw, fork from any step and re-run.
- The proving ground: promote any run to a golden pair; derived suites;
  replay-on-change with confidence intervals; champion/challenger built as a
  Lab-side pattern over the existing suite and verdict machinery
  (touchpoint 3) — no new core verdict semantics.
- Close zoom: full slot panels, spec editing with two-way sync,
  bring-your-own-editor.

Exit: a change to a harness can be proven better or worse before it lands.

### L6 — The command layer

The enterprise SKU, where the Lab and the guarantee product converge into
one sale.

- Org-wide harness catalog; policies and budgets inherited from org
  configuration; pre-approved superpower library; audit trails.
- Internal certification: the guarantee machinery pointed inward — which
  employee-built harnesses actually work, proven, with the promotion path
  from personal harness to department-blessed tool.

## Engineering discipline

Lab code inherits the repo's culture, not just its interfaces: every L-phase
lands with tests and walkthrough legs; every new route classified in the
route inventory with a reason; mock/live separation observed in all Lab eval
and sample paths; and a swarm-style adversarial pass on the Lab surface —
spec parsing, the MCP boundary, token custody, spend paths — before Gate C
opens it to the public.

## Out of scope, deliberately

Public marketplace (returns internal-first through the command layer, not
before). Arbitrary user code execution inside harnesses, including
user-supplied MCP server binaries. Model hosting.

## Standing decisions imported

- Referee rule: the platform grades harnesses and never sells its own
  against builders'.
- Dial honesty: no quality/cost/speed control is exposed without measurement
  underneath it.
- No empty canvas: every entry path yields a working harness.
- Derived form: the harness is visualized as a living form computed from
  real configuration and telemetry — no skeuomorphism, no borrowed bodies;
  depth is continuous zoom (living form → labeled anatomy → schematic →
  file).
- Own the word: the artifact is a harness. No pet name.
