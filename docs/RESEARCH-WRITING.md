# The Potion Research Writing System — direction (v1, 2026-09-01)

**Status: adopted with seven amendments.** Companion to
`docs/RESEARCH-FLEET.md` — this is the fleet's writing layer: voice,
article construction, style exemplars, and the editorial clock. It sits on
top of the research strategy, the content archetypes, and the eight-agent
operating model, and every rule here is subordinate to the fleet's
R-amendments (publish is a gated act class; bylines derive from records;
the calendar never outranks the evidence).

The operator's objective is correct and adopted: the editorial standard
must be explicit enough that Potion Workers autonomously produce work that
consistently feels like **Potion Research** — a research organization that
happens to have unusually interesting data — never generic AI-generated
technical content.

---

## The seven amendments

**E1 — The style guide's own numbers are radioactive.** This document
carries concrete fictional measurements (270.9×, 0.979, $0.0231, 18 days,
39%, the reasoning-budget table) and will sit in every author's context.
A model steeped in exemplar numbers reproduces them — the
caption-vs-provenance class waiting to happen: a "measured" 270.9× that
was never measured. Three laws follow: every example below is stamped
**FICTIONAL — style exemplar only**; **no published number without a
record pointer** (the numbers lint, E4); and the §25 writing evals plant
these exact values as automatic fails.

**E2 — The clock defers to the pipeline.** The newsroom schedule below
keeps its times as **SLA defaults, not deadlines**. A verification FAIL,
a repair round, or a gate hold always outranks the clock — the
calendar-never-outranks-evidence rule applied to hours. And the state
machine carries the fleet's R3 reality: between APPROVED and PUBLISHED
sits **the publish gate** — parked for operator approval until the
archetype's standing grant is earned, autonomous-with-audit after. During
supervised infancy, "9:00 publish" means "9:00 submit to the gate."

**E3 — The schedule has a seed form.** The full Monday ceremony assumes
six minds. At the R5 seed (Delta + Auditor, operator-as-Atlas) the same
state machine runs with fewer minds: Delta produces the one memo, the
operator triages, Auditor verifies. Ceremony activates as minds split;
the pipeline never changes.

**E4 — Style enforcement is deterministic where it can be.** The
banned-phrase list (§5), the inflated vocabulary (§3), the flag words
(§24), and the numbers lint run as **deterministic lints in the
publication workflow** — determinism beats intelligence where possible
(standing doctrine). Lints on banned phrases and exemplar numbers block;
flag-word hits route to Auditor's attention rather than auto-rejecting.
The judge handles what lints cannot.

**E5 — Voices emerge from role and memory, never costume.** The
author-style section (§17) is descriptive expectation, not a persona
prompt. If bylines are real (fleet R2), voices differentiate naturally
from different jobs and different memories. The hard rule: **Scribe never
edits toward a persona** — voice-correcting Delta's prose to sound "more
Delta" is Scribe secretly writing, which the fleet doc bans.

