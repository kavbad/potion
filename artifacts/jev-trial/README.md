# Jev (TypeSafe) trials — 2026-09-17

`scripts/jev-trial.mjs` runs Jev (`POST /v1/systemone`, model `jev-latest`)
against the platform's own labelled data. Key in `~/.typesafe-key`, never in
the repo. Two modes, dated outputs beside this README.

## classify — Jev as the workload classifier

382 items: the 200 held-out labelled items the centroid classifier is graded
on plus the 182 platform-suite items. One `choice` question over the 10
clusters (descriptions as criteria) plus a `noul` for "needs tools".

| set | accuracy | calibration (ECE) | p50 latency | cost |
|---|---|---|---|---|
| held-out (200) | 100% | — | — | — |
| suite (182) | 98.9% | — | — | — |
| all (382) | **99.5%** | 0.005 (378/382 at ≥0.9 confidence) | 126 ms | $0.014 |

Confusions: rag-answer → extraction ×2 (both suite items that hand the model
a document and ask for structured fields; a boundary case, not a miss).
Compare: the centroid classifier's held-out accuracy and, on the same 182
suite items in the head-to-head, 117 items below 0.55 confidence and 34
resolved off their label.

## judge — Jev as a second judge

539 answers from `artifacts/head-to-head/2026-09-17-after-42-floor-0.95.answers.json`
(one Jev 503). For `llm-judge` items Jev gets the rubric as a `score`
question; for deterministic items (`exact`, `field-match`, `code-exec`) a
`noul` "is the answer correct, compare to the reference".

| scorer | n | Pearson vs stored | mean abs diff | verdict |
|---|---|---|---|---|
| llm-judge (Sonnet) | 193 | 0.65 (0.44–0.94 by cluster) | 0.080 | second opinion, not a replacement |
| exact | 227 | 0.66 | 0.131 | **Jev right, our scorer wrong** on 25/30 disagreements (20 fixed by #44; 10 need a non-exact instrument) |
| field-match | 60 | 0.61 | 0.535 | Jev wrong: cannot compare JSON fields (exh-01 exact match → 0.36) |
| code-exec | 59 | 0.65 | 0.246 | Jev wrong: cannot run tests (passing solution → 0.16) |

Spot checks on the three largest llm-judge gaps: creative-014 (11 lines vs
a 12-line rubric) Sonnet 0.5 / Jev 0.9 — Jev missed the count;
agentic-tool-use-012 (correct license-gate-first sequence) Sonnet 0.9 / Jev
0.47 at confidence 0.34 — Jev wrong; rewrite-edit-011 (275 chars, all facts
kept) Sonnet 0.6 / Jev 0.97 — arguable either way. Jev's low `confidence`
did flag its own miss on the agentic item.

## Recommendation

- **Classifier: yes.** Jev at 99.5% / 126 ms / $0.036 per 1K requests is a
  better instrument than the centroid on this data. Ship it as a second
  assigner behind the existing `assignRanked` interface, feature-flagged per
  org, shadowed against the centroid for a week (log both, serve centroid),
  then flip. Keep the centroid as the fallback when Jev is slow or down
  (early access, ZDR enterprise-only — prompts leave the box; that is a
  customer-facing disclosure).
- **Judge: not as a replacement.** Agreement with the Sonnet judge is
  moderate and Jev loses on countable constraints; it cannot replace
  deterministic scorers at all. Use it where it is cheap and orthogonal: a
  second opinion on `llm-judge` cells whose rubric is holistic, and as a
  tie-breaker when a judge flake is suspected (its `confidence` is
  informative).
- **The real yield of the judge trial is the `exact` scorer bug** (see
  `artifacts/head-to-head/README.md`, "after #42").
