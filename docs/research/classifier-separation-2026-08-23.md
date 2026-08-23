# Classifier separation — what the two instruments say (2026-08-23)

## Two measurements that disagree

**Production traffic** (first 41 classified requests, `request_logs`): mean
centroid cosine 0.39–0.54 in every length bucket; mean margin between the
best and runner-up cluster 0.025–0.069; 29 of 41 under 0.05. With
`POTION_CLUSTER_THRESHOLD=0.2` nothing falls back to `general`. The
nearest-centroid decision is close to a coin flip between two clusters for
most real requests.

**Held-out evaluation** (`packages/cluster/src/evaluate.ts`, 200 labelled
prompts, OpenAI `text-embedding-3-small` 384-d, the production embedder):

| threshold | accuracy | note |
|---|---|---|
| 0.2 (production) | **96.0%** | 8 errors in 200; worst cells code-gen→agentic-tool-use (2), rag-answer→extraction/reasoning (2) |
| 0.3 | 92.5% | 9 prompts fall to `general`, 6 of them rag-answer |
| 0.4 | 82.5% | 32 fall to `general` — below the 85% gate |
| 0.5–0.62 | lower | the mock-era default; unusable with the real embedder |

## Reading both honestly

- The threshold of 0.2 is **correct** for this embedder; raising it trades
  real work for `general`. The Pareto point is where it is.
- The held-out set was written alongside the exemplars and sits in the same
  distribution. It proves the centroids separate *prompts that look like the
  taxonomy*; it cannot see how real traffic — shorter, messier, mixed-intent,
  often system-prompt-heavy — lands between them. The production margins are
  the evidence that it lands between them.
- The quality-safe tiebreak (shipped 2026-08-22, `cluster_tiebreak` on the
  row) is the right guard while this is open: when two clusters are within
  0.03 the request is served under the higher measured quality, so the
  ambiguity can cost money but never quality.

## The next instrument, then the fix

1. **A production-derived held-out set.** The learning-period sampler already
   keeps PII-redacted samples per org and cluster (`potion.learning.sample`
   spans, cap 40/cluster). Pool 300–500 of them across orgs (platform-ops
   consent path), label each with a judge model against the ten cluster
   definitions (≈ $1–2 at a mid-tier judge), keep only items two judges agree
   on. This set, not the authored one, is the gate from now on.
2. **Measure margins on it.** The number to move is the share of items with
   margin < 0.05, not accuracy alone — a 96%-accurate classifier with
   coin-flip margins is what production already has.
3. **Then the centroids.** Candidates, cheapest first: more exemplars per
   cluster drawn from the production set itself (the centroid becomes what
   real traffic looks like); per-cluster thresholds; a margin-aware centroid
   objective (push each cluster mean away from its nearest neighbour in
   embedding space); and only if those fail, a small supervised head on the
   embedding. Each is judged on the production-derived set with the tiebreak
   rate as the live confirmation.

## Spend

Evaluation run: 463 embeddings (263 exemplars + 200 held-out) ≈ 25k tokens,
≈ $0.001 on the OpenAI key, KEY_RISK_ACCEPTED=2026-08-23.