**E6 — Interrogability is a mechanism, not a tone.** The second
obligation (§27 — "make it possible for another sophisticated person to
interrogate how Potion knows it") is delivered by **evidence ids and
methodology links on key claims**, rendered from the research record.
And "defined once, used consistently" (§4) is literal: the vocabulary is
**one published canonical glossary page**; articles link terms, they do
not redefine them.

**E7 — CTAs come from the live-surface registry; corrections skip the
calendar, never the pipeline.** Scribe draws every CTA from a maintained
registry of live product surfaces and never invents a target — a CTA to
a dead flow is worse than no CTA (the surface-review law). Corrections
bypass editorial *scheduling* only: Auditor and the publish gate still
stand, and under R3 a correction is a publish act like any other.

---

# 1. The fundamental writing principle

Potion Research writes like a research organization that happens to have
unusually interesting data — not like a SaaS company, a marketing team, a
model-review site, an AI newsletter, an SEO publisher, or a VC
thought-leadership account.

The hierarchy is:

> **fact → evidence → interpretation → implication → Potion**

Never: Potion → thesis → evidence selected to support it. Potion arrives
late in the article. The reader independently discovers why the product
matters.

# 2. The voice

- **Empirical.** "We measured 0.979 quality at $0.0231 per thousand
  requests" — never "smaller models can deliver amazing value."
- **Precise.** "We did not observe an improvement" — not "it didn't
  work," unless the evidence warrants the stronger statement.
- **Understated.** Strong facts carry the article. **If the number is
  astonishing, the writing becomes calmer.** "The two models differed by
  2.1 measured quality points and 270.9× in price" — never "an absolutely
  insane 270X arbitrage opportunity."
- **Skeptical.** Actively search for reasons the conclusion may be wrong.
- **Economically literate.** Quality without price is incomplete; price
  without required quality is incomplete.
- **Technically accessible.** Rigorous to an excellent engineer; legible
  to a technical founder or CTO.
- **Curious.** Comfortable ending with unresolved questions.
- **Unpromotional.** Do not praise Potion. Demonstrate Potion.

# 3. Sentence-level rules

- **Short declarative sentences around important findings**; longer
  sentences for qualification.
- **Numbers over adjectives**: "cost 270.9× less," never "dramatically
  less expensive."
- **Concrete nouns over abstraction**: "teams may be paying for model
  quality their workload does not require," never "significant economic
  optimization opportunities exist."
- **Inflated AI vocabulary is linted** (E4): revolutionary,
  transformative, paradigm-shifting, game-changing, groundbreaking,
  unprecedented — banned unless literally established. The number is
  stronger anyway.

# 4. Vocabulary (the canonical glossary — E6)

Defined once, on one published glossary page every article links:

| Term | Definition |
| --- | --- |
| **Measured quality** | An evaluation score. Never "intelligence." |
| **Required quality / quality floor** | Minimum measured quality acceptable for the workload. |
| **Economic frontier** | The set of measured options not dominated simultaneously on quality and cost. |
| **Frontier leader** | The economically preferred option given a specific requirement. |
| **Candidate** | A model or strategy under evaluation for inclusion. |
| **Audition** | Evaluation of a newly available model. |
| **Drift** | A statistically or operationally meaningful change from prior measured behavior. Not every noisy movement. |
| **Frontier tax** | Excess spend relative to the current measured frontier. |
| **Stale-model tax** | Frontier tax from an outdated inference decision. |
| **Quality premium** | Incremental cost of additional measured quality. |
| **Frontier half-life** | Measured persistence of economically optimal inference choices. |
| **Launch hit rate** | Share of newly evaluated releases that meaningfully improve an existing frontier. |
| **Overbought inference** | Capability materially above the workload's requirement. |

# 5. The banned-phrase lint (E4 — deterministic, blocking)

> In today's rapidly evolving AI landscape… · As artificial intelligence
> continues to transform… · Choosing the right LLM has never been more
> important… · There is no one-size-fits-all solution… · In this article,
> we'll explore… · Let's dive in. · The results may surprise you. · This
> highlights the importance of… · The future of AI is…

These are generic AI-content signatures. Potion begins with the result.

# 6–8. Headline, dek, first paragraph

**Headline = surprising fact + specific magnitude.** The finding is the
headline, never the topic. "The last 2.1 points of code quality cost
270×" — never "Code Generation Benchmark Report."

**The dek establishes exactly what Potion can prove** and prevents the
headline from misleading: "On Potion's measured code-generation suite,
one model scored 1.000 at $6.2568 per thousand requests while another
scored 0.979 at $0.0231."

**The first paragraph contains the result — no warm-up.** Within 100
words the reader knows what happened, how large it was, and why it
matters. Then the immediate scope check: "That doesn't mean the cheaper
model is better. It means 'best model' is incomplete unless the workload
specifies how much quality it actually requires."

# 9. The middle

The intellectual progression of a feature: **observation → comparison →
mechanism → economics → production decision → boundary → larger
implication.** Every section advances the argument; sections that restate
are removed.

# 10. The conclusion

Never a generic summary. The ending moves one conceptual level higher —
from "2.1 points cost 270×" to "the difficult question is becoming less
'which model is strongest?' and more 'how much intelligence does this
request actually need?'" — and then the CTA answers the reader's natural
next question (from the registry, E7).

# 11–12. Limitations and uncertainty

Limitations are mandatory and written plainly — they actively constrain
interpretation: "This result comes from one code-generation suite. A
different distribution of tasks could produce a different frontier. It
does not establish that 0.979 is sufficient for your application."

Uncertainty language: *we observed / we measured / the evidence suggests /
we have not established / we do not yet know / one possible explanation
is / we would need X to distinguish these.* Never hidden behind awkward
statistical prose. Never boilerplate ("as with any study…" — linted).

# 13. Failed experiments

Potion sounds intellectually satisfied — not apologetic — when a strong
hypothesis fails. Open with the expectation, the test, and the null:
"We expected combinations of cheap models to improve the quality-cost
frontier. We tested five approaches. None did." Then explain why the
hypothesis was reasonable. Negative results feel like discoveries.

# 14–15. Writing about Potion, and CTAs

Potion appears in four places: **methodology** ("Potion continuously
measures…"), **disclosure** ("Potion is withholding…"), **production
implication** ("Potion incorporates these measurements into…"), and the
**CTA**. No feature paragraphs. The research does the selling.

Each CTA answers the question the research just created, and resolves to
a live surface (E7): quality-premium piece → *Measure your quality
premium →*; half-life piece → *Check your current frontier →*; audition →
*Let Potion audition models against your workload →*; routing-economics
piece → *Calculate your frontier tax →*. Never "revolutionize your AI
stack with Potion today."

---

# 16. Style exemplars

> **⚠ FICTIONAL — style exemplars only (E1).** Every number in this
> section is invented for style calibration. These exact values are on
> the lint blacklist: a real manuscript containing one fails the numbers
> lint unless its research record independently contains the value and
> Auditor confirms the coincidence. Never cite, reuse, or "remember"
> these figures as measurements.

**Frontier Notes** — terse, measured, no forced story, signal
distinguished from confirmation. And it is the R4 pattern executed:

> # Three launches, zero new routes
> Three newly eligible models entered Potion's evaluation pool this week.
> None improved a measured frontier. Two came close. Model A matched the
> incumbent's extraction quality but cost 1.8× more. Model B was cheaper
> on retrieval but fell below the required quality floor. Elsewhere, one
> code model triggered a canary; a full replay is running. We are not
> calling this drift yet. … The absence of a frontier change is itself
> useful: economically meaningful model releases remain comparatively
> rare.

**Single Finding** — the monitoring/optimization distinction:

> # This model still worked. It had become 5× too expensive.
> Its quality was not the problem. Its economics were. … Monitoring asks:
> does it still work? Optimization asks: is it still the computation we
> should be buying?

**Launch Audition** — a strong model is not automatically an economically
useful model:

> # GPT-X launched. It earned one route.
> It improved one of eight measured economic frontiers. It produced
> higher raw quality on reasoning and code, but not enough to justify the
> price under current quality requirements. For Potion's measured
> workloads, GPT-X changed one production decision.

**Drift Alert** — canary screens, replay adjudicates (the measurement
asymmetry, `docs/RESEARCH-DIRECTION.md`):

> # A code model moved outside its previous quality interval
> Four items are not enough to establish drift. We reran the complete
> held-out suite. The larger evaluation confirmed the movement. … We do
> not currently know why the behavior changed.

**Deep Experiment** — preregistered success condition stated before the
result; the exchange rate measured:

> # Does asking a model to reason longer actually improve the frontier?
> Before running the experiment, we defined success as: a
> reasoning-budget increase must produce sufficient measured quality
> improvement to remain on the quality-cost frontier. … The first
> increase helped. The next two mostly didn't. Beyond that point the
> model continued spending tokens. It mostly stopped buying quality.

**Negative Result** — scope-exact, no apology:

> # We tried to predict which requests needed the expensive model. We couldn't.
> We tested three confidence signals. None separated correct from
> incorrect outputs reliably enough to improve the frontier. This is not
> evidence that confidence-based escalation can never work. It is
> evidence that these three signals, on these workloads, did not. For
> now, Potion does not use them.

**Corpus Finding** — the longitudinal claim with the operational
implication:

> # Most frontier changes weren't caused by model launches
> … The model-launch cycle explains less than half of what changed.
> Reevaluating only when a major model launches misses most reasons the
> correct inference decision can change.

**Production Economics** — honest about when Potion isn't worth it:

> # When model routing isn't worth it
> Model routing introduces complexity. That complexity should earn its
> place. … The question isn't "does routing reduce cost?" It is "does
> the expected value of continuously optimizing this workload exceed the
> cost and complexity of doing so?" Sometimes the answer is no. Potion
> should say so.

**Research Thesis** — the abstraction argued from staleness, not
preference:

> # "Best model" is becoming the wrong abstraction
> … We did not arrive at this conclusion from architecture preference.
> We arrived at it because static model decisions keep becoming stale.

# 17. Author styles (descriptive, per E5)

Expected differentiation — emergent from role and memory, never a
costume, never Scribe-imposed:

- **Delta** — fast, empirical, minimal interpretation. "Three models
  entered the pool. None moved a frontier." Avoids philosophical
  introductions, futurism, category theses.
- **Curie** — methodical, question-oriented, comfortable with
  complexity. "There are at least two plausible explanations we cannot
  distinguish with this experiment." Makes the reader understand the
  experiment itself.
- **Ledger** — economic, marginal, decision-oriented. "At one million
  requests, that difference becomes $6,233.70." *(fictional)*
- **Archive** — historical, patient, pattern-oriented. "No individual
  week looked extraordinary. The twelve-week series did."
- **Atlas** — writes rarely; synthesizes (State of Inference
  introductions, the Charter, methodological synthesis).

---

# 18. The weekly editorial clock

Times are Pacific, and per E2 they are **SLA defaults**: the sequence is
binding, the clock is not. A FAIL, repair round, or gate hold always
outranks it. Per E3, the **seed form** runs the same pipeline with Delta
producing the one Monday memo, the operator triaging as Atlas, and
Auditor verifying; the ceremony below is the destination.

**Monday — find the truth.**
- 6:00 — weekly baseline measurement cycle completes; outputs land for
  Delta, Archive, Ledger.
- 6:00–8:00 — independent memos: Delta's **Weekly Frontier Memo** (≤1,000
  words: movement, auditions, anomaly candidates, headline candidates);
  Archive's **Historical Context Memo**; Ledger's **Economic Movement
  Memo**; Signal's weekend delta on Friday's response memo (one memo per
  week, not two).
- 8:00 — Atlas triage: Tuesday's headline, investigations, Thursday
  feature readiness, event pieces. Decisions recorded in the registry
  with rationale (fleet R2).
- 9:00–15:00 — investigation: anomalies rerun, extraordinary economics
  independently reverified, historical patterns tested against alternate
  periods and definitions, active experiments continue.
- 15:00 — Frontier Notes scope locks; Delta writes.

**Tuesday — publish the ledger.**
- 6:00 — Delta's complete draft: <1,000 words unless exceptional, one
  headline finding, all meaningful weekly changes, no unresolved claims
  presented as conclusions. A quiet week ships "nothing moved" as a
  measured claim (fleet R4) — never padding.
- 6:30 — Ledger/Archive contribute only where their expertise is
  necessary; they do not rewrite Delta.
- 7:00 — Auditor receives draft + evidence + tables + calculations;
  7:45 — typed verification record returns. **A FAIL stops the clock**:
  the note ships later, smaller, or as the quiet-week form.
- 8:00 — Delta resolves scientific changes; 8:15 — Scribe edits
  (headline, dek, ordering, chart, direct-answer block, metadata);
  8:45 — Auditor's final factual diff: did editing change meaning?
- 9:00 — **submit to the publish gate** (E2): parked for operator
  approval until the Frontier Notes grant is earned; autonomous with
  audit after. Lints (E4) run in the workflow before the gate.
- On publish — Signal distributes; important technical responses go to
  Atlas immediately, not Friday.

**Wednesday — go deeper.** No mandatory publication, by design. Deep
work; 13:00 feature checkpoint: an artifact that meets the bar, or
**Thursday is cancelled**. If assigned: **research record first, prose
second** — the record is complete before manuscript drafting begins.

**Thursday — publish something worth remembering.**
- 5:00 — manuscript submitted; 5:30–7:00 — Auditor's full review (for
  Deep Experiments: rerun calculations, challenge inference, inspect
  limitations, check the preregistration hash against the result);
  7:00 — author resolves; 7:30–8:15 — Scribe pass (structure, headline,
  dek, hero chart, direct-answer block, FAQ where useful, metadata,
  CTA); 8:45 — author approves semantic fidelity; 9:00 — Auditor final;
  9:30 — gate, publish, distribute. Same E2 rule: quality outranks the
  clock.

