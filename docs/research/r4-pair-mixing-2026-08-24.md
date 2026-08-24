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

## Attempt 2 — pick shapes (same day, $0.80)

| strategy | quality | $/1k | p95 ms |
|---|---|---|---|
| or-grok-4.6 (= the frontier's 1.000 single, identity confirmed) | 1.0000 | $6.76 | 46055 |
| or-gpt-mini | 0.9858 | $0.25 | 5150 |
| **pick(solar \| gemini-flash)** | **0.9856** | $0.98 | 25264 |
| or-solar-pro4 | 0.9804 | $0.02 | 15693 |
| or-gemini-flash | 0.9785 | $0.57 | 2635 |
| pick(gemini-flash \| 3.7-flash) | 0.9671 | $2.84 | 13763 |
| pick(gemini-flash \| sonnet) | 0.9426 | $5.10 | 7127 |
| pick(gemini-flash \| grok-4.6) | REFUSED pre-spend | — | projected 49320 |

**pick(solar|gemini-flash) beat both of its members — the program's first
best-member exceedance.** Rewrite loses, pick wins: direction confirmed.
But it realized only 0.0052 of the pair's 0.0196 oracle headroom and is
dominated by or-gpt-mini alone: **the judge is now the named bottleneck.**
A text judge choosing between two code answers without running them picks
wrong on exactly the hard disagreements.

**The machine this evidence asks for:** an execution-fused pick — the
strategy writes its own tests from the REQUEST (never from the reference),
runs both candidates against them in the sandbox, and picks the survivor;
judge only on ties. That is a new strategy shape plus a serving-side
sandbox — R4's real build, now with a measured justification and a
measured target: 1.000 at ~$1/1k against grok-4.6's $6.76 at 46 s.

## Attempt 3 — exec-pick (same day, $0.65): the machine works

| strategy | quality | $/1k | p95 ms |
|---|---|---|---|
| or-grok-4.6 | 1.0000 | $6.76 | 46055 |
| exec-pick(solar \| gemini-flash, writer 3.7-flash) | 0.9972 | $3.09 | 40041 |
| **exec-pick(solar \| gemini-flash, writer gpt-mini)** | **0.9967** | **$1.71** | **15001** |
| exec-pick(gemini-flash \| gpt-mini, writer 3.7-flash) | 0.9865 | $3.39 | 11589 |
| or-gpt-full | 0.9940 | $1.30 | 2741 |
| judge-pick(same pair) — attempt 2 | 0.9856 | $0.98 | 25264 |
| or-gpt-mini | 0.9858 | $0.25 | 5150 |
| or-solar-pro4 | 0.9804 | $0.02 | 15693 |

**exec-pick realized 83% of the pair's oracle headroom where judge-pick
realized 27% — replacing the judge's opinion with an execution run is
worth 3× of the headroom.** The headline config (writer gpt-mini) is a
NON-DOMINATED point on the measured frontier: above gpt-full on quality
at comparable cost, and 99.67% of grok-4.6's perfect score at a quarter
of its price and a third of its latency. The writer choice matters for
cost/latency, barely for quality (0.9967 vs 0.9972) — the cheap fast
writer wins on the frontier.

This is the strategy doc's test passed: a new point a customer could
buy. Promotion to the production frontier is a NEW-SHAPE promotion and
is deliberately held for the operator's sign-off.

## Promotion checks (same day, $0.39): validated shape, unearned slot

**(a) Stability** (salted fresh run, 30 items): exec-pick 0.9917 vs first
reading 0.9967 — two-run mean 0.9942, spread ±0.005. Its members swung far
wider on the same fresh sample (solar 0.9804 → 0.9409): **the mixture is
more stable than its members**, as it should be — it needs only one member
right per item. It beat every fresh single except grok.

**(b) Generalization** (code-gen-humaneval-js-v1, 12 items): exec-pick
**1.0000**; its members 0.9722 and 0.9167. Third independent instrument,
third best-member exceedance.

**(c) Serving e2e** (throwaway prod org, org-scoped frontier, floor
0.995): live `/v1/chat/completions` executed the ensemble end to end —
trace `strategy=0dcafb99;fallback=0`, correct answer, the sandbox ran on
the serving box. Org cascade-deleted after.

**Verdict: NOT promoted.** The replicated claim — exec-pick beats its own
members, now 5 of 5 comparisons across three instruments — is solid. The
claim that earns a frontier slot — above or-gpt-full (0.9940 @ $1.30 @
2.7s) — is not: two-run mean 0.9942 at $1.71 and 15s is
indistinguishable quality at worse cost and latency. Our own CI gate says
no, so no.

**The config that should clear it:** this pair was mined to cover
*solar's* failures. Mine **gpt-full's** failure set instead and pair
gpt-full with its own coverage partner — exec-pick(gpt-full | partner)
aims at the quality band between 0.9940 and grok's 1.000 at roughly a
third of grok's price, which is a slot nothing occupies.

---

## CORRECTION + attempt 4 (same day, $1.14): the comparison was flattering the mixtures

**A measurement bug in my own leg scripts, found by disbelieving a result.**
Attempt 4's three runs reported nearly identical numbers, which is not how
independent salted runs behave. Cause: the sweep result exposed one
`quality` field per candidate — the CLUSTER-WIDE aggregate over every live
cell at this prices version, accumulating across runs, salts **and suites**.
The leg scripts printed that. A brand-new shape's only cells come from the
current run, so its number was fresh; an incumbent single's number was a
stale pooled average. **Comparing them compared two different samples, and
it flattered the new shape every time.**

Fixed in `packages/workers/src/handlers.ts`: `perCandidate` now carries
`runQuality` (this run's cells, with `runN`) separately from
`aggregateQuality`, with the trap named in a comment; every leg script
compares `runQuality` on both sides.

### What the honest per-run numbers say (30-item hard suite, two salts)

| strategy | run 1 | run 2 | $/1k | p95 |
|---|---|---|---|---|
| **or-gpt-full** | **1.0000** | **1.0000** | $1.40 | 3.3 s |
| or-grok-4.6 | 1.0000 | 1.0000 | $7.32 | 52.5 s |
| exec-pick(gpt-full \| solar \| gemini-flash) | 1.0000 | 0.9926 | $3.42 | 15.2 s |
| exec-pick(gpt-full \| solar) | 0.9886 | 0.9970 | $2.59 | 13.5 s |
| or-gemini-flash | 0.9815 | 0.9750 | $0.60 | 2.9 s |
| or-gpt-mini | 0.9896 | 0.9747 | $0.26 | 5.2 s |
| or-solar-pro4 | 0.8996 | 0.9306 | $0.02 | 15.3 s |

Three conclusions, none of them the one I set out to prove:

1. **The premise died on contact.** The leg was mined from cached evidence
   saying gpt-full fails 3 of 99 items. On fresh measurement it fails
   **none** — 1.0000 twice. There was no headroom to capture, so no mixture
   could capture it, and none did.
2. **The instrument is saturated.** Two models sit at 1.0000 on repeated
   fresh runs; `code-gen-hard-v1` can no longer discriminate at the top.
   Any further capability claim on this cluster needs harder items first —
   an R1 instrument problem wearing an R4 costume.
3. **The product result is a SINGLE, not a mixture.** or-gpt-full now ties
   or-grok-4.6's perfect score at **1/5 the price and 1/16 the latency**. If
   that replicates it *dominates* grok outright, and the top quality point
   on code-gen gets radically cheaper and faster for every customer routed
   to it. That is worth more than the mixture we were hunting.

### Correction to attempt 3's headline

Attempt 3 claimed exec-pick "beat both its members". Re-read like-for-like
from its saved artifact: on that run exec-pick scored 0.9967 while
`or-gemini-flash` alone scored **0.9972** on the same items — a hair
*behind*, not ahead. The members' 0.9785/0.9804 I compared against were
stale aggregates. The promotion-checks leg (which happened to prefer the
per-run field) remains valid: exec-pick 0.9917 vs gemini-flash 0.9856 on
one fresh run, and 1.0000 vs 0.9722/0.9167 on humaneval — so exec-pick
does help against *weak, complementary* members, and does not help against
a strong anchor. **"Beats its members 5 of 5" is withdrawn.**

Holding the promotion at the CI gate was the right call for a better reason
than the one I gave at the time.
