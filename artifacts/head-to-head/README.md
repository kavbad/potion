# Head-to-head: Potion vs openrouter/auto vs a fixed incumbent

`scripts/head-to-head.mjs` — three arms per item, same items, same scorer
(the harness scorers with the platform's live judge). Runs inside the server
container; see the script header. Results are dated files beside this README.

## 2026-09-17 — before the fallback and tiebreak fixes

182 items, 10 kinds of work, max_tokens 1600, judge = the platform's judge
class (claude-sonnet-4.5 — also the incumbent arm; the frontiers were
measured with the same judge). $1.49 per run.

| floor | Potion q | auto q | incumbent q | Potion ÷ auto (cost) | Potion ÷ incumbent | Potion fallback |
|---|---|---|---|---|---|---|
| 0.95 (signup default) | 0.899 | 0.924 | 0.837 | 1.33x [0.73–2.20] | 0.15x | 52.7% |
| 0.84 (operator's bar) | 0.924 | 0.910 | 0.839 | 2.04x [1.52–2.64] | 0.21x | 4.4% |

What decided the numbers (full attribution in the dated .md/.json files):

- **One item = 30% of Potion's bill at 0.95.** `agentic-tool-use-008` was
  classified summarization (confidence 0.406, margin 0.047 to rewrite-edit —
  outside the 0.03 tiebreak window) and served at $0.024. Without it: 0.95x
  [0.68–1.29]. Same shape as 2026-09-07, when two items set the headline.
- **The unreachable-floor fallback set Potion's quality at 0.95.** 96/182
  items hit `policy_infeasible`; the rule served "the cheapest point the
  evidence cannot rank below the best", which with 15–40 items of evidence
  admits nearly everything — extraction went to granite-micro 20/20 (0.869
  vs auto 0.988), creative to deepseek 13/14. Fixed after this run: cheapest
  point that MEASURED ≥ the floor, else cheapest whose mean reaches the best's
  lower bound, else the best.
- **At 0.84 the cost gap is coverage, not rules.** creative 3.79x, rewrite-edit
  6.75x, code-review 3.39x: min_cost's cheapest qualifying points there are
  Sonnet or a cascade, while the auto-router served gpt-5.6-luna (83 of 182
  picks) and deepseek-v4-flash-0731 (71) at ~0.9 quality. Neither is measured
  on those frontiers. The remedy is an audition sweep of the auto-router's
  picks, not a routing rule.
- Where Potion is already ahead at either floor: classification (parity
  quality, 0.4–0.6x cost), multi-step-reasoning (1.000 at 0.1–0.2x; the
  incumbent scored 0.25 — format obedience, see memory), code-gen 0.2–0.3x,
  extraction 0.1–0.5x, summarization 0.19x at 0.84.

## 2026-09-17 — after #39 (fallback clauses a+b, cost-aware tiebreak, 0.05 window)

Same 182 items, same judge. Files `2026-09-17-after-fixes-floor-*.{md,json}`.

| floor | Potion q | auto q | Potion ÷ auto (cost) | Potion cost before → after | fallback |
|---|---|---|---|---|---|
| 0.95 | 0.916 (was 0.899) | 0.924 | **8.95x** [5.38–13.24] (was 1.33x) | $0.081 → **$0.481** | 48.9% |
| 0.84 | 0.916 (was 0.924) | 0.917 | **1.72x** [1.24–2.30] (was 2.04x) | $0.108 → $0.095 | 3.3% |

- **0.84 is the tiebreak working:** 20 items flipped to the cheaper of two
  floor-clearing points; rewrite-edit $0.037 → $0.027; quality −0.008 overall
  (agentic +0.07, code-review −0.03).
- **0.95 is clause (a) failing:** "the cheapest point that MEASURED at the
  bar" put rewrite-edit on claude-opus-5-fast (measured 0.950, $29.93/1K) for
  13 of 20 items — $0.032 → $0.360 on that cluster alone. An unprovable bar
  honoured literally buys the priciest point for a difference the evidence
  cannot show. Clause (b) alone — the cheapest point whose MEAN reaches the
  best's lower bound — carried the quality gains (extraction 0.869 → 0.931
  via deepseek instead of granite; rag-answer 0.800 → 0.900). Clause (a) is
  removed in the follow-up; the rerun after that is the honest "after".
- Auditions so far (unpublished): summarization — glm-5.3-flash 0.986 at
  $0.24/1K vs today's top kimi-k3 0.983 at $10.26/1K; gpt-5.6-luna 0.964 at
  $0.19. Agentic — luna 0.950 (already on the frontier); deepseek-v4-flash
  0.49 and glm 0.46 are not agentic models. Creative — none of the four
  beats what serves (best of them 0.73 vs Sonnet 0.85).

## 2026-09-17 — after #41 (clause (a) removed; clause (b) + tiebreak + 0.05 window)

Files `2026-09-17-after-41-floor-*.{md,json}`. Same 182 items and judge.

| floor | Potion q | auto q | Potion ÷ auto | Potion cost (morning → #39 → #41) | fallback |
|---|---|---|---|---|---|
| 0.95 | 0.893 | 0.900 | **6.79x** [3.82–10.48] | $0.081 → $0.481 → $0.477 | 48.9% |
| 0.84 | 0.926 | 0.915 | **1.35x** [0.98–1.77] | $0.108 → $0.095 → $0.091 | 3.3% |

- **0.84 is settled:** 2.04x → 1.35x at quality 0.926 vs the auto-router's
  0.915, interval touching parity. That is the cost-aware tiebreak and the
  0.05 window. Potion ÷ Sonnet 0.18x at +0.08 quality.
- **0.95 exposes clause (b):** rewrite-edit still $0.372. On the live
  frontier opus-fast is 0.950 ±0.022 (lower 0.928) and Sonnet 0.906 ±0.044
  (upper 0.950): the September-11 upper-bound tie admits Sonnet (0.950 ≥
  0.928); the mean-vs-lower-bound tie does not (0.906 < 0.928), so opus
  serves. And on extraction granite-micro's mean (0.904) reaches the best's
  lower bound (0.893) anyway, so (b) bought no quality there. Both
  tightenings lose to the original rule; #42 restores it and keeps the
  tiebreak. The morning's 0.95 result (1.33x, quality 0.899) is the best
  the rules can do on today's frontiers.
- **What actually fixes 0.95 is coverage, not a rule.** The audition
  re-measured rewrite-edit on 28 items: opus-fast 0.906, solar-pro4 0.906
  at $0.04/1K, gpt-5.6-luna 0.911 at $0.25. Published, opus is no longer
  "best", the tie resolves to solar-pro4 under any rule, and the 0.95
  headline collapses with it. Likewise summarization (glm-5.3-flash 0.986
  at $0.24 vs kimi-k3 0.983 at $10.26) and code-review (gpt-mini 0.950 at
  $0.13 vs gpt-full 0.960 at $0.60). Publishing is the operator's call.

## 2026-09-17 — after #42 (original tie rule restored; tiebreak + 0.05 window kept)

Files `2026-09-17-after-42-floor-0.95.{md,json}` plus
`2026-09-17-after-42-floor-0.95.answers.json` — the answer text of all 546
answers (`H2H_SAVE_ANSWERS`), so a second judge can be run over exactly these
answers without re-spending on models.

| floor | Potion q | auto q | incumbent q | Potion ÷ auto | Potion cost | fallback |
|---|---|---|---|---|---|---|
| 0.95 | 0.892 | 0.915 | 0.850 | **1.20x** [0.67–2.05] | $0.083 (morning $0.081) | 48.9% |

The restore holds: the two rewritten tie rules (8.95x, 6.79x) are gone and
the cost-aware tiebreak keeps its gain. The 0.84 result from the #41 run
(1.35x) is unchanged by #42 (the tie rule only fires when the floor is
unreachable; 3.3% of items at 0.84).

### The `exact` scorer zeroed 20 correct answers in this run

Running Jev as a second judge over the saved answers (see
`artifacts/jev-trial/`) exposed it: `scoreExact` in
`packages/harness/src/scorers.ts` compares the whole answer, case- and
whitespace-folded, against the reference. So `18 days.` ≠ `18 days`
(rag-answer-001), and a reasoning answer that shows its work and ends with
`24` scores 0 against `24`. Jev marked 25 of the 30 zero-scored `exact`
rows it disagreed on as correct.

Re-scored with the fixed scorer (PR #44: trailing punctuation and emphasis
dropped, then the final non-empty line must EQUAL the reference — never
contains):

| arm | stored quality | re-scored | rows flipped 0→1 |
|---|---|---|---|
| Potion | 0.892 | 0.897 | 1 (rag-answer) |
| auto | 0.915 | 0.932 | 3 (2 rag-answer, 1 reasoning) |
| incumbent | 0.850 | 0.938 | 16 (15 reasoning, 1 rag-answer) |

No wrong flips: the three genuinely wrong answers stay 0. Ten rag-answer
rows also stay 0 because the answer adds words (`$4.50 per day`, `Up to 2
hours.`, `42 minutes per charge.`) — correct answers the `exact` instrument
cannot see. rag-answer wants field-contains or a judge; that is a separate
change. Two consequences:

- Every "Potion beats Sonnet on reasoning" number in this README is format
  obedience, not reasoning: the model Potion serves answers with the bare
  number, Sonnet shows its work first. The suite prompt does ask for "just
  the final number", but the platform routes on correctness.
- The platform measures the `multi-step-reasoning` and `rag-answer`
  frontiers with the same v1 suites and the same scorer
  (`PLATFORM_SUITE_BY_CLUSTER`), so those two frontiers rank models partly
  by format obedience. #44 keys `exact` cells as `exact@2` so the old zeros
  cannot re-certify; merging it re-executes every exact cell once and may
  re-rank those two frontiers.

At the corrected numbers the 0.95 story is: Potion 0.897 vs the auto-router
0.932 at 1.20x its cost, vs Sonnet 0.938 at 0.16x. The quality gap to the
auto-router is coverage (unpublished auditions), not the tie rule.

## 2026-09-18 — the sized run (every text item, 3 repeats, two arms)

Files `2026-09-18-sized-{084,095}.{md,json,answers.json}`. 658 unique items
(every text suite per cluster, de-duplicated by id; the new
`creative-hard-v1` and `summarization-hard-v1` included), 3 repeats each,
paired on the per-item mean, Potion vs `openrouter/auto` only. $6.5 per
floor. Per-cluster n: code-gen 114, extraction 128, classification 90,
agentic 50, creative 50, summarization 50, reasoning 50, rag-answer 50,
rewrite-edit 34, code-review 42.

| floor | Potion q | auto q | Potion − auto q (95% CI) | Potion ÷ auto cost | Potion p50 / p95 | auto p50 / p95 | fallback |
|---|---|---|---|---|---|---|---|
| 0.84 | 0.937 | 0.920 | +0.017 [−0.002, +0.034] | 1.15x [0.97–1.35] | 2.1s / 9.8s | 1.1s / 3.5s | 0.9% |
| 0.95 | 0.900 | 0.923 | −0.023 [−0.042, −0.005] | 1.61x [1.16–2.09] | 2.9s / 16.0s | 2.1s / 3.4s | 44.4% |

**0.84 (the bar the product recommends after measurement):** quality at
parity or better, cost at parity, latency 2x. Potion wins outright on
agentic (+0.19, 0.35x), rag-answer (+0.08, 0.20x), and is 4–10x cheaper at
equal quality on classification, reasoning, extraction, summarization.
It loses on cost where it serves Sonnet: creative 3.74x (49% of Potion's
bill), code-review 3.67x, rewrite-edit 2.94x — the three clusters whose
cheaper audition frontiers are unpublished. It loses on quality on
code-gen (−0.06): 90 of 114 code-gen items were routed off-label (51 to
reasoning, 39 to classification), whose cheap point ling-3.0-flash returns
an EMPTY answer on code prompts; the retry lands on nemotron/deepseek at
12.6s median and quality 0.49. All 68 retries in the run were
`empty_answer`, 39 of them code-gen. That is a classifier defect on the
hard code-gen prompts (they read as word problems to the centroid), not a
frontier defect — the 24 code-gen items sent to extraction scored 0.98.

**0.95 (the signup default):** 44% of units hit `policy_infeasible` and
the unreachable-floor rule served summarization on kimi-k3 and friends at
$0.203 for 50 items — 59% of Potion's bill, 9.07x the auto-router, quality
0.72 vs 0.80, p95 78s. Rewrite-edit 5.06x. Everywhere else Potion is
cheaper (code-review 0.14x, extraction 0.28x, code-gen 0.48x) at a 0–4
point quality deficit. 0.95 is not a floor any frontier can honour on
these suites, and what the rule does when it cannot is the whole 0.95
story. The signup default is the decision.

**Latency:** model choice explains most of the 2x (solar-pro4 2.0s and
Sonnet 5.5s median vs luna 0.5s and deepseek-flash 1.3s); empty-answer
retries set the p95 (code-gen 17s, agentic 14s); Potion's own overhead is
small (ling-3.0-flash 1.6s median both server-side and end-to-end).
`underpowered=N` appears on 80% of units — informational (points excluded
by interval width), but at that frequency it reads as a warning.

**Not comparable to the 2026-09-17 runs:** different item set (658 vs
182), three repeats, and the two new hard suites, whose fidelity/constraint
items score lower for every arm (summarization auto 0.79 vs 0.96 on the
flat 14).

The wrong-policy launch earlier the same night (`h2h-floor-0.084`, every
Potion call rejected, $3.10) is discarded; the harness now aborts when
Potion answers none of the first five units.

## 2026-09-18 — after levers 5, 4, 3 (#46: runner-up-cluster retry, code-gen exemplars, signup floor 0.82)

File `2026-09-18-after-5-4-3-084.*`. Same 658 items × 3 repeats, 0.84 floor,
run on the deployed build (c251e54).

| | before (#45 build) | after (#46 build) |
|---|---|---|
| quality, Potion − auto | +0.017 [−0.002, +0.034] | **+0.035 [+0.019, +0.052]** |
| Potion quality / auto quality | 0.937 / 0.920 | 0.948 / 0.912 |
| code-gen: Potion q, Potion ÷ auto $ | 0.899, 0.22x | **0.966, 0.14x** |
| empty-answer retries | 68 | 46 (27 on the runner-up cluster) |
| Potion cost | $0.284 | $0.303 |
| auto cost | $0.246 | $0.199 |
| cost ratio | 1.15x [0.97–1.35] | 1.52x [1.27–1.79] |
| latency p50 / p95 | 2.1s / 9.8s | 2.4s / 9.6s |

- **Code-gen is fixed.** Classified correctly it scores 0.966 against the
  auto-router's 0.945 at a seventh of the cost; retries fell 68 → 46 and
  the ones that remain no longer land on 16–39s reasoning models.
- **Quality is now a significant win** (+0.035, interval clear of zero),
  with rag-answer +0.12 and agentic +0.18.
- **The cost ratio got WORSE, for two reasons that are not the same.**
  (1) The auto arm's bill fell 19% between two runs with the same model
  mix (deepseek-flash / luna / glm at the same counts): extraction
  $0.030→$0.018, classification $0.010→$0.005. Both arms are metered on
  OpenRouter's billed `usage.cost`, so this is provider-side variance
  (per-call provider routing and prompt caching on repeated prompts).
  **Run-to-run noise on the auto arm's cost is ~20%; cost ratios inside
  that band are not evidence.** (2) Potion's own bill rose 7%: 11 of the 27
  runner-up retries went to Sonnet through rewrite-edit (summarization,
  creative and agentic prompts with a close rewrite-edit runner-up), $0.067
  for 11 answers. The fix (#47) caps a runner-up point at 10x the prompt's
  own cluster's second point.
- Signup floor: boot logged 0.82 (limited by agentic-tool-use at 0.823) and
  lowered three orgs' unchosen 0.95 rows; this run used the named 0.84
  policy so it does not show here.
