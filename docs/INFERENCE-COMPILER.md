# Potion as an inference compiler

**Status: strategy, written 2026-08-23.** The long-horizon companion to
`docs/MIXING-ROADMAP.md` (the detailed mixing program) and
`docs/AUDIT-2026-08-22.md` (the ranked state of everything). Internal: contains
measured spend, production numbers and unpublished results. Not for forwarding.

---

## 1. The thesis

Potion's contract with the customer is already its end state. `PolicySchema`
accepts an outcome bound — a cost ceiling, a quality floor, a p95, or a compound
of them — and nothing else. There is no field through which a caller names a
model or a strategy; the serving path reads none from the request body. The
customer declares the outcome, Potion chooses the means, and the trace reports
what it chose.

So the accurate description of the product is not "a model router that might
someday become something bigger." It is:

> **An inference compiler whose output, today, is usually a one-node program.**

The frontier makes that literal. It is not a ranking of models — it is a ranking
of *recipes*: single models, cascades, best-of-n, draft–verify, all competing
for slots on the same measured quality/cost/latency curve, with the dominated
ones discarded. A mixture earns its place exactly the way a model does. The
compiler's job is to keep that curve honest and serve the point the customer's
declaration selects.

Everything below is about widening what the compiler can emit — without ever
breaking the property that every point it emits is measured.

## 2. Where we stand

An honest inventory, because the strategy falls out of it directly.

| Layer | State |
|---|---|
| The declaration (front end) | **Finished.** Outcome bounds only; per-request policy hints; receipts (`x-frontier-trace`, `x-potion-model`) on every answer |
| Serving | **Live.** Ten clusters, three modalities, streaming, tool loops, fallbacks, budget hard-stops, OpenAI wire parity |
| Strategy executors | **Built, unmeasured.** All seven shapes implemented and tested in `packages/strategies` — and six of the seven have never been measured on a platform frontier, because the sweep still builds candidates as `[...singles, cascade]` |
| Strategy search | **Built, unfunded.** The candidate grammar and the paired-bootstrap promotion gate are shipped in `packages/researcher` — and disconnected from the campaign budget |
| Per-customer learning | **Live.** The learning period samples the org's real traffic, measures its incumbent against Potion's pick on that traffic, proposes the bar; per-kind-of-work floors ship |
| Instruments | **Known-weak.** The classifier is near a coin flip on production margins; judge trustworthiness is INDETERMINATE (G8, open) |
| Money | **Missing.** Invoice math and HTML rendering exist; Stripe appears nowhere in the tree. Every customer is currently free |

The summary in one breath:

> **The compiler's front end is finished. Its back end is thin. And its
> bottleneck is neither — it is evidence, and it is money.**

Potion's problem is not that it cannot express multi-model strategies. It is
that almost none of the strategy space has been measured, the instruments doing
the measuring are known-weak, and no customer has a way to pay.

## 3. What the evidence says

Six facts, each with its measurement. The roadmap is shaped by these, not by
architecture ambition.

**1. Mixtures pay where verification is cheaper than generation.** On agentic
tool use, cascades *lost* — text-judged headroom did not transfer to function
calling. The committed creative cascade costs *more* than a single at the same
quality and survives on latency alone. Re-measured, rewrite-edit's cascade came
back as the **budget** point (0.836 / $0.34), not the quality point. Where
mixtures win, they win decisively: on code-gen a two-stage cascade reached the
top measured quality at roughly half the cost of the strongest single model —
and no single model on that frontier reached that quality at all; the
extraction-vision cascade is frontier-optimal at 1.000 / $0.90.

The pattern: mixing pays on mechanically-scored work, where a deterministic
check or an execution run replaces a judge. On open-ended generation the
verifier is another model, and a judge good enough to trust often costs what
the better model costs. The program therefore segments by *verifiability*, not
by mechanism.

**2. Escalation is a latency multiplier.** The committed rewrite-edit cascade
measures p95 **54 seconds** against 5.9s for a comparable single. Sequential
escalation structurally fattens the tail; no interactive product accepts that.
Two consequences: latency stays a first-class frontier axis (a mixture that
blows the bound is simply not on the menu), and a mixture's p95 must be
*projected before money is spent measuring it*, the way cost already is.

**3. The quality oracle is the product.** Every strategy more ambitious than a
single call rests on knowing whether an answer was good. Our judges'
trustworthiness is INDETERMINATE (G8, open); capability mixing is unsafe on
judge-scored clusters until it closes. And confidence self-report — a model
grading itself — is not a signal worth building on. The calibratable signal is
**agreement between independent models**, which is also a better escalation
trigger: the strong model arrives holding two competing drafts instead of
answering cold.