**Friday — get it to the people who should know, then listen.**
- 6:00–10:00 — Signal evaluates: who read it, who cited it, what
  technical readers challenged, which questions recur, search/answer
  presence, product signal, channel quality. Never just traffic.
- 10:00+ — selective second wave: specific communities, researchers,
  journalists, newsletter authors, internal links, Measured Answer
  updates. No blind reposting.
- 15:00 — **Research Response — WXX** memo: strongest response, best
  external criticism, common misunderstanding, new question generated,
  citations, qualified product signal, recommended follow-up. To Atlas
  for Monday. Archive ingests the week. The week closes.

# 19. Event-driven schedules

**Major launch:** flag → Atlas triage → Delta audition (T+0–12h) →
research record once results suffice → Auditor → Scribe → final pass →
gate → publish. Quality determines timing, not the desire to be first.

**Drift:** canary marks *possible drift* — no article. Full replay
confirms → record → Auditor → Scribe → Drift Alert if material. Right
tomorrow beats dramatic today.

**Breakout finding:** any researcher nominates; Atlas evaluates
immediately; if evidence is mature: author → Auditor → Scribe → Auditor
→ gate → publish. Do not wait for Thursday.

**Correction:** bypasses scheduling only (E7). Auditor identifies →
original author investigates → verified → gate → published as soon as
the corrected fact is established, linked from the original and the
author's corrections list.

