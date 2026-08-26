# Potion Lab — direction (v2, 2026-08-26)

**Status: product identity, revised after external review (operator-shared
2026-08-26) and UNPAUSED by operator order the same day** ("start working
on potion lab again" — this supersedes the v1 note that Gate A held the
ladder closed). Companion to `docs/LAB-BUILD-PLAN.md` (the step ladder) and
`docs/RESEARCH-DIRECTION.md` (the standing laboratory; one instrument,
three legs). v1 (2026-08-24) is preserved in git history; every v1
commitment that survives is restated here so this file stays the whole
truth.

## What Potion Lab is

Potion Lab is **not a harness builder**. Builders are the commoditizing
layer. Potion Lab is the full lifecycle of an agent as an employee:

> build → supervise → graduate → run alone → improve untouched.

The core mechanic is **graduated autonomy, purchased with evidence**: an
agent does not become autonomous because someone flipped an auto-approve
switch; it earns autonomy per action class by demonstrating, under
supervision, that it performs those actions correctly — and it loses that
autonomy automatically when the evidence degrades.

**The differentiation claim, stated narrowly** (v1's "every competing
product ends at build" is retired — it stopped being true; LangSmith and
others span build→monitor):

> Others give humans controls for deciding how autonomous an agent should
> be. **Potion determines how autonomous it has earned the right to be.**

The lifecycle is not the moat. Human approval is not the moat. The moat is
the middle arrow: **supervision generates evidence → evidence automatically
moves the agent's permission boundary** — both directions, with the same
calibrated, refusal-capable instrument that runs the guarantee product.

## The five commitments

1. **Born fully supervised.** Every harness starts with every external
   action gated through the check-in pore. Step 12's semantics remain the
   foundation: what was approved is what runs (fingerprint-bound,
   burn-on-use, affirmative consent only).

2. **Permission is the output of evidence — there is no trust score.**
   Nothing in the product ever says "trust: 87." The rendered object is
   the **permission ledger**: per action class — *can act alone / asks
   first / blocked* — and behind every line, the evidence that put it
   there: observed actions, validated fraction with its interval, last
   evaluation, drift state, certification id. A scalar trust number is
   dangerously reductive and is a named non-goal.

3. **Graduation is risk-aware, not a success-rate threshold.** The
   graduation decision is a function of **capability evidence × action
   risk × uncertainty × reversibility** — risk tiers are a fundamental
   object, assigned per action class at spec time:
   - *reversible-read* (look-ups, searches): modest evidence suffices.
   - *reversible-act* (drafts, internal messages, undoable writes): more.
   - *irreversible-act* (external email, customer-visible writes): much
     more, plus standing sampled audit, plus human co-sign on grant.
   - *never-graduates* (payments, deletions, credentials): the instrument
     refuses permanently. **That refusal is a feature.** A success rate
     can never argue with this tier.
   Consequence outweighs volume: one unresolved high-stakes failure vetoes
   a thousand routine successes. 999 correct refunds and one wrong
   $100,000 refund is 99.9% and unacceptable; the engine must encode that
   sentence, not round past it.

4. **The loop is asymmetric: tightening is automatic, loosening is a
   proposal.** Drift, a rejection burst, or a reversal re-tightens the
   grant immediately, no human in the loop — fail closed. Loosening only
   ever produces a **graduation proposal** that a human accepts (the bar-
   proposal pattern from the serving product). Autonomy is a continuously
   revocable permission backed by current evidence, never a certificate.

5. **Approvals are evidence, not ground truth.** Humans rubber-stamp, miss
   mistakes, and attend less as trust grows — the label stream degrades
   exactly when it matters most. Therefore the track record is a
   **composite**: pore answers (a rejection-with-edit is the best label of
   all), deterministic validators, task outcomes, downstream reversals,
   later complaints, calibrated judges where calibration exists — and
   **mandatory sampled audit that never graduates away**: an autonomous
   action class retains a floor audit rate forever, because unaudited
   autonomy is unmeasured autonomy, and unmeasured is exactly what this
   product refuses to serve.

## The runtime posture (new, 2026-08-26)

