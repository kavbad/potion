# T1 — the grok-domination leg: the best-member law extends to cost

**2026-08-25 · $3.79 · pre-registered (`tasks/todo.md`) · publish OFF ·
member cells cached from the A3 leg (same salts, like-for-like)**

The hypothesis: on `code-gen-hard-v2`, or-gpt-mini's only failures
({cgh-c02, p08, t08}) are all or-sonnet passes and vice versa, so a
stabilized exec-pick pair should hold the champion's 1.0000 at roughly
half the champion's price. The selector was stabilized first
(`testWriters[]` — majority by execution, mean pass rate across
independent suites; unit-proven that a wrong or broken suite is half the
vote instead of the verdict).

## Pooled results (two salted runs; the target: 1.0000 · < $8.05/1k · < 61 s)

| shape | pooled | spread | $/1k | p95 |
|---|---|---|---|---|
| **or-grok-4.6** (target) | **1.0000** | 0.0000 | $8.05 | 61.5 s |
| A `xp2(mini\|sonnet, w:solar+flash)` | 0.9938 | 0.0045 | **$8.98** | 26.3 s |
| C `xp2(mini\|flash\|sonnet)` | 0.9903 | 0.0028 | $10.27 | 36.3 s |
| B `xp1(mini\|sonnet, w:flash)` | 0.9890 | 0.0050 | $8.68 | 10.7 s |
| or-gpt-mini alone | 0.9884 | 0.0127 | **$0.34** | 7.3 s |

## Verdict: negative, on both registered axes

1. **Quality: the paper oracle is not a live oracle.** The coverage map
   was built from pooled per-item means; per-run, each member's failure
   set flickers (mini 0.9947 → 0.9820 across salts), so on any given run
   there are items where *neither* member is perfect — shape A's misses
   were all fractional (0.92–0.96), not wrong picks. Complementarity
   measured on averages overstates what any single run can assemble.
2. **Cost: coverage required sonnet, and sonnet priced the mixture out.**
   The only measured model covering mini's failures is or-sonnet
   ($4.40/1k). Members + writers + tie-judge landed the pair at
   $8.68–8.98/1k — *above* grok's $8.05. There is no cheap pair: the
   best-member law now has a cost corollary — **a mixture must pay for
   every member on every request, and the champion's price is a budget
   the member-sum must beat, not a number to divide by two.**
3. **The stabilization itself worked as designed.** Dual-writer A never
   made a hard mispick (worst item 0.92); single-writer B picked a 0.82
   sonnet answer on cgh-f02 and an 0.85 on cgh-t04 — the wrong-suite-
   as-verdict failure the majority vote exists to prevent. A > B pooled
   (0.9938 vs 0.9890), consistent though not CI-separable at n=84.
   `testWriters` stays: it is the right default for any future exec-pick.
4. **The economically honest reading:** or-gpt-mini already sits 0.0116
   below the champion at 1/23rd the cost and 1/8th the latency. Closing
   that last 1.2 % with mixtures costs 25× more than living with it.
   Routing's job — price the gap, per the A3 doctrine — was the answer
   all along; the customer who wants 1.0000 buys grok, and everyone else
   is dramatically better served by mini.

## Program status after four adjudicated legs

Capability mixing has now lost on code-gen (twice), rewrite-edit, and —
on the cost axis — at the champion ceiling. Every loss is to a mixture's
own best member. The composition bet's surviving forms are: (a) the
serving product's existing cost-routing (which IS mixing, per request,
and wins daily), (b) verifier-pick on extraction (deterministic
adjudication, genuinely cheap members — still open), and (c) judge-free
venues we have not priced yet. The next leg is (b); a fifth best-member
confirmation there would close the capability-mixing question for this
model generation.
