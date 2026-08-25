# Journey-grain equivalence: same ends, a fraction of the bill

**2026-08-25 · $0.37 across two runs · deterministic ends only, no judges
· scope: authored synthetic journeys; partner traffic adjudicates**

Nine multi-step pipelines (support-ticket, code, data families; 2-4 steps
each, every step's output feeding the next), run end-to-end through three
arms — or-sonnet on every step, or-gpt-full on every step, and per-step
routing to the serving frontier's cheapest single at the 0.90 floor. Final
artifacts scored by field checks and executed tests. Two seeded reps.

| arm | mean end-score | perfect finals | total bill |
|---|---|---|---|
| monolith or-sonnet | 0.792 | 12/18 | $0.114 |
| monolith or-gpt-full | 0.972 | 16/18 | $0.051 |
| **potion-routed** | **0.944** | **14/18** | **$0.016** |

- **vs the best monolith tested:** Δ = 0.028 — one step-flip across 18
  journeys, inside noise — at **3.2× cheaper**.
- **vs the common premium default (sonnet-class):** routed scored
  **higher** end-to-end (sonnet broke two code journeys outright,
  consistent with its 0.8675 hard-v2 reading) at **7.1× cheaper**.
- One rule-application item defeated **every arm identically** both reps
  (models skim rules — the same failure class our hardened classification
  exam and the judge-calibration negative measured). Routed's entire
  residual gap was one classification step, twice — exactly the per-step
  reading the learning period re-measures against a customer's own bar.

**Found on the way (kept honestly):** the first run failed code journeys
across ALL arms because the pipeline lost the function-name contract at
the restate step — models renamed the function downstream.
**Constraints erode across steps unless carried explicitly.** The
harness now pins the signature through the pipeline; the first run's
numbers are preserved in the artifact for comparison. This is itself a
journey-grain phenomenon worth knowing before agent traffic arrives.

The partner sentence this experiment backs, with receipts in
`artifacts/observatory/journey-equivalence.json`: **your journeys come
out the same, your bill doesn't.**
