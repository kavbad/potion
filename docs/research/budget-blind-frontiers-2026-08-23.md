# Budget-blind frontiers (2026-08-23)

## What was found

On the `extraction` cluster the measured pick is `or-inkling-small`
(`thinkingmachines/inkling-small`, a reasoning model). Under a customer-sized
`max_tokens` — 120, 300, 800 — it spends the entire budget on reasoning and
returns **no content**, with or without JSON mode; `completion_tokens`
equals `max_tokens` exactly every time. The same request with a tool
attached returned a correct tool call within 200 tokens, so the model is
fine — the budget is what it cannot live inside.

Two product defects rode on top of it:

1. Potion reported `finish_reason: "stop"` (hardcoded) — a customer could not
   tell the answer was truncated, let alone empty.
2. The frontier had measured the point under the harness's generous output
   budget, so the point looks excellent on the frontier and fails the first
   customer who sends `max_tokens: 300` — which is most of them.

## What shipped

- The provider's finish reason passes through; `length` is honest.
- An empty, budget-exhausted answer on a single point is served once more on
  the next single point the policy admits, with the served point excluded.
  `x-frontier-trace` carries `retry=empty_answer`; `x-potion-model` names the
  point that answered. Nothing else about the request changes; the
  customer's budget is the contract.

## What it means for measurement

A frontier point is a claim about quality *under the conditions the customer
will use it in*. Output budget is one of those conditions and the harness
does not vary it. Two follow-ups, in order:

1. **Measure under customer budgets.** Add `max_tokens` ∈ {256, 1024, harness
   default} as an evaluation dimension for reasoning-capable models; a point
   that returns empty answers at 256 is not on the frontier for traffic that
   sends 256. The Observatory's canaries are the cheap place to start:
   one extra canary item per reasoning model at `max_tokens: 256`.
2. **Carry a `reasoning` flag on the roster** (OpenRouter reports
   `reasoning_tokens` in usage; the registry can learn it from the first
   response) so the serving path can route a small-budget request away from
   a reasoning model before it fails, instead of after.

## Live retry rate

`retry=empty_answer` on the trace and the warn log make the rate visible;
the learning period's samples will show which clusters it concentrates in.
