# A3 — instrument hardening: the suite can rank everyone except the champion

**2026-08-25 · validation leg ~$2.8 + calibration $0.19 · pre-registered
2026-08-24 (`tasks/todo.md`) · publish OFF throughout**

Two instruments had saturated — code-gen-hard-v1 and classification-hard-v1
champions pinned at 1.000 across salted runs, so a crown said nothing.
`code-gen-hard-v2` keeps v1's 30 items and adds a 12-item frontier tier of
exact-specification contracts (bankers' rounding on decimal strings, semver
precedence, code-point reversal, RFC 6901 escape order, deterministic topo
order, LFU-with-LRU-tie-break, greedy wrap with hard splits, half-open
interval subtraction, bijective base-26, sliding-window coalescing, BigInt
decimal addition, RFC 4180 parsing); every reference passed the self-pass
gate on the first run. `classification-hard-v2` keeps v1's 30 and adds two
rule-chain families (distinct-defect counting where tone misleads;
escalation routing with an exception that inverts and a sender-domain
exception to the exception); the constant-guesser floor stays ≤ 0.45.

## Pooled results (two salted runs, like-for-like runQuality)

| model | code-gen (n=42×2) | classification (n=40×2) |
|---|---|---|
| **or-grok-4.6** | **1.0000 ± 0.0000** | **1.0000 ± 0.0000** |
| or-gpt-mini | 0.9884 | 0.9375 |
| or-gpt-full | 0.9777 | 0.9875 |
| or-gemini-flash | 0.9515 | 0.9875 |
| or-sonnet | 0.8675 | 0.8750 ± 0.0000 |

## What the leg established

1. **The instruments discriminate again — everywhere below the champion.**
   Before: five models crowded 0.97–1.00, unrankable. Now code-gen ranks
   them across a 0.13 range; 17 of 42 items split the field, 8 of the 12
   new frontier-tier items among them, and **zero items are failed by
   everyone** — no authoring defects. On classification, 7 of 40 items
   split, six of them from the two new families: the additions do exactly
   the discriminating.
2. **The published negative: or-grok-4.6 aced all 164 scored cells** —
   both suites, both salted runs, including every frontier-tier item. The
   champion's crown remains a ≥-bound, not a discriminated score. Further
   hardening chases esoterica and stops representing the cluster, so the
   doctrine is stated instead: **at a champion's ceiling, the frontier's
   job is to price the gap** — and it now can: grok's nearest rival on
   code-gen sits 0.0116 below at 1/23rd the cost ($0.34/1k vs $8.05/1k)
   and 1/8th the p95 (7.3 s vs 61 s). Routing decisions live in exactly
   that trade.
3. **The G8 classification gap is closed — with a negative.** Calibration
   was unanswerable on hard-v1 (every answerer aced it; truth constant).
   On hard-v2, or-sonnet supplies varied truth (0.8750, spread 0.0000),
   and the judges fail the bar in the reference-free configuration:
   or-judge r = 0.753 CI95 [0.000, 1.000] (indeterminate at n=40),
   gemini-flash 0.601 [0.000, 1.000], **gpt-mini 0.217 [-0.109, 0.667] —
   flagged**. Judge agreement or-judge↔gpt-mini is 0.345. Rule-application
   work joins omission-class extraction defects on the list of things a
   bare serve-time judge cannot see: **judging a rule chain requires
   applying the rule chain.** Any judge-pick shape on classification
   inherits this ceiling. (Measurement is unaffected — these suites score
   exact; the finding constrains serve-time confidence checks and fusion
   judges.)
4. **Extraction judge repower: the anchored perfect reading replicates.**
   Second independent run, deliberately weak answerer (or-inkling-small,
   n=24, $0.17): **or-judge r = 1.000 CI95 [1.000, 1.000], mAE 0.000** —
   the production judge's perfect anchored-extraction calibration is now
   confirmed on two independent answer distributions; gemini-flash the
   same. gpt-mini reproduced its first point estimate exactly (0.798
   twice) but the CI still spans the bar at n=24 — the suite's 24 items
   are the cap, so extraction joins the item-authoring backlog, and
   gpt-mini simply is not used as an anchored-extraction judge meanwhile.
5. **Found and fixed on the way: the frontier-regression guard fired on
   `publish:false` runs.** The guard exists so publishing cannot silently
   drop a routed point whose evidence was lost; but it ran before the
   publish branch, so measurement-only runs died after their spend. It
   killed this leg's second run (two provider timeouts on carried-forward
   incumbents) and, the same morning, the prod Observatory's
   agentic-tool-use canary (W35: "1 inconclusive"). The guard now runs
   only where a save would make the loss real. Shipped same day.

## Standing consequences

- Cluster evidence for code-gen and classification re-measures from zero
  cache on the new instruments (stated consequence, as with the
  2026-08-20 adoption). Serving frontiers are untouched until a sweep
  publishes on the new instruments.
- The weekly Observatory now carries a $0 saturation alarm
  (`saturationVerdict`): top ≥ 0.99, or a crowded top at 0.97, prints
  INSTRUMENT SATURATED — hardening due in the digest. The next ceiling
  gets caught on schedule, not on suspicion.
- The champion-ceiling doctrine above (price the gap) supersedes chasing
  0.99+ discrimination at the top of a cluster.
