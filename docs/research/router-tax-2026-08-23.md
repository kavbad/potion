# The router's tax, measured (item C — 2026-08-23)

## Numbers

| leg | p50 | how measured |
|---|---|---|
| Potion pipeline (auth, policy, frontier, budgets, tiebreak, logging, hop) | **32 ms** | hinted Potion vs direct OpenRouter, same model, same box, n=6 |
| Classification (embed + assign, cache miss) | **102–208 ms** (p50 ≈ 127) | measured inside the request, `x-potion-timing: classify=<ms>`, live |
| Classification (cache hit or `x-potion-cluster` hint) | ~0 | the header is absent |
| Raw OpenAI embed from the box | 187 ms cold / ~50 ms warm | isolated probe |

**Potion's whole toll over a direct call: ~160 ms on an unseen prompt,
~30 ms on a repeat or a hinted request.**

## The confound worth remembering

An outside probe first put the "classifier tax" at 1.7 s. It was wrong: the
unhinted arm's fresh prompts classified into a cluster whose max-quality pick
is a slow model, so the probe measured the *routed model's* first token, not
the classifier. Stage cost is now measured inside the request, where it
cannot be confounded, and exposed in its own header (`x-potion-timing`) —
the trace string stays a pinned contract.

## What this means

- The 1.8–2.4 s first token users see is dominated by the chosen model's own
  warm-up. The lever is **latency-aware routing** (`latency_bound` /
  `compound` policies, latencyP95 already on every point), not router
  optimization.
- Remaining micro-cuts, none urgent: keep the embed connection warm (saves
  ~150 ms on the cold-start case), and the assignment cache already covers
  repeats.
- Every future latency claim can cite the header, not a probe.