**4. The classifier is near a coin flip, and everything routes off it.**
Measured on production traffic 2026-08-22: centroid cosine 0.39–0.54 in every
length bucket, best/runner-up margin 0.025–0.069, 29 of 41 under 0.05. The
authored held-out set says 96% at the production threshold; the production
margins say the authored set is the wrong instrument. A compiler that compiles
confidently for the wrong task is worse than no compiler, and no downstream
strategy sophistication repairs it.

**5. The frontier must be free to move — and the customer must have the right
to know.** Silent improvement is the product's whole promise, and it is also an
eval nightmare for any customer who tests their own product; procurement at a
serious buyer asks about reproducibility before it asks about savings. Half the
answer is built — every frontier is versioned with the price list it was
computed from, and the receipts name what served. The missing half is
customer-facing: pinning a strategy version deliberately, and a subscribable
changelog of frontier movements. Silent improvement stays the default; it must
not be the only option.

**6. The compounding asset is failure anti-correlation, not feedback.** The
tempting moat story — task → strategy → outcome → customer feedback — needs a
signal that mostly never arrives: customers do not grade outputs, and implicit
signals are sparse and noisy. What Potion actually owns is quieter and better: a
content-addressed, **per-item** eval cache. For every measured model we know
exactly which held-out items it failed — so model pairs can be ranked by
oracle-fusion ceiling minus best-member score (the headroom fusion could
possibly capture) as a query over evidence already paid for, at $0. None of
this is conceptually novel — it is the compound-AI-systems agenda with a
measurement discipline attached. The moat is the corpus and the discipline,
never the concepts.

## 4. The constraint stack

Ordered. Each item bounds the truth or the value of everything under it.

1. **Money.** Usage-based pricing with no charge path. Every customer is free.
2. **Instrument.** Classifier separation and judge anchoring bound the truth of
   every measurement the rest of the roadmap produces.
3. **Verifiability.** Determines which workloads mixing can pay on at all.
4. **Latency.** Determines which mixtures can serve interactive traffic rather
   than batch.
5. **Breadth.** More shapes, more modalities, more clusters — only worth buying
   after 2–4, because breadth measured on a bad instrument is a bigger pile of
   numbers that mean less.

The temptation is to sequence by mechanism sophistication — each stage a
cleverer runtime than the last. The real sequence is by *what bounds the next
measurement's truth*.

## 5. The roadmap

### R0 — Charge money
The only P0. Payment rails, a customer-facing invoice route, and the savings
report reconciling to the invoice line for line.
*Exit:* a design partner's card is charged for measured usage, and the "saved
month-to-date" figure and the invoice agree.

### R1 — Fix the instruments
Two, in parallel, both cheap relative to what they unblock.

*Classifier:* a production-derived, judge-labelled held-out set the moment
partner traffic exists; then margin-aware centroids and per-cluster thresholds.
Judged by **margin distribution and the live tiebreak rate**, not by accuracy on
an authored set already shown to be the wrong instrument.

*Judge:* a small monthly human-labelled anchor sample, with drift in judge
agreement alarming the way quality drift already does. This closes G8, and G8
gates capability mixing on every judge-scored cluster.
*Exit:* the tiebreak rate falls and stays down on production traffic; judge
agreement against the human anchor is published in Frontier Notes with a trend.

### R2 — Fund the grammar
The platform sweep still builds candidates as `[...singles, cascade]`. The
grammar that generates the other six shapes exists and is called from the
researcher, not the sweep. Wire the sweep into `generateCandidatesExplained`,
budgeted per leg, behind an explicit `shapes:` parameter so an operator names
what a campaign is buying. Extend the preflight estimator to project a
mixture's escalation-rate-dependent cost **and** its p95, and refuse on
projected p95 exactly as legs already refuse on projected cost.
*Exit:* a platform leg measures more than one mixture shape; the leg file
records what was tried and what each cost; a mixture is refused pre-spend for
latency.

### R3 — Make mixtures servable
Today `chat.ts` narrows tool-carrying requests to single points and streams
only `single` — so the growth segment (agent traffic) and the interactive
segment cannot receive a mixture at all, however well it measures. Replace the
blanket exclusion with per-shape capability declaration (`canServeTools`,
`canStream`): a cascade whose terminal stage is an ordinary model call can
preserve tool semantics and stream, with the trace naming which stage answered.
Then attack the latency multiplier directly with shapes that do not serialise —
parallel draft-and-verify with early return, speculative escalation started
before the cheap answer is scored.
*Exit:* a tool-carrying, streaming request is served by a mixture on the
frontier with p95 within 2× the comparable single.

### R4 — Capability mixing
The only path to a claim that is not a discount. Cascades are cost instruments
and **a cascade can never beat its own best member**; beating the best model
that exists requires shapes that can exceed every member — execution-fused
ensembles, high-n best-of-n, strong-verifier draft–verify, and
critique-and-revise, the shape most likely to win and the one that does not
exist yet.

