# Potion Lab — direction (v3, 2026-08-27)

**Status: product identity, revised after external review (operator-shared
2026-08-26) and UNPAUSED by operator order the same day** ("start working
on potion lab again" — this supersedes the v1 note that Gate A held the
ladder closed). Companion to `docs/LAB-BUILD-PLAN.md` (the step ladder) and
`docs/RESEARCH-DIRECTION.md` (the standing laboratory; one instrument,
three legs). v1 (2026-08-24) is preserved in git history; every v1
commitment that survives is restated here so this file stays the whole
truth.

## v3 (2026-08-27): the operator's evidence-density doctrine

A second operator review sharpened v2. The corrections are law:

**1. The key property of a good Potion worker is not that the work is
simple. It is that the work creates repeated opportunities to accumulate
trustworthy evidence.** The four properties of the strongest workers:
high-frequency execution · repeatable action classes · observable outcomes
· mostly reversible consequences. Complexity is not the disqualifier —
sparse evidence is. A moderately sophisticated reconciliation worker doing
500 workflows/week beats a trivial task done twice a month.

**2. The measured clusters are a launch constraint, not the product
boundary.** Today: workers are born only inside the live measurement
surface (the honest-stop refusal). The long-term loop is: create a worker →
identify required action classes → determine what is already measurable →
BUILD OR ADAPT THE MISSING INSTRUMENTS → supervise → accumulate → graduate.
Potion must eventually expand its measurement surface around the worker,
not only create workers inside it. (Queued: the honest stop should become a
measurement request, not a dead end.)

**3. Thresholds are priors; the statistics are the requirement.** minN
25/80/250 and the floors are defaults. The binding gate is (and already
was) the Jeffreys lower confidence bound against the tier floor — encode
the statistical requirement, never let a count become the requirement and
the rationale get lost. The fuller rule permission approximates:
`permission = evidence quality × evidence coverage × consequence ×
reversibility × uncertainty`. Observation count is only one input.

**4. Diversity is an evidence dimension (BUILT, this rev).** 25 nearly
identical successful actions may prove very little; 25 spanning edge cases
and distinct input distributions prove much more. The evaluator now runs
the EARNING side on effective evidence: successes cap per distinct
situation (REPEAT_EVIDENCE_CAP, a documented prior), failures are never
capped, and the autonomous drift check stays on raw evidence — the cap
governs what can buy trust, never what can revoke it. The ledger shows
breadth ("n observed · k distinct situations"), and hold reasons name
narrowness.

**5. Speed of graduation is an emergent property, never a promise.** The
product may say "you have enough volume that this action may graduate
quickly" — never "volume guarantees graduation." A week of the same easy
case is not coverage of the real distribution.

**6. The read/write heuristic is ICP guidance, not the product statement.**
The general rule: frequent + measurable + low-consequence actions graduate
fastest; sparse or high-consequence actions remain supervised longer,
potentially forever. Reading a CRM record graduates almost immediately;
drafting an email quickly; updating a field slower; sending externally
needs materially stronger evidence; issuing a refund may stay supervised;
wiring money never graduates. That gradient IS the trust model working.

**7. Archetype ranking (commercial).** The PAPERWORK WORKER is the
cleanest first commercial archetype: maps to the hardest-won instruments
(extraction-hard-v2 messy tier), objectively validatable outputs, high
volume, reversible acts, measurable ROI. The inbox worker is excellent
dogfood but "AI inbox assistant" is crowded — the valuable version owns a
specific OPERATIONAL inbox with measurable cost of error. The watcher is
structurally perfect but commercially weak while generic — it must ship as
domain-specific workers (compliance / portfolio / procurement / revenue-ops
/ incident watchers) where missing something has a price.

**8. OpenClaw integration must carry the full causal chain.** Trust-gating
an external runtime is only as strong as the reconstruction: which worker
(and which VERSION) acted, which action class, what arguments, what side
effect, whether approval was required and interception worked, the
downstream result, whether the outcome was later reversed or corrected, and
whether the action falls inside the distribution autonomy was earned on.
Shipped: session↔harness binding, fingerprinted check-ins, argsHash,
outcome steps, audit-sample marking. QUEUED: a reversal/correction
reporting path (the 'reversed' outcome has no external inlet yet) and a
distribution-membership check at pore time (an autonomous allow for a
situation unlike anything in the earned record should escalate, not run).

