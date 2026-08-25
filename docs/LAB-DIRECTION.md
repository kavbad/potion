# Potion Lab — direction (2026-08-24)

**Status: product identity, recorded by operator direction. Docs-only: this
changes what the Lab is *for*, not what has been built.** Companion to
`docs/LAB-BUILD-PLAN.md` (the step ladder, currently paused) and
`docs/RESEARCH-DIRECTION.md` (the standing laboratory; the two share one
instrument — see "The cross-leg relationship" in both).

## What Potion Lab is

Potion Lab is **not a harness builder**. Builders are the commoditizing
layer — sentence-to-agent is becoming free everywhere. Potion Lab is the
**full lifecycle of a harness as an employee**:

> build → supervise → graduate → run alone → improve untouched.

Every competing product ends at "build." Ours is the only one that can
carry a harness past it, because **the graduation decision is a measurement
decision**, and this codebase contains a calibrated, reference-anchored,
refusal-capable measurement instrument (see
`docs/research/g8-judge-calibration-2026-08-24.md` for the calibration
records). That instrument is the reason this product can exist and
competitors' cannot.

## The core mechanic: graduated autonomy, purchased with evidence

1. **Born fully supervised.** Every harness starts with every external
   action gated through the check-in pore (the check-ins slot and
   pause-for-human run state of Steps 2 and 8). Step 12's semantics are the
   foundation of the product, not a security detail: **what was approved is
   what runs.**
2. **Every answer is evidence.** Every pore answer (approve/reject), every
   human edit, every retry, every completed run accumulates into a
   per-harness, per-action-class **track record** — durable,
   provenance-carrying, built on the same suite/certification machinery as
   the guarantee product, revocable on drift.
3. **Autonomy loosens per action class only when the record clears an
   evidenced threshold**, and re-tightens automatically when the instrument
   detects drift. The instrument is allowed to conclude that a given action
   class **never graduates. That refusal is a feature.**
4. **Trust is rendered, never decorated.** The living form (Step 9) renders
   earned trust as a first-class visual dimension under the same
   pixel-to-parameter audit discipline as everything else it renders: a
   supervised harness and a graduated one must be structurally
   distinguishable at a glance, and the distinction must derive from real
   trust-record data.
5. **Pore answers are human quality labels.** Lab supervision traffic is a
   calibration corpus for the guarantee side's instrument. **Do not build
   this coupling yet.** It is recorded here as the standing architectural
   relationship between the two products; no Lab design choice may discard
   or fail to persist pore-answer ↔ step linkage.

## Lifecycle couplings (stated, not yet built)

- The **spec sets the leash at birth**: supervision posture derives from
  the harness spec, in the spec format's own slots.
- **Repeated pore rejections are defect reports on the harness spec.** A
  future builder surface can propose spec fixes from them.
- **Autopilot's frontier-backed model selection applies at build time and
  continuously after graduation**: a graduated harness gets cheaper over
  time, measurably no worse, with nobody touching it.

## Named future step (no number; placement is an operator decision)

**Graduation Ladder** — per-action-class autonomy thresholds derived from
pore records via the existing certification machinery
(`suite_certifications`, content-hash binding, CI-carrying verdicts);
drift-triggered re-tightening via the existing staleness/drift lanes; the
living form's trust rendering under the Step 9 audit rule. Composes
existing parts — the pore, run records, certifications, the Observatory
drift checks — and inherits every existing gate: spend caps and
KEY_RISK_ACCEPTED, tenancy classification of any new route, the route
inventory, hosted-only custody, and the promotion discipline (a threshold
claim is a certification, so it stales, re-verifies, and can be refused).

## Prerequisites already in place

The three un-backfillable pre-partner items the research program and the
Lab's trust records both depend on are **done** (2026-08-24): the
task-shape vector on every request and the implicit-outcome stamps
including the recorded null case (migrations 0055/0056), and the
structural-findings clause in the terms and privacy drafts (pending
counsel's skim with the rest of the legal package).

## What explicitly does NOT change

- **All Step 1–12 artifacts stand.** Nothing built is discarded; this doc
  reframes what it is all for.
- **The Lab build remains paused. Gate A — the first design partner for
  the guarantee product — remains the gate.** Recording this direction is
  not a resumption order; the ladder resumes when the operator says so.
- The target user span (novice to power user), Stellaris-depth modular
  editing, the derived form and its pixel-to-parameter audit, the
  superpowers catalog and its injection posture, hosted-only custody, and
  every existing gate and standing rule (spend authorization + ledger,
  tenancy sweep, fail-closed refusals, never-echo-secrets).

## The cross-leg relationship (one instrument, three legs)

Lab supervision traffic (pore answers as human labels) is a future
calibration input to the measurement instrument; the instrument
adjudicates both graduation (Lab) and findings (research); the research
program's findings feed the autopilot that serves the Lab. See
`docs/RESEARCH-DIRECTION.md` for the research half of this statement.