Three disciplines make this affordable and honest. Mine complementarity first,
at $0, and only spend on pairs whose oracle ceiling clears the best single
model. Fuse by execution wherever the domain allows, so the first attempt at a
best-model win is immune to the open judge question. Screen candidates on a
small item subset before granting any of them a full suite.

Add the third promotion path (`capability`): promote when the CI lower bound
against the best measured single on that cluster's frontier clears zero, with
cost bounded separately and generously — when the finding is a capability
nobody can buy, price is not the point.
*Exit:* either a measured mixture beats the best single model on a mechanically
scored cluster, or Frontier Notes publishes the list of what was tried and did
not. Both are publishable; only one is a product.

### R5 — Per-org strategies
A cascade's escalation threshold is a parameter tuned against a workload.
Tuning it per org, on that org's own traffic, is where a mixture stops being a
generic recipe and becomes a measurement of the customer. The learning period
already collects the traffic and already proposes bars; this extends the same
machinery from *which point on the frontier* to *what the point's internals
should be*. This is what makes "it gets better the longer you run it" literally
true.
*Exit:* an org's tuned threshold beats the platform default on that org's own
held-out traffic, by the same paired-bootstrap gate everything else clears.

### R6 — Beyond the model call
The compiler should eventually control more than model choice — but only the
dimensions that can be *measured on a frontier the way models are*. Three
qualify now: caching (a deterministic win, trivially scored), context
compression (measurable per cluster, with real quality risk the frontier will
price), and reasoning budgets — already partly learned, since reasoning marks
persist on the registry and models that cannot answer under a customer-sized
bound are skipped before the call.

Retrieval and tool orchestration are deferred until we can score them. "The
planner decides whether to call tools" is not a compiler optimization — it is
an agent runtime, and there is no measurement story for it.
*Exit:* at least one non-model dimension appears as a frontier point with its
own measured quality, cost and p95.

### R7 — Widen the declaration
The API already takes outcome bounds and nothing else, so the end state is a
widening, not a rewrite. What is actually missing: compound constraints with a
stated resolution order when they conflict, reliability as a fourth axis
alongside quality/cost/latency, per-request override of the org bar, and the
pinning and change-notification surface from §3.5. The customer keeps declaring
outcomes; they gain the right to say "and don't move under me without telling
me."
*Exit:* a customer can pin a strategy version, and receives a notification
naming every frontier movement that would have changed their served point.

## 6. What not to build

- **A generalized strategy data model, designed up front.** Task / Constraint /
  Node / Graph / Strategy / Execution / Evaluation / Policy as a framework is
  how a small product acquires abstractions nobody asked for. The primitives
  that earned their way in are already here; add the next one when a
  measurement demands it.
- **A visual workflow builder.** Many products let developers build complicated
  AI workflows. Potion's value is that the customer doesn't have to.
- **A recipe picker, or a "use cascade" toggle.** It hands the customer a
  mechanism decision they have no measurements to make, and converts a
  differentiator into configuration burden. Richer mixing should be invisible
  except as a better point on the frontier and a different name on the receipt.
- **A general planner before verifiers demonstrably pay.** Every dimension in
  R6 multiplies the search space; none is worth searching while the quality
  signal is indeterminate.
- **Confidence self-report as the escalation signal.** Use inter-model
  agreement.

## 7. The test

A strategy this ambitious attracts tests that cannot fail — "does this make the
product more automatic?" passes everything, which is exactly why it decides
nothing. The test has to be able to say no:

> **Does this put a new point on a measured frontier that a customer can buy —
> or make an existing point more trustworthy?**

If it does neither, it is research. Research is valuable here and has its own
channel: it goes in Frontier Notes, and it comes back to this roadmap when it
has a measurement attached.

---

*Companion documents: `docs/MIXING-ROADMAP.md` (Track A cost mixing M1–M5,
Track B capability mixing B1–B4 — the detailed version of R2–R5),
`docs/AUDIT-2026-08-22.md` (ranked state of everything), `FRONTIER.md` (what
the frontier is, in plain language).*

---

## Addendum (2026-08-24): the standing laboratory, and the asymmetry rule

**The standing laboratory (`docs/RESEARCH-DIRECTION.md`) is the mechanism
by which this compiler's cost model and pass library improve.** The
taxonomy → hypothesis → experiment → adjudication → publication loop is
how new points reach frontiers and how negative priors prune what the
compiler will never emit; the R2–G8 campaign of 2026-08-24 was one manual
turn of that loop, and the laboratory is its institutionalization.

**The measurement-asymmetry rule is binding on every research stage:
the suite leg adjudicates; the serve leg screens.** Measured basis
(2026-08-24): reference-anchored judging correlates perfectly with
deterministic truth; reference-free judging is structurally blind to
omission-class defects. No serve-time signal — confidence self-report,
classifier margin, or a bare judge — may adjudicate a finding, a
promotion, or a graduation. Publication into frontiers inherits every
existing gate: the regression guard, the CI promotion gate, and operator
sign-off for novel shapes.

