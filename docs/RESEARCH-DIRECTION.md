# The standing laboratory — research direction (2026-08-24)

**Status: research identity, recorded by operator direction. Docs-only.**
The third leg of the platform, alongside the guarantee product and Potion
Lab (`docs/LAB-DIRECTION.md`) — and the compounding one. Companion to
`docs/INFERENCE-COMPILER.md` (the north star this laboratory serves) and
`docs/MIXING-ROADMAP.md`. The external publication institution this
document deferred is now specified in `docs/RESEARCH-FLEET.md`
(2026-09-01).

## What it is

Potion's research program is a **standing laboratory for inference
science**: a closed-loop, autonomous system that continuously discovers
which compositions of models perform which shapes of real work, at what
cost, with contract-grade evidence — and feeds every finding back into the
platform's frontiers. It is not a benchmarking feature and not a human
research effort. It is **the platform studying the model ecosystem on live
workloads, permanently.** (The 2026-08-24 mixing campaign — R2 through the
judge calibration — is this loop run once by hand; the laboratory is that
week, institutionalized.)

## The loop, and what each stage maps to

1. **Taxonomy.** Content-free task-shape vectors stamped on every request
   accumulate into the **task-shape atlas**: an empirical taxonomy of
   production inference work. The atlas is the coordinate system for all
   research and is proprietary.
   *Maps to:* the capture columns on `request_logs` (`task_shape`,
   `prompt_fp`, `session_fp` — migrations 0055/0056, live).
2. **Hypothesis generation.** Candidate compositions per task shape, drawn
   from the strategy set and prior findings, with **negative priors pruning
   the candidate set first** (the ceiling scan's "unwinnable venue" class is
   the founding example).
   *Maps to:* the strategy grammar (`generateCandidatesExplained`), the
   sweep's `shapes:` parameter, the Step 5 candidate-grid discipline, the
   headroom/ceiling scan (`scripts/r4-headroom-scan.ts`).
3. **Experimentation.** Replay-first against cached executions; live shadow
   traffic only under slack-funded exploration budgets **once floors
   exist**; every campaign `capUsd`-required, fail-closed, with the same
   spend-attribution separation as platform sweeps.
   *Maps to:* replay purity, `org_platform_ops` attribution, the Step 5
   budget belts, the cost preflight and the p95 pre-spend gate.
4. **Adjudication.** Findings are certified **on the suite leg only** —
   reference-anchored, CI-carrying, provenance-complete. A hypothesis that
   cannot be certified is published internally as a **typed negative or a
   refusal, never dropped**. Serve-leg signals screen; they never
   adjudicate.
   *Maps to:* the measurement asymmetry (measured 2026-08-24: anchored
   judging r = 1.000, reference-free blind to omissions), the certification
   machinery, evidence ids, the CI verdict discipline (interval, never the
   point).
5. **Publication.** Certified findings flow into frontiers and autopilot
   priors — **through every existing gate, never around them**: the
   frontier-regression guard, the paired-bootstrap/CI promotion gate, and
   the standing rule that novel-shape promotions are surfaced to the
   operator before a customer can be served one. A separate,
   **operator-gated external publication path** exists for content-free
   structural findings (composition leaderboards); atlas coordinates, shape
   detectors, and per-org anything **never leave**.
   *Maps to:* frontier versioning + provenance; Frontier Notes' fail-closed
   redaction is the model for the external path, which remains future and
   operator-only.

## Defensibility

The laboratory requires **simultaneously**: (a) a calibrated instrument,
(b) contractual rights to derive structural findings from live traffic,
(c) falling per-experiment cost, and (d) **neutrality** — no models of its
own to favor. No academic group, frontier lab, or router competitor holds
more than one of these. The asset that compounds is **explored territory**:
the atlas plus the certified findings corpus (including its negatives —
"cascades lose on tool-calling" is as proprietary as any win).

## Honest limits

- The **composition-beats-monolith bet is unvalidated on real traffic**;
  partner one's data adjudicates it. The hand-run evidence so far
  (`docs/research/r4-pair-mixing-2026-08-24.md`) is mixed: cost-mixing
  wins are measured and serving; capability wins are bounded by the
  best-member law and blocked at ceiling venues.
- **Pre-partner, the lab operates on replay and synthetic corpora only.**
- **Autonomous spend is subject to every existing fail-closed gate and
  adds no new spend authority of any kind** (caps, KEY_RISK_ACCEPTED,
  ledger rows, the budget belts).
- Instrument ceilings bound what the laboratory can see (two suites are
  saturated at the top as of 2026-08-24); instrument evolution — hardening
  plus the saturation alarm — is standing work, not a one-time fix.

## Prerequisites — in place, not pending

The three un-backfillable items this program cannot exist without are
**done** (2026-08-24): task-shape vectors on every request and
implicit-outcome stamps including the recorded null case (migrations
0055/0056, content-freedom test-asserted), and the structural-findings
clause present in both the terms and privacy drafts (in the counsel
package). They preceded any partner traffic, as required.

## Named future steps (no numbers; placement is an operator decision)

Each composes existing parts rather than new subsystems, and inherits
every existing gate (caps + ledger, tenancy, provenance, promotion gates,
operator sign-off where named above):

- **Task-Shape Atlas** — capture columns → clustering → atlas versioning;
  builds on the agent-session clustering machinery and frontier-style
  versioning. Proprietary end to end.
- **Exploration Engine** — slack-funded shadow campaigns under live
  floors; builds on shadow configs, the budget belts, and per-call spend
  attribution. Post-partner by definition.
- **Findings Registry** — typed certified / negative / refused findings
  with evidence chains, feeding frontiers and autopilot priors; builds on
  the certification machinery and the research-note discipline already in
  `docs/research/`.

## The cross-leg relationship (one instrument, three legs)

Lab supervision traffic (pore answers as human labels) is a future
calibration input to the instrument; the instrument adjudicates both
graduation (Lab) and findings (research); the research program's findings
feed the autopilot that serves the Lab. See `docs/LAB-DIRECTION.md` for
the Lab half of this statement.
