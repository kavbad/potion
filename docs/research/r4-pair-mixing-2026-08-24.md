# R4 attempt 1 — pair mixing on code-gen (2026-08-24)

**Question.** The $0 headroom query showed or-solar-pro4 (0.9841 over 90
items) fails exactly 4 items, all passed by or-gemini-flash → the pair's
oracle ceiling is 1.000. Can a servable pair shape realize it?

**Setup.** Full code-gen-hard-v1 platform suite, execution-scored (G8 does
not bind). Canary (publish off). Four shapes; singles resumed from paid
cells. Spend $0.50 of the $8 cap.

## Results

| strategy | quality | $/1k | p95 ms |
|---|---|---|---|
| incumbent single (frontier top) | 1.0000 | $6.76 | 46055 |
| or-gpt-full | 0.9940 | $1.30 | 2741 |
| dv(solar → gpt-full) | 0.9896 | $2.05 | 21744 |
| or-solar-pro4 (champion-for-value) | 0.9804 | $0.02 | 15693 |
| or-gemini-flash | 0.9785 | $0.57 | 2635 |
| dv(solar → gemini-flash) | **0.9502** | $0.96 | 29526 |
| dv(gemini-flash → solar) | **0.9413** | $0.76 | 35530 |
| ensemble(solar+gemini, judge-pick) | REFUSED pre-spend | — | projected 20204 > 20000 cap |

## Findings

1. **Draft–verify with cheap members LOST to both of its members, twice.**
   The verify wire says "correct it", and a cheap verifier meddles: it
   breaks correct drafts more often than it fixes the 4 wrong ones. The
   oracle ceiling is real; a REWRITE shape does not realize it. The shape
   this evidence points at is a PICK — choose between two finished
   candidates without editing either — which was exactly the candidate the
   latency gate refused (by 204 ms, because solar's own p95 is 15.7 s).
2. **Strong-verifier dv landed between its members** (0.9896: above solar,
   below gpt-full) at 1.6× gpt-full's price — dominated by gpt-full alone.
   Consistent with the cascade law extended: a rewrite shape struggles to
   beat its own best member.
3. **The containment flake is dead — root-caused during this leg.**
   FNV-derived base seeds ≥ 2^31 are rejected by Google-backed OpenRouter
   endpoints as the generic 'Provider returned error'; the seed is a pure
   function of the prompt, so the same items failed deterministically.
   Multi-stage shapes always derive seeds; singles send none — hence
   "flaky cascades, healthy singles". Fixed by masking derived seeds to 31
   bits (packages/strategies/src/helpers.ts). This retroactively explains
   the filed gemini-flash-in-cascade flake and the tranche-era cascade
   containments.

## Next credible attempts (filed, not run)

- **Pick, not rewrite**: ensemble(judge-pick) with a fast judge and members
  whose max p95 clears the latency cap — or agreement-gated escalation
  (agree → cheap answer stands; disagree → strong closer), once program-
  shape JSON memoization is verified.
- **The real prize stays cost-down**: the frontier's 1.000 point costs
  $6.76/1k at 46 s p95. A pair reaching 1.000 at ~$1/1k would dominate it
  outright. The 4 failure items are known; nothing about them requires a
  46 s model.