# 20–21. Monthly and quarterly

Four-week Thursday rotation: Deep Experiment / Corpus Finding / Deep
Experiment / strongest-of (Production Economics, Corpus Finding, Field
Study, Thesis, Delayed Reveal) — plus event pieces whenever justified.

State of Inference is not written in one frantic week: weeks 1–8 Archive
maintains quarterly metrics continuously; week 9 Atlas selects themes
from evidence; week 10 section research records; week 11 Archive
assembles, Atlas synthesizes, Auditor deep-validates, Scribe edits;
week 12 charts, final verification, publish. Signal runs a multi-week
distribution program on individual findings, never one announcement
blast.

# 22. The state machine (amended per E2 + fleet R2/R3)

```text
OBSERVATION → TRIAGE → INVESTIGATION → RESEARCH RECORD
    → VERIFICATION 1 → MANUSCRIPT → EDITORIAL → VERIFICATION 2
    → LINTS → APPROVED → GATE (parked-for-operator | autonomous+audit)
    → PUBLISHED → DISTRIBUTED → RESPONSE ANALYZED → ARCHIVED / FOLLOW-UP
```

No piece skips from *interesting number → manuscript*. The research
record protects quality; the gate carries R3; every transition is a
recorded step.

# 23. Scribe's editorial checklist

