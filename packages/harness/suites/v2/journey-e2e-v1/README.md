# journey-e2e-v1 — task completion as the atomic outcome

Nine multi-step journeys promoted from the journey-grain equivalence
experiment (2026-08-25; see `docs/research/journey-equivalence-2026-08-25.md`
and `scripts/journey-specs.ts`, which remains the authoring source of truth
for these items). Call-level evals can all look healthy while the journey
fails — a model can answer every step plausibly and still hand the customer
a wrong final artifact. This suite scores what the customer got.

## Semantics

- One journey = one item. `prompt` is step 1; `journeySteps` are the
  follow-ons, run in order with the **same strategy**, each prompt templated
  with earlier outputs (`{{prev}}` = last output, `{{prevN}}` = N+1 back).
- Only the **final** artifact is scored, deterministically (`field-contains`
  dotted-path/contains checks or `code-exec`). No judge anywhere.
- Usage sums over every step; latency is whole-job wall time.
- Step `clusterId`s document the kind of work per step and enable a future
  routed-arm replay (per-step model choice). The harness itself never
  routes mid-journey: this instrument measures a strategy's **whole-job**
  completion.

## Honest scope

Synthetic journeys authored to mirror common pipelines. They must never be
presented as evidence of real-world quality — partner traffic adjudicates
composition claims for real. Measured baseline at authoring time (live,
2026-08-25): routed arm 0.944 mean end-score vs best monolith 0.972 (one
step-flip inside noise, n=18 per arm) at 3.2× lower cost.
