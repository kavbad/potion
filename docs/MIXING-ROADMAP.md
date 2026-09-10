# Mixing models — the unfunded half of the product

**Status: proposal, not started.** Separate track from `docs/LAB-BUILD-PLAN.md`
(paused) and `docs/SERVING-ROADMAP.md` (S1–S6 done). Written 2026-08-19.

---

## The finding that motivates this

Mixing is not missing. It is **built, tested, and disconnected from the money.**

| Component | State |
|---|---|
| `packages/strategies` | Executors for all seven shapes — single, cascade, best-of-n, draft-verify, ensemble, decompose, staged composite — each with tests, streaming and prompt-injection coverage. |
| `packages/researcher/src/generate.ts` | A template grammar producing mixing candidates from the model registry: cascade with a focus model slotted into every class-compatible stage, composite pairs, draft-verify, best-of-n, cross-provider ensembles, decompose (off by default). Deterministic, budgeted, deduped against evaluated hashes. |
| `packages/researcher/src/gate.ts` | A promotion gate with pinned statistics: paired bootstrap over held-out per-item deltas, 1000 resamples, 95% CI, promote only when the CI **lower** bound clears +1.5 quality points at no extra cost, or a 20% cost cut at no quality loss. |
| `research:scan` / `research:cycle` | Wired into the worker registry; `generateCandidatesExplained` is called at `handlers.ts:1547`. |

**The gap:** the platform sweep — the code path that spends the campaign
budget — does not use any of it. It builds candidates as
`[...singles, cascade]`: every reachable single model, plus **one** hardcoded
two-stage cascade. Six of seven mixing shapes have never been measured on a
platform frontier.

The consequence is visible in the evidence. Committed baseline: 3 mixtures out
of 44 points. The tranche campaign's first republished frontier (code-gen v3):
**zero** — its single cascade candidate failed and was contained. Mixing is
falling off the map by attrition, not by a decision.

## Why it is worth funding

The one mixture that got measured properly earned its place: on the committed
code-gen frontier a two-stage cascade reached the top measured quality at
roughly half the cost of the strongest single model, and **no single model on
that frontier reached that quality at all.**

The strategic argument is larger than that row. The space of single models is
enumerable and every competitor sees the same list. The space of useful
*combinations* is combinatorially larger, essentially unmeasured, and is the
one place a measurement corpus produces findings nobody can look up.

## A property to preserve: mixing is internal

`PolicySchema` accepts an outcome bound — a cost ceiling, a quality floor, a
p95, or a compound of them — and nothing else. There is no field through which
a caller can name a strategy, and the serving path reads none from the request
body. The customer states the outcome; Potion chooses the means; the trace
reports what it chose.

Every phase below must keep that true. The temptation as mixing gets richer is
to expose it — a recipe picker, a "use cascade" toggle — and that would invert
the product: it hands the customer a mechanism decision they have no
measurements to make, and it converts a differentiator into configuration
burden. Richer mixing should be invisible except as a better point on the
frontier and a different name on the receipt.

## What is honestly in the way

Stated plainly, because these are the reasons mixing is losing today and no
plan works without addressing them.

1. **Mixtures cannot serve tools.** `routes/chat.ts` narrows tool-carrying
   requests to single points, because a strategy that rewrites or fans out the
   prompt cannot guarantee tool-call semantics. Agent traffic is exactly the
   growth segment.
2. **Mixtures cannot stream.** `chat.ts:847` streams only `single`.
3. **Latency.** The committed rewrite-edit cascade measures p95 **54 seconds**
   against 5.9s for a comparable single. Sequential escalation is a latency
   multiplier, and no interactive product accepts that.
4. **They are not always better.** The committed creative cascade costs *more*
   than a single at the same quality and survives on latency alone. An honest
   program has to be willing to report that.
5. **Operational fragility.** Multi-stage strategies have more ways to fail;
   the campaign's one cascade candidate died at zero cells.

## Phases

Sequenced so the cheap, decisive work comes first and nothing expensive runs
before the evidence justifies it.

### M1 — Fund the grammar (cheap, no new science)
Replace the platform sweep's hardcoded `[...singles, cascade]` with a call
into `generateCandidatesExplained`, budgeted per leg. Gate behind an explicit
`shapes:` parameter so an operator names what a campaign is buying. Nothing
new is invented; the existing grammar simply gets a budget.
*Exit:* a platform leg measures more than one mixture shape, and the leg file
records which shapes were tried and what each cost.