Potion Lab owns the **definition + evidence + governance + lifecycle**
layer: identity, role, instructions, tools, credentials and permissions,
budgets, pores, evals, graduation rules, and the trust record. The
execution substrate is pluggable, and **the first external runtime target
is OpenClaw**: Lab instantiates an isolated OpenClaw configured from a
harness spec, runs it under supervision through the pore, and graduates it
per action class like any other harness. Lab does not compete with agent
runtimes; **Lab creates them and turns them into trustworthy workers.**
The existing hosted lab-runtime remains the reference substrate and the
place where pore semantics are enforced when no external runtime is
involved. (Runtime adapters carry the same custody rules: hosted-only
token custody, redaction before the gate, no runtime ever sees a raw
credential.)

The long arc is a **population**: a manager-level agent that notices a
recurring responsibility and proposes spawning a specialist — each new
worker born supervised with minimal permissions, earning autonomy
independently. The old L6 "command layer" becomes workforce management +
IAM + CI/CD for agents, with the measurement engine as the promotion
committee: *these 212 operate alone, these 34 are supervised, these 7
regressed, these 12 are candidates for broader authority.*

## Lifecycle couplings (stated; some now building)

- The **spec sets the leash at birth**: supervision posture and risk tiers
  derive from the harness spec, in the spec format's own slots.
- **Repeated pore rejections are defect reports on the harness spec.** The
  eventual loop: observe failure → diagnose harness → propose change →
  replay historical cases → prove improvement → deploy new version. An
  agent workforce that improves itself under empirical supervision.
- **Autopilot's frontier-backed model selection applies at build time and
  continuously after graduation**: a graduated harness gets cheaper over
  time, measurably no worse, with nobody touching it.
- **Pore answers are calibration labels** for the guarantee instrument.
  The coupling is still not built; no Lab design choice may discard or
  fail to persist pore-answer ↔ step linkage.

## The central technical risk, named

The product lives or dies on whether "earned" deserves the word — the same
real-world-representativeness gap the eval review scored 4.5/10 for the
serving product is **the** technical problem of Lab, at higher stakes. The
mitigations are the ones already adopted there: composite signals over
single ones, boundary-honest intervals, locked holdouts, sampled audit as
a permanent floor, and refusal as a first-class verdict. Where evidence is
insufficient, the answer is "not yet," and the product must be commercially
survivable saying it.

## The build spine (resumed)

All Step 1–12 artifacts stand. The ladder resumes with the graduation
engine as the spine, composing existing parts (the pore, run records,
suite certifications with content-hash binding, drift lanes, the living
form's audit rule):

- **L-G1 — the trust record + graduation evaluator** (first increment,
  2026-08-26): `lab_action_grants` (per harness × action class: state,
  risk tier, audit-rate floor, provenance) and the pure risk-aware
  evaluator — asymmetric tighten/loosen, high-stakes veto, Jeffreys
  intervals on validated fractions, never-graduates tier, proposal-only
  loosening. The feedback's two hard cases (97/3 with high-stakes
  failures; 999/1 with a $100k reversal) are pinned tests.
- **L-G2 — evidence extraction**: pore answers + run steps → evidence
  records (the composite signal set), wired to the evaluator; grants
  surfaced in the Lab UI as the permission ledger.
- **L-G3 — the living form renders the ledger**: supervised vs autonomous
  structurally distinguishable at a glance, derived from real grant data
  under the pixel-to-parameter audit rule.
- **L-G4 — the OpenClaw adapter**: instantiate, supervise, and graduate an
  external runtime instance through the same pore and record.
- Graduation certifications ride `suite_certifications` (content-hash
  binding, staleness, refusal) so a threshold claim stales and re-verifies
  like every other certification in the product.

Every existing gate inherits: spend caps and KEY_RISK_ACCEPTED, tenancy
classification of any new route, the route inventory, hosted-only custody,
never-echo-secrets, and the promotion discipline.

## What explicitly does NOT change

The target user span (novice to power user), Stellaris-depth modular
editing, the derived form and its pixel-to-parameter audit, the
superpowers catalog and its injection posture (act/read classification
drives the pore), hosted-only custody, and every standing rule.
