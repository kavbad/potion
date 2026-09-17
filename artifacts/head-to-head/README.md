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