### M2 — Make the cost of a mixture legible before it runs
Extend the preflight estimator so a mixture's projected spend and projected
p95 are visible at plan time. A cascade's expected cost depends on its
escalation rate, which is measurable and currently not projected.
*Exit:* a leg refuses a mixture whose projected p95 exceeds a stated bound,
the same way it already refuses one that exceeds a cost cap.

### M3 — Unblock tools for the shapes that can honestly support them
A cascade's final stage is a single model call. Where a mixture's terminal
stage is the only one that emits tool calls, tool semantics can be preserved.
Implement per-shape capability declaration — `canServeTools`,
`canStream` — rather than the current blanket exclusion of everything
non-single.
*Exit:* a tool-carrying request can be served by a cascade whose terminal
stage supports tools, with the trace naming which stage answered.

### M4 — Latency-aware mixing
Escalation is what costs time. Explore shapes that do not serialise: parallel
draft-and-verify with early return, speculative escalation started before the
cheap answer is scored. These are real engineering, and they are what makes
mixing viable for interactive traffic rather than only for batch.
*Exit:* a mixture on a frontier with p95 within 2x of the comparable single.

### M5 — Per-org mixtures
The compounding story. A cascade's escalation threshold is a parameter tuned
against a workload; tuning it per org on that org's own traffic is where a
mixture stops being a generic recipe and becomes a measurement of the
customer. This is the phase that makes "it gets better the longer you run it"
literally true.

---

# Track B — Capability mixing: beating the best model that exists

Everything above (M1–M5) is **Track A: cost**. Its target is the incumbent
operating point and its win condition is spending less for the same measured
quality. Track B has a different target, a different gate, different economics
and a different buyer, which is why it is written separately rather than as
another phase.

**The objective:** find combinations of models that measure *better than the
best single model available anywhere* on a given kind of work — better than
the strongest thing Anthropic, OpenAI, Google, xAI, Mistral, Moonshot or
anyone else ships, on the tasks those models are themselves tested on.

## Why the current machinery cannot express this

`PromotionVerdict.path` is `'quality' | 'cost'` and both compare against the
**incumbent**:

- `quality` — CI lower bound ≥ +0.015 **and cost ≤ incumbent**
- `cost` — cost cut ≥ 20% **and** CI lower bound ≥ 0

A mixture that beats the best model in the world and costs three times as much
fails both. The cost constraint on the quality path is exactly right for Track
A and exactly wrong here: when the finding is a capability nobody can buy, the
price is not the point.

**B1 — a third path, `capability`.** Promote when the CI lower bound on the
paired delta against the **best measured single model on that cluster's
frontier** exceeds zero, with cost unconstrained (or bounded by a separate,
generous ceiling). The reference is a measured point, never a vendor claim —
if the best model is not in our catalogue, the comparison is not available and
the gate must say so rather than compare against a weaker incumbent.

## Why the generation grammar is also wrong for this

The templates that exist were designed to save money. A cascade is a cost
instrument: a cheap model answers and escalates only when unsure. Its quality
ceiling is its strongest stage — **a cascade can never beat its own best
member.** It is structurally incapable of the Track B win.

**B2 — quality-maximising shapes.** The ones that can exceed every member:

- **Ensemble with judge fusion** — several strong models answer, a judge picks
  or synthesises. Already implemented (`runEnsemble`), never measured on a
  platform frontier.
- **Best-of-n at high n** on a single strong model — implemented; n is the
  dial nobody has turned.
- **Draft–verify chains** where the verifier is a *different* strong model —
  implemented; measured only in the cheap-draft configuration.
- **Critique-and-revise / debate loops** — NOT implemented. A model answers,
  a second critiques against the task, the first revises. This is the shape
  most likely to produce a genuine capability gain and it does not exist yet.

## The honest risks, stated before any money is spent

1. **It may simply not work.** Many ensembles underperform their best member —
   a mediocre judge picking between a strong answer and a weak one loses to
   the strong model alone. The gate must be strict and the programme must be
   willing to publish "no mixture beat the best single model on this
   workload", repeatedly, without softening it.