**9. Graduation is not the end of the loop — supervision must improve the
worker.** The full loop to build toward: work → observe interventions and
failures → identify recurring failure modes → diagnose harness/spec/tooling
→ propose a harness change → REPLAY historical cases old-vs-new → prove
improvement → deploy a new worker version → re-evaluate the permissions the
change touches → continue. A rejection is a defect report. An edit is
training/eval data. A repeated intervention pattern is a change proposal.
A new worker version must prove itself against historical work before
inheriting trust (edits already orphan provenance and change the hash —
the trust record must not silently transfer).

**The product, summarized (operator's words, adopted):** Potion Lab
creates persistent workers for work that produces enough evidence to
measure them. They begin supervised; they earn individual permissions as
evidence accumulates; high-risk permissions may remain supervised forever;
production performance is continuously audited; drift revokes autonomy;
human intervention becomes structured evidence; repeated intervention
triggers worker improvement; new versions prove themselves against
historical work before inheriting trust. The launch wedge is high-volume
repetitive operations because that is where the machine compounds fastest
— but the ceiling is a system that can create a worker, teach it through
real work, determine exactly what it can be trusted to do, improve it from
its mistakes, and progressively reduce supervision without ever confusing
volume with trust.


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

## v4 (2026-08-28): the harness doctrine (operator-adopted verbatim in spirit)

The operator supplied the full definition of an AI harness — the layer that
"determines how intelligence is assembled and applied to a task," spanning
context, prompts, models, tools, memory, state, execution, verification,
retries, permissions, observability, evaluation, and adaptation, "so that an
application can specify the outcome it needs while the harness determines and
governs the inference process most likely to produce it." Adopted. What it
changes:

**1. Identity unification.** Potion is the harness company, at two levels of
one spine. The serving path IS a model harness already (outcome-bound
policies, routing, fallbacks, retries, receipts, metering — reliability +
observability + evaluation around single calls). The Lab is the agent
harness. They share the laws (measurement, custody, receipts, replay) and the
thesis of `docs/INFERENCE-COMPILER.md`: the frontier ranks *recipes*, not
models; the customer declares outcomes, the harness compiles the means.

**2. The differentiator, stated once.** Every framework gives you a loop and
calls it a harness. Potion's angle is that harness DECISIONS — which model,
which strategy shape, how much verification, when to escalate — are chosen
FROM MEASURED EVIDENCE, per kind of work, with receipts, and re-proposed as
the evidence moves. "A compiler or optimizer for inference" is only credible
if the optimizer has measurements; we are the ones with the instrument.

**3. The honest scorecard (2026-08-28), by the doctrine's own checklist:**
- STRONG (and hard to fake): model management (the router), permissions &
  governance (evidence-earned autonomy, custody, before-external-action),
  observability (durable checkpoints, receipts, traces), reliability
  primitives (fences, replay, fuel hard stop, stall law), prompt/spec
  management (hash-addressed, tamper-evident, machinery-editable).
- WEAK (the visible gaps that read as "toy"): execution shapes (one loop),
  triggers (manual only), output contracts (prose), context management
  (no retrieval policy), harness-level evaluation (no judge), state (flat
  memory), tools-in (closed catalog, no BYO-MCP), delivery-out (report page).
The W-spine + axes plan (hands, clock, mouth → judge → beat memory →
plan/verify/escalate → feedback → fan-out; shapes × triggers × tools ×
contracts × delivery) is exactly the WEAK column, ordered. Nothing in the
STRONG column may be weakened to speed the WEAK column up.

**4. The two-audience law restated in harness terms.** The idiot declares an
outcome on the recipe card and gets a governed inference process they can
read. The genius opens the machinery and finds a real runtime: laws,
provenance, contracts, BYO tools, and every decision traceable to evidence.
Same object, two depths — never two products.
