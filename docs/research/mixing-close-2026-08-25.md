# The capability-mixing question, closed

**2026-08-25 · five pre-registered legs, ≈ $13 total · operator direction:
no further mixture legs · reopened only by the saturation alarm**

Scope, stated the way the operator required: **settled for measured task
shapes at the current model market; reopened by the saturation alarm** —
the standing Monday check that tells us when the model ecosystem's shape
changes enough to make any of this worth re-asking.

## The question

Can a mixture of models beat the best single model on the same work by
enough to matter — on quality, or on cost at equal quality?

## The five adjudications

| leg | venue | best mixture vs best single | verdict |
|---|---|---|---|
| judge-pick pairs (R4) | code-gen | 27% of oracle headroom realized | judges mispick |
| exec-pick (R4) | code-gen | held at CI gate vs champion | not separable |
| rewrite-edit pick | rewrite-edit | beat target, lost to own member fresh | best-member law |
| grok-domination pair | code-gen-hard-v2 | 0.9938 vs 1.0000, at $8.98 vs $8.05 | lost both axes |
| cascades (4 gates) | code-gen-hard-v2 | all below plain mini 0.9884 | gates can't see errors |
| verify-pick | extraction | +0.0052 (= its spread) at 6.2× cost | margin inside noise |

## The two mechanisms, measured

1. **Selectors fail where it matters.** Text judges realize 27% of oracle
   headroom and fail calibration outright on rule-application work
   (r = 0.22–0.75, none CI-clear). Execution- and structure-based
   selectors fix the wrong-pick problem (majority-by-execution made zero
   hard mispicks) but cannot manufacture a margin the members do not
   have. Confidence gates fail on both axes at once: a model's errors
   are *confident* errors (logprob@0.9 sailed past five error classes),
   and every false escalation to a lower-overall model trades a right
   answer for a likely-wrong one.
2. **The economics close from both ends.** A run-all mixture pays for
   every member on every request, plus a referee whose bill grows
   exactly when members are strong (ties). At the expensive end the
   member-sum exceeds the champion it targets ($8.98 vs $8.05). At the
   cheap end the *relative* overhead explodes — extraction members cost
   $0.02–0.37/1k, so a second member is a 6–100× multiplier against
   margins of half a point. Cascades escape neither, because their gates
   lack the precision and recall to fire only where escalation helps.

## Why the margin itself vanished

A3 measured it: after hardening, the champions sit at most **~0.012
above the best cheap single** per cluster. The winnable quality margin
for ANY within-request composition is bounded by that number. Proving a
win that small costs more than the win is worth — and serving it costs
more than routing around it.

## What survives, and won

- **Cost-routing across requests** — each request to the cheapest
  measured model at the bar for its kind of work. This IS composition,
  it wins every day in production, and every negative above sharpens its
  receipts: the gap to the champion is now a measured price, not a fear.
- **The selector machinery**, repurposed: majority-by-execution and the
  deterministic omission check stay in the toolbox as *serve-time
  confidence instruments*, where their job is flagging, not choosing.
- **The instrument discipline** that produced five honest negatives for
  about thirteen dollars: pre-registration, like-for-like runQuality,
  fresh baselines, caps and belts that refused twice and were right.

## Standing state

No further mixture legs (operator direction, 2026-08-25). The
composition-beats-monolith bet's remaining live form is journey-grain:
whether per-step routing holds end-to-end outcome quality at a fraction
of monolith cost — adjudicated first on our synthetic journey corpus,
then for real on partner traffic. The saturation alarm owns the reopening
condition: if a future market puts champions back below their own
ceilings with real spread, the question earns a new campaign.