2. **The judge becomes load-bearing.** Fusion quality is bounded by the
   judge's discrimination, and G8 left our judge's trustworthiness
   INDETERMINATE. Track B should not be trusted on judge-scored clusters until
   that is resolved; it is safest first on `code-gen` and `extraction`, which
   are scored mechanically.
3. **Measurement is expensive.** An ensemble of three strong models plus a
   judge is roughly four premium calls per item — an order of magnitude above
   a single-model cell. Track B needs its own belt and its own cap; it must
   never share Track A's budget silently.
4. **The ceiling problem bites hardest here.** Beating the best model can only
   be *detected* on a suite the best model does not already saturate. On the
   four clusters that sat at 0.970–1.000 the headroom is inside the noise —
   which is precisely what the hardened suites (`suites/v2/*-hard-v1`) were
   built for. **Track B is blocked on adopting them.** Running it against a
   saturated instrument would produce a confident null result and teach us
   nothing.

## How to search the space — the doctrine

The combination space is too large to sweep and too expensive to sample
naively; an ensemble cell costs ~4 premium calls. The search has to be smart
before it is big, and the corpus we already own is the instrument.

**S1 — Complementarity mining, at $0.** (Upstream tie-in: SERVING-ROADMAP S7
ranks *uncovered* models partly by vendor decorrelation, because this mining
step feeds on exactly that — new failure modes are where oracle ceilings
open.) The eval cache is content-addressed
and PER-ITEM: for every measured model we already know exactly which held-out
items it failed. So the first Track B artefact is not a new measurement — it
is a join over existing evidence: find model PAIRS whose failures
anti-correlate (A fails where B succeeds and vice versa). A pair with high
overlap in failures can never beat its members no matter how it is fused; a
pair with disjoint failures has a computable quality CEILING (the oracle
fusion score: right whenever either is right). Rank all pairs by oracle
ceiling minus best-member score — that number is the headroom fusion could
possibly capture — and only ever spend money measuring combinations whose
ceiling clears the best single model. This turns "which mixtures should we
try" from a guess into a query.

**S2 — Fuse by execution where the domain allows it.** On mechanically-scored
work (code-gen, extraction) the fusion step needs no judge at all: n models
answer, and selection is running the candidates against the reference checks.
An execution-fused ensemble is immune to the G8 judge question entirely — the
right place to attempt the first best-model win.

**S3 — Disagreement as the escalation signal.** Two models answer; agreement
is accepted, disagreement escalates to a strong model WITH both drafts in
context. Unlike confidence self-report (one model grading itself), agreement
between independent models is a measurable, calibratable signal — and the
strong model arriving with two competing drafts is a different, plausibly
better task than answering cold.

**S4 — Successive halving on spend.** Screen the S1-ranked candidates on a
small fixed subset of items; only survivors graduate to the full suite. A
combination that cannot distinguish itself on 12 items does not deserve 50.
Budget shape: many cheap looks, few expensive confirmations, one belt.

**S5 — Publish the nulls.** Every screened-out combination is recorded with
its ceiling and its measured score. "No mixture beat the best single model on
this workload, and here is the list of what was tried" is a finding with
commercial value — it is the measurement nobody else has.

## Sequencing

**B0.** ~~Adopt the hardened suites~~ **DONE 2026-08-20** — all four wired
into `PLATFORM_SUITE_BY_CLUSTER`. Track B unblocks once the first hard-suite
frontiers publish (the re-measure is queued behind the current campaign).
**B1.** The `capability` promotion path + best-single-on-frontier as the
reference point.
**B2.** Turn on the quality-maximising templates that already exist —
ensemble, high-n best-of-n, strong-verifier draft–verify — on the two
mechanically-scored clusters first.
**B3.** Implement critique-and-revise, the shape most likely to win and the
one that does not exist.
**B4.** If anything survives B2/B3: a separate product surface. A mixture that
beats the best available model is not sold as a saving — it is sold as a
capability, to a buyer who is not price-shopping, and the pricing has nothing
to do with usage-based cost reduction.

## What must not happen

- **No mixture ships unmeasured.** The promotion gate exists and its
  thresholds are pinned; mixing is exactly where the temptation to hand-wave
  is strongest, because the mechanism sounds clever.
- **No claim of superiority in general.** Two of three committed mixtures are
  marginal or worse. The product's credibility rests on reporting that.
- **The landing page stays honest.** It currently says combinations are
  measured the same way single models are, and that almost none of the space
  has been explored. Both must remain true.
