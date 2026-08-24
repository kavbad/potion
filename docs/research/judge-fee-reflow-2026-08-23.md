# The judge's fee was on the customer's cost axis (item B — 2026-08-23)

## Found

The nightly price-drift watcher's first run flagged three movers; the reflow
dry-run then showed judge-scored clusters (creative, summarization,
rewrite-edit) with stored costs **20–60× above tokens-at-any-price**, while
deterministic-scored clusters reconciled with plain drift. Cell-level
evidence convicted the measurement: per-item cost varied with the judge's
output, not the model's. `runner.ts` folded the llm-judge's tokens and cost
into each cell's `usage` for budget accounting, and the frontier's
`costPer1K` aggregated that same field. Budget truth and serving truth
shared one number; every judge-scored frontier carried the judge's fee.

## Fixed

1. **The split** (migration 0048): a cell's `usage` is the answer call only —
   the serving truth receipts and frontiers cite; the scorer's spend rides
   `scorer_usage`; the run's `spendUsd`/`executedSpendUsd` sum both, so the
   budget belt still counts every dollar. Legacy cells cannot be unsplit.
2. **The reflow**: all ten platform default frontiers rebuilt from their own
   cells — quality from scores, cost from tokens × the live catalog —
   promoted to production (v4/v5/v9 by cluster). Real new entrants appeared
   once the fee came off the axis (`or-ling-3.0-flash`, `or-solar-pro4` on
   several frontiers). Verified live: smoke 6/6 on the new versions.
3. **Source prices**: the three deepseek movers corrected in `prices.json`
   and both registries (version label kept — cell joins depend on it; the
   ledger records the in-place correction).

## The honest casualty

`rewrite-edit`'s serving cascade earned its frontier place under the broken
cost axis; its per-stage cost cannot be recovered from cells (tokens span
stages with different prices). It lost its spot until re-measured — queued
as a targeted leg. A point that cannot state its cost does not hold one.

## What to watch

- Receipts on judge-scored clusters now show costs an order of magnitude
  lower — that is the correction, not a regression.
- The weekly canaries compare against stored quality (unchanged); the drift
  verdicts are unaffected.
- The nightly watcher now guards the corrected axis.
