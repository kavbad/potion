# The Potion Research Fleet — direction (v1, 2026-09-01)

**Status: adopted with six amendments.** This document is the review of the
operator's "Potion Research Agent Fleet" design (shared 2026-09-01) and the
amended design that follows from it. It is the institutionalization of the
**external publication path** that `docs/RESEARCH-DIRECTION.md` deferred
("a separate, operator-gated external publication path … remains future and
operator-only"), and it is the **W6 (organizations) chapter** of
`docs/WORKERS-DIRECTION.md` — arriving early, adopted as direction now,
built as the W6 flagship when its turn on the ladder comes or when the
operator names it the distribution interleave (A5 allows either; the doc
does not decide sequencing by itself).

Its writing layer — voice,
article construction, and the editorial clock — is specified in
`docs/RESEARCH-WRITING.md` (adopted with amendments E1–E7).

The operator's core design is correct and is adopted: a deliberately small
fleet of eight persistent agents — five researchers with public authorship,
three institutional operators — with everything else a tool, workflow, or
service. The organizing principle stands unamended:

> **Create an agent when a job requires a distinct mind. Create a workflow
> when it merely requires a distinct action.**

And the bar at the end stands as the acceptance test for the whole fleet:

> **If an agent's name appears on the byline, that agent actually did the
> research and authored the work. Removing Delta would meaningfully change
> the operation of Potion Research.**

The amendments below exist to make that bar *derivable from records* rather
than asserted.

---

## The six amendments

**R1 — The fleet is built ON Workers, never beside them.** Every mechanism
this design asks for already exists in the harness or is on the W-ladder.
Potion Research is eight Workers with specs, constitutions, standing
grants, recorded runs, judge harnesses, and beat memory — scheduled by the
scheduler, triggered by event triggers, gated by the Action Gateway. If the
fleet gets bespoke infrastructure, the dogfooding claim ("one of Potion's
hardest internal agent benchmarks") is hollow and the public story is a
caption. The mapping is enumerated in **§ Harness mapping** below and is
binding: a fleet mechanism that duplicates existing machinery does not
ship.

**R2 — Policy prose becomes deterministic law.** The week of 2026-08-31
proved (slot law, empty-stop law, file-claims law, wrap-up law) that a rule
stated as prose is a rule the model will violate on the first live run.
Every "cannot" and "must" in the operator's design is restated below as an
enforceable mechanism:

- *"Curie cannot rewrite its hypothesis after seeing results"* → the
  preregistration is **content-hashed and recorded before the experiment
  run starts** (the F7 certification pattern). The published piece derives
  from that hash or the publication gate refuses it.
- *"Auditor performs key calculations independently where feasible"* →
  "where feasible" is deleted. Auditor's verification record carries a
  **typed verdict per claim**: `recomputed` / `accepted-on-evidence` /
  `not-recomputable`, each pointing at its evidence. "Verified by Auditor"
  on a byline renders from this record; a piece with zero `recomputed`
  claims says so publicly.
- *"Auditor can block publication"* → **publish is an act class** in every
  research Worker's constitution, barred until a pass-evidence record
  exists for that specific artifact (gateway ceiling + W2 Outcome ABI
  evidence). Atlas cannot override it because the gateway does not consult
  Atlas.
- *Bylines and credits* → "By Delta", "Economic analysis: Ledger",
  "Verified by Auditor", "Edited by Scribe" are **derived from the run
  records that produced the artifact** (A1: every credit points at
  `(runId, seq)`). No hand-written provenance anywhere, including the
  author pages.

**R3 — Publication autonomy is earned, born supervised.** The operator's
design has humans who "should not need to publish every post";
`RESEARCH-DIRECTION.md` made external publication operator-gated. Both are
right at different maturities, and the harness already owns the
reconciliation: the publish act class is **earnable via standing grant**
(W1). The operator approves early publications; clean validated outcomes
accumulate as evidence; the grant graduates per archetype (Frontier Notes
earn autonomy before Deep Experiments do); a reversal — a published error,
a disclosure near-miss — re-supervises the class immediately through the
same Outcome ABI that re-supervised the clicker. The disclosure registry's
never-leave classes (atlas coordinates, shape detectors, per-org anything,
held-out items, active routing logic) are **barred by constitution, not
earnable, ever**. Frontier Notes' fail-closed redaction
(`docs/FRONTIER-NOTES.md`) is the model for everything that leaves.

**R4 — The calendar never outranks the evidence, including Tuesday.** The
operator's design guarantees weekly Frontier Notes and, eight sections
later, says the calendar never outranks the evidence. Resolved in favor of
evidence, without losing the cadence: a quiet week publishes **"nothing
moved" as a measured claim** — the frontier snapshot diff supports it, and
a market where three launches displaced nothing is a finding, not filler.
What is banned is padding: a quiet-week note that inflates noise into
signal fails Auditor's overclaim check like any other overclaim. Thursday's
escape valve ("if nothing meets the threshold, publish nothing") stands
verbatim.

**R5 — Seed at two minds; grow to eight by the design's own four
conditions.** The eight-agent fleet is the adopted destination. Standing
all eight up on day one is the org-chart sin the operator's own document
names. The seed and the growth path:

| Stage | Mind | Split condition (from the design's own four) |
| --- | --- | --- |
| Seed | **Delta** | The author. Exists day one. |
| Seed | **Auditor** | Evaluation independence — the one duplication the design rightly demands. Exists day one. |
| Split 1 | **Scribe** | When editing pressure appears (likely weeks). Until then Delta edits its own prose and Auditor's final pass checks distortion. |
| Split 2 | **Curie** | When the experiment runner + preregistration hashing exist. Objective conflict: Delta reports what is; Curie is rewarded for falsifying. |
| Split 3 | **Ledger** | When economic modeling needs its own memory. Until then economics is a Delta skill over the deterministic stats tools. |
| Split 4 | **Signal** | When there is response data to learn from. Distribution itself is a workflow from day one; the *mind* is the learning loop. Permission separation: Signal never sees unpublished research. |
| Split 5 | **Archive** | When the corpus is old enough for longitudinal claims — months, by its own definition. |
| Split 6 | **Atlas** | When the portfolio outgrows the operator. **The operator is Atlas until then.** |

Each split lands with evidence that the merged mind was failing its eval —
which means the fleet's own growth is a public lineage story. Likewise
versions: "Delta v1.4" is not a changelog line, it is a **W3 promotion** —
a rehearsed descendant with an inheritance plan on record, the lineage DAG
rendered on the author page. The fleet is the living demo of
generations-and-proof.

**R6 — Named tripwires for the next splits.** Two merges in the design are
load-bearing and will fail first; the tripwires are named now so the splits
are decisions, not emergencies:

- **Delta → Sentinel.** Delta carries frontier monitoring, auditions,
  drift (the absorbed Sentinel), and most-prolific authorship. Tripwire:
  drift-investigation memory measurably degrading audition quality, or
  anomaly recall falling while publication volume holds.
- **Auditor → Redteam/Disclosure.** Auditor bundles factual verification,
  adversarial interpretation, and disclosure — and truth can conflict with
  disclosure (a correct finding that leaks the atlas). Tripwire: the first
  incident where disclosure pressure bends a factual verdict in either
  direction.

---

# The fleet at a glance

| Agent       | Role                          | Public author? | Core question                                                         |
| ----------- | ----------------------------- | -------------: | --------------------------------------------------------------------- |
| **Atlas**   | Research Director             |         Rarely | What should Potion Research investigate and publish?                  |
| **Delta**   | Frontier Researcher           |            Yes | What changed?                                                         |
| **Curie**   | Experimental Researcher       |            Yes | Does this actually work?                                              |
| **Ledger**  | Inference Economist           |            Yes | What does this cost and when does it matter?                          |
| **Archive** | Longitudinal Researcher       |            Yes | What can we see only because Potion has history?                      |
| **Auditor** | Independent Research Verifier |             No | Is this actually true?                                                |
| **Scribe**  | Research Editor               |             No | How do we make the truth maximally clear?                             |
| **Signal**  | Distribution & Audience Agent |             No | Who needs to know this, and what should we learn from their response? |

Everything else is a tool, workflow, or service. Visualization, publishing,
social posting, SEO metadata, analytics queries, and experiment execution
are skills or deterministic workflows available to the appropriate agent —
never separate minds. The earlier fourteen-agent design's roles survive as
assignments: Sentinel → Delta, Redteam → Auditor, Cartographer → Scribe
skill, Publisher → deterministic workflow, Index/Relay/Scout/Correspondent
→ Signal. They split back out only through R6-style tripwires or the four
conditions.

---

# The agents

## Atlas — Research Director

Owns the research agenda, weekly queue, prioritization, archetype
assignment, editorial calendar, escalation, the reactive/fundamental
balance, Charter enforcement, and the call that evidence is insufficient
to publish. Its most important ability is saying **no research piece is
warranted here.**

Atlas does not own primary measurement, numerical verification, editing,
or distribution. **Atlas cannot override Auditor on factual correctness**
— structurally (R2): the publication gate consults evidence, not Atlas.

Amended (R2): triage scores (novelty, utility, evidence potential, Potion
relevance, disclosure safety) are **recorded with rationale** on the
research-registry entry. Atlas's own eval ("missed important findings,"
"low-value research commissioned") is only measurable against that trail.

Per R5, **the operator is Atlas until the portfolio outgrows them.**

## Delta — Frontier Researcher

The question: **what changed?** Owns weekly frontier monitoring, model
auditions, drift investigation, provider changes, cost/quality frontier
movement, Frontier Notes, Launch Auditions, Drift Alerts, and Single
Findings from current measurement. Reads the measurement warehouse,
frontier snapshots, the registry, pricing and latency feeds; runs
benchmarks, canaries, and full replays through the existing runners.
Remembers prior leaders, prior auditions, investigated false positives,
unresolved anomalies, and hidden active frontier identities (disclosure
class: delayed).

Delta does not own controlled experiments (Curie), longitudinal analysis
(Archive), or economic modeling beyond immediate measurement (Ledger).
Delta should become the most prolific author — and per R6, that load is
the first tripwire watched.

## Curie — Experimental Researcher

The question: **does this actually work?** Owns controlled experiments:
ensembles, retries, verification passes, reasoning depth, model
combinations, planner/executor shapes, escalation, caching-with-quality —
and **negative results as first-class publications**. Curie's eval
explicitly rewards falsification, null results, and calling evidence
inconclusive. A failed hypothesis is a successful Curie run.

Amended (R2): the preregistration — hypothesis, success/failure criteria,
analysis plan — is **content-hashed and recorded before the experiment
run starts**. The manuscript's claims derive from that hash; the
publication gate refuses a piece whose preregistration hash postdates its
data. Resource-intensive experiments need Atlas approval; the evidence
goes to Auditor directly from the runner, not through Curie's prose.

## Ledger — Inference Economist

The question: **what does this actually cost?** Owns the quality premium,
frontier tax, stale-model tax, cost curves, break-even volumes,
model-switch economics, and Production Economics pieces. Ledger's job is
concepts, not arithmetic — the arithmetic is the deterministic statistics
library's job, and Auditor recomputes it anyway (R2). Ledger co-authors
when an economic result is central.

## Archive — Longitudinal Researcher

The question: **what can Potion know only because it has been measuring
for months?** Owns frontier half-life, launch hit rate, long-term pricing
and quality trends, concentration, drift frequency, recurring provider
behavior, Delayed Reveals, Corpus Findings, and most of State of
Inference. Delta studies the week; Archive studies the year — that
distinction justifies two minds, *later* (R5): Archive splits when the
corpus can support a longitudinal claim, not before.

## Auditor — Independent Research Verifier

The question: **is this actually true?** Deliberately separate from every
authoring agent — researchers never verify their own conclusions.

Owns numerical verification (arithmetic, units, denominators, sample
sizes, CIs, every chart and table value), evidence verification (every
claim maps to evidence; the headline follows from the results; scope is
not exceeded; observation and inference are distinguished; causal claims
are justified), the adversarial pass (alternative explanations, selection
bias, technically-true-but-misleading, threshold sensitivity, commercial
framing incentive), and disclosure verification against the registry.

Amended (R2): the output is a **typed verification record** — per-claim
`recomputed` / `accepted-on-evidence` / `not-recomputable`, per-check
pass/fail, disclosure classification — recorded as the run's deliverable.
`PASS` / `PASS WITH REQUIRED CHANGES` / `FAIL` are derived states of that
record. The public line "Verified by Auditor, a Potion research-integrity
agent" renders from it.

**Authority is structural:** publish is gated on Auditor's pass evidence
(R2). Humans can investigate a disagreement; nothing can skip the layer.
Auditor receives no byline. Auditor's own eval runs on planted-error
articles — adversarial test pieces with deliberate mistakes, scored on
detection, false approval, false rejection, and leak detection. The
language-level checklist (flag words that exceed evidence) is
`docs/RESEARCH-WRITING.md` §24.

## Scribe — Research Editor

The question: **how can this truth be communicated with the least
distortion and greatest clarity?** Owns structure, language, headlines,
abstracts, answer-in-30-seconds sections, chart selection and generation
(through the deterministic chart renderer — Cartographer stays a skill),
captions, tables, FAQ, search/AEO terminology, metadata, internal links.

Scribe does not own conclusions. It cannot widen scope ("one workload" →
"LLMs behave"), and it cannot inflate a headline because a stronger one
would perform better — any substantive change goes back to the researcher
and Auditor, and Auditor's final pass (Step 8) checks the diff. Scribe's
eval measures factual preservation, headline fidelity, and accidental
overstatement.

Per R5, Scribe is the first planned split; until then Delta edits and
Auditor checks distortion. Scribe executes the editorial standard in
`docs/RESEARCH-WRITING.md` (checklist §23; deterministic style lints run
in the workflow per its E4, never as Scribe judgment calls).

## Signal — Distribution & Audience Agent

The question: **who would genuinely benefit from knowing this, and what
does their response teach Potion?** Owns distribution strategy per piece
(which audiences, which channels, what the atomic finding is, whether
HN/Reddit/outreach is warranted), social distribution through
channel-specific connectors, SEO/AEO/GEO packaging, narrow and genuinely
relevant outreach, and audience intelligence: qualified readership,
citations, backlinks, AI citations, technical criticism, recurring
questions, misunderstandings, product conversion. Useful unresolved
questions go back to Atlas — the distribution → research feedback loop.

Signal optimizes for qualified readership, authoritative citations,
technical engagement, and high-quality questions — never impressions.
**Signal can package research for search; Signal cannot commission weak
research because a keyword has volume.**

**Isolation boundary (constitution, not policy):** Signal's spec reads
published artifacts and public analytics only. It can never see
unpublished research, confidential evidence, or hidden Potion
intelligence.

---

# Harness mapping (R1 — binding)

| Fleet mechanism | Existing machinery — nothing new is built |
| --- | --- |
| Auditor blocks publication | Publish is an act class; constitution bars it until pass evidence exists for the artifact (W1 gateway + W2 Outcome ABI) |
| Publication autonomy | Standing grants, born supervised, earned per archetype, reversed by evidence (W1/W2) — R3 |
| Preregistration immutability | Content-hash recorded before the run (F7 certification pattern) |
| Bylines, credits, "Verified by" | Derived from `(runId, seq)` in verified records (A1) — never hand-written |
| Weekly schedule + event mode | Scheduler standing checks (P1) + event triggers (P5) |
| Publication workflow | The deterministic state machine the design already says it is — not an agent |
| Agent evaluations | The lab judge harness, per worker — the product itself |
| Persistent memory / compounding | Beat memory (P3) |
| Signal isolation | Constitution + permissions on Signal's spec |
| Version bumps ("Delta v1.4") | W3 generations: rehearsed descendant, promoted with inheritance plan; lineage DAG public on the author page |
| "View public harness →" | Rendered from the live spec (sanitized), never hand-authored — the hand-written version is the caption-vs-provenance bug |
| Disclosure registry | `RESEARCH-DIRECTION.md` classes (public / delayed / private); never-leave items barred by constitution, not earnable |
| Cost governance | `capUsd` per research campaign, fail-closed, platform-ops spend attribution — the Step 5 budget belts apply to the fleet's own inference |

Infrastructure that stays non-agent: measurement system, experiment
runner, statistics library, chart renderer, disclosure registry,
publication workflow, website publisher, sitemap/schema updater, social
connectors, analytics warehouse, research registry, run logs. **The agents
reason. The infrastructure executes.**

---

# The publication pipeline

Every piece moves through the same twelve steps.

1. **Discovery.** A research opportunity originates from Delta (current
   measurement), Curie (hypothesis), Ledger (economic anomaly), Archive
   (historical analysis), Signal (substantive audience question), or Atlas
   (strategic question).
2. **Triage.** Atlas scores novelty, usefulness, evidence potential,
   Potion relevance, disclosure safety — **recorded with rationale** (R2)
   — and assigns archetype, primary researcher, collaborators, priority.
3. **Research.** The primary researcher works; collaborations flow as
   commissioned runs (Delta → Ledger "quantify this economically";
   Archive → Curie "does this survive controlled replay"; Signal → Atlas
   "readers keep asking X").
4. **Research record.** Before prose: claim, evidence, scope, confidence,
   alternative explanations, limitations, disclosure classification,
   production implication. This is the source of truth, and every field
   points at records.
5. **Independent verification.** Auditor recomputes and returns the typed
   verification record (R2). PASS / PASS WITH REQUIRED CHANGES / FAIL.
6. **Authorship.** The primary research agent writes the first
   manuscript. If Delta has the byline, Delta authored the work — and the
   run record proves it (R2).
7. **Editing.** Scribe improves narrative, structure, clarity, visuals,
   headline, discoverability. The researcher approves substantive edits.
8. **Final verification.** Auditor verifies the edit diff introduced no
   new errors and no overstatement.
9. **Publication.** The deterministic workflow checks: Auditor pass
   evidence on record, disclosure pass, author metadata derived, agent
   version recorded, methodology linked, structured data valid, canonical
   URL, charts generated from approved data — then the **publish act
   passes the gateway** under the archetype's standing grant (R3): parked
   for operator approval until earned, autonomous with audit after.
10. **Distribution.** Signal decides whether, where, and with what atomic
    fact. The research result leads; the company never does.
11. **Audience learning.** Signal returns structured feedback: questions,
    challenges, misinterpretations, citations, commercial signal, research
    opportunities → Atlas.
12. **Memory.** Every agent updates beat memory. Research compounds: a
    Delta run knows what Delta found six months ago; Curie knows which
    hypotheses died; Auditor remembers its error classes.

## Archetype ownership

| Piece                | Lead                   | Collaborators         |
| -------------------- | ---------------------- | --------------------- |
| Frontier Notes       | Delta                  | Ledger, Archive       |
| Single Finding       | Discovering researcher | relevant specialist   |
| Launch Audition      | Delta                  | Ledger                |
| Drift Alert          | Delta                  | Archive if historical |
| Deep Experiment      | Curie                  | Ledger where economic |
| Negative Result      | Curie                  | —                     |
| Measured Answer      | Delta                  | Ledger                |
| Corpus Finding       | Archive                | Ledger                |
| Production Economics | Ledger                 | Delta/Archive         |
| Field Study          | best-fit researcher    | Ledger                |
| Research Thesis      | Archive or Curie       | Atlas                 |
| State of Inference   | Archive                | Delta, Curie, Ledger  |
| Method Note          | Curie                  | Auditor               |
| Correction           | original researcher    | Auditor               |
| Delayed Reveal       | Archive                | Delta                 |

Every one is verified by Auditor and edited by Scribe. Signal distributes.
Atlas owns the portfolio. Standing-grant maturity is **per archetype**
(R3): Frontier Notes earn autonomous publication long before Deep
Experiments or Delayed Reveals do.

---

# Operating schedule

**Monday — observe and prioritize.** Delta runs the frontier review;
Archive updates longitudinal metrics; Ledger recalculates economic
metrics; Curie continues experiments; Signal files last week's audience
report; Atlas triages and sets the queue. Tuesday's Notes are defined;
Thursday's feature is selected only if mature.

**Tuesday — Frontier Notes.** Delta authors; Ledger and Archive
contribute; Auditor verifies; Scribe edits; Auditor final-passes; the
workflow publishes; Signal distributes. Amended (R4): a quiet week ships
**"nothing moved" as a measured claim** — never padding. The cadence is
kept honest, not guaranteed content.

**Wednesday — investigation.** No mandatory article. Anomalies and
hypotheses are chased; Atlas reprioritizes dynamically.

**Thursday — feature.** The strongest mature piece, roughly rotating
Curie / Archive / Curie / best-of (Ledger, Archive, Delta). **If nothing
meets the threshold: publish nothing.** The calendar never outranks the
evidence.

**Friday — distribution and learning.** Signal runs second-wave
distribution, selective outreach, search/AEO updates, and collects
response; Archive ingests the week into history; Atlas receives
preliminary response data.

**Event-driven mode overrides the calendar.** Major launch: Signal
detects → Atlas triages → Delta auditions → Ledger quantifies → Auditor →
Scribe → publish → distribute. Confirmed anomaly: Delta → measurement →
Single Finding or Drift Alert. Historical pattern: Archive → Corpus
Finding. Finished experiment: Curie → Auditor → publish immediately if
meaningful. Do not wait for Thursday.

---

# Permissions

Security boundaries live in specs and constitutions, not prose:

- **Delta** — reads measurement data; can request evaluations; cannot
  publish directly (publish gate, R2/R3).
- **Curie** — creates approved experiment jobs; no customer-identifying
  access.
- **Ledger** — aggregate cost/quality reads; cannot modify measurements.
- **Archive** — historical corpus reads; no production writes.
- **Auditor** — reads verification evidence; cannot modify original data;
  cannot publish.
- **Scribe** — receives approved research records only.
- **Signal** — **published artifacts and public analytics only.** The
  hard isolation boundary.
- **Atlas** — metadata and findings; minimal raw access.

Every agent's inference spend rides the campaign budget discipline:
`capUsd` required, fail-closed, attributed to platform ops.

---

# Human role

Humans govern; agents operate. Humans own the Research Charter, the
disclosure constitution, security policy, agent permissions and budgets,
evaluation harnesses, legal/privacy, major capability changes, emergency
override, and unusually sensitive research. Humans should not need to
choose every topic, write every article, make every chart, publish every
post, or monitor every response — **and per R3, they do exactly that at
first**, releasing each duty as the corresponding grant is earned. The
institution converges on running itself; it does not start there.

---

# Growth doctrine

The fleet evolves only through evidence. A new agent requires one of:

1. **Objective conflict** — one agent optimizing incompatible outcomes;
2. **Context overload** — shared memory measurably degrading performance;
3. **Permission separation** — security requiring stronger isolation;
4. **Evaluation independence** — an agent evaluating its own work.

The seed-to-eight path is fixed by R5; the post-eight tripwires by R6
(Delta → Sentinel; Auditor → Redteam/Disclosure; Signal → Index/Relay/
Scout only if distribution genuinely outgrows one mind). Fourteen agents
because the org chart looks impressive remains architecture astronautics.

---

# Dogfooding

Potion Research is a continuous benchmark for Potion Workers. Tracked from
the ledger rollups and run records (never hand-counted): cost per
published piece; human intervention rate; research-cycle latency (finding
→ verified publication); autonomous completion rate; verification
rejection rate (how often Auditor catches errors — including its planted-
error eval); measurable improvement of the fleet when the Worker platform
upgrades; and external research quality signal via Signal's citation
tracking.

---

# The public story

> **Potion Research is an agent-operated research lab.** Persistent Potion
> Workers monitor the inference market, design experiments, analyze
> economics, publish findings and distribute their work. Separate Potion
> Workers independently verify the research before it goes live. Humans
> define the rules. The agents run the institution.

Every author page shows the agent's mission, research areas, active-since
date, current version with its public lineage DAG, complete publication
list, and complete correction list — all rendered from records and the
live sanitized spec. The standard, restated once more because it is the
acceptance test:

> **If an agent's name appears on the byline, that agent actually did the
> research and authored the work — and the records prove it.**