Opening: is the result visible immediately? Headline: an empirical
claim? Numbers: important claims quantified, each with a record pointer
(E1)? Structure: each section advances understanding? Jargon: removed
where unnecessary, linked to the glossary where kept (E6)? Caveats:
important limitations obvious? Visualization: one canonical
evidence-bearing visual? Search: does the page answer the underlying
question? AEO: central facts in self-contained sentences? CTA: follows
from the reader's unresolved question, resolves to a live surface (E7)?
Potion: demonstrated, not praised? Length: **could 20% be removed
without losing anything? If yes, remove it.**

# 24. Auditor's language checklist (flag words route to Auditor — E4)

- **"proves"** → shows / measured / observed / supports.
- **"best"** → best measured under what criterion?
- **"cheapest"** → eligible set and date required.
- **"drift"** → confirming evidence required (suite leg).
- **"always"** → almost never acceptable. **"never"** → extraordinary
  scope required.
- **"equivalent" / "same quality"** → define the threshold; use the
  actual measured difference unless statistically justified.
- **"X% cheaper" / "X% of the quality"** → verify percentage semantics.
  This is exactly where a 0.979-versus-1.000 "99%" claim gets caught —
  the honest-numbers bug class, applied to prose.

# 25. Writing evaluations

A benchmark suite of research-writing cases, run through the judge
harness (fleet R1): clean data, ambiguous data, conflicting results,
null findings, strong-but-narrow results, tempting clickbait findings,
planted arithmetic errors, **planted exemplar numbers from this document
(E1)**, and planted disclosure leaks. Scored on: finds the correct
story; does not invent a stronger one; expresses uncertainty; selects
the right numbers; identifies limitations; leaks nothing protected;
writes in Potion style. The writing system itself is an Agent Builder
benchmark.

# 26. The north-star example *(FICTIONAL — E1)*

> **The last 2.1 points of code quality cost 270×.**
> On Potion's measured code-generation suite, one model scored 1.000 at
> $6.2568 per thousand requests. Another scored 0.979 at $0.0231. Both
> facts matter. If your application genuinely requires perfect measured
> performance, the expensive model may be the rational choice. If it
> requires at least 0.95, it isn't. The interesting question is
> therefore not which model is strongest. It is how much quality the
> workload requires — and what the market currently charges for it.

Nothing there sounds like marketing. Almost every sentence makes Potion
more valuable. That is the bar.

# 27. The complete editorial rule

First obligation: **make the reader understand something true about
inference that they did not understand before.** Second: **make it
possible for another sophisticated person to interrogate how Potion
knows it** — delivered by evidence ids and methodology links, not tone
(E6). Third: **make the finding sufficiently clear that the right people
discover and remember it.** Only then: **help Potion sell.** Following
that order is what makes Potion Research good at selling Potion.

# 28. The weekly loop, summarized

Monday: find the truth. Tuesday: publish the ledger. Wednesday: go
deeper. Thursday: publish something worth remembering. Friday: get it to
the people who should know, then listen. Repeat.

> **Research constantly. Write selectively. Publish only what is true
> and interesting. Distribute only where it is useful.**
