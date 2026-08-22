# The Observatory — continuous measurement as the product's metabolism

**Written 2026-08-20 (operator directive: continuous testing at a manageable
rate; a standing target to grow the model base; SLMs and specialists in
scope; everything aimed at the mixing breakthroughs).** Successor to
episodic campaigns: campaigns become what the Observatory does on a big day,
not the only way evidence gets made.

## The thesis that makes this pioneering

Every benchmark on earth asks "which model is best?" That question produces a
leaderboard, and leaderboards are commodities. The Observatory asks the
portfolio question: **which SET of models, held together, covers the most
work at the least cost — and which candidate would improve the set?**

That reframe changes what we measure FOR:

- A model's value is not its rank. It is `max(frontier value, mixing value)`
  — and mixing value is a COVARIANCE property: a mediocre model whose
  failures are uncorrelated with the incumbents' is an asset, because an
  oracle over decorrelated failures beats every member. Markowitz knew this
  about stocks; nobody prices models this way.
- Specialists and SLMs stop being niche. Per-cluster routing monetizes
  narrowness: a model only has to win ONE kind of work to earn a frontier
  slot (solar-pro4 was exactly this pattern — cheap, unglamorous, dominant).
  And specialists are maximal-decorrelation candidates for mixing.
- The per-item eval cache is the crown jewel. Every measured cell records
  WHICH items a model failed — so failure-vector correlation between any two
  models is a $0 JOIN, and the oracle-fusion ceiling of any pair is
  computable before a dollar of ensemble measurement is spent.

## The four mechanisms

### 1. Freshness: drift sentinels, not re-runs
Full re-measurement on a calendar is unaffordable and mostly wasted — models
rarely change. Instead every frontier model gets a weekly **canary**: 3–5
fixed items per cluster it serves, ~$0.50/week for the whole fleet. Canary
result lands outside the point's stored CI ⇒ drift alarm ⇒ THEN the full
suite re-runs (content-addressed, so unchanged behaviour re-verifies at $0).
Statistical process control on model behaviour; evidence carries a
freshness age, and the dashboard says it.

### 2. Coverage: a ratcheted target, fed by auditions
Standing target, reviewed monthly: **measured-model count and S7-weighted
catalogue share both go up, under a fixed envelope.** Initial ratchet:
28 → 45 models within 30 days, ≤$40/month measurement budget.
The unlock is the **audition**: a candidate is NOT measured on everything —
S7's ranking names the one or two clusters where it could matter, it plays
those legs only (~$0.10–$2), and full measurement happens only if it lands
on or near a frontier or shows high decorrelation. Breadth stops costing
10-leg campaigns.

### 3. The specialist hunt (SLMs included)
Deliberate scouting lanes, because generalist catalogues under-list them:
code-tuned (KAT-coder is already ours), JSON/extraction-tuned,
function-calling-tuned, math-tuned, multilingual, sub-$0.05/M SLMs, and
notable fine-tunes. Each lane maps to the clusters it could move. The lane
list is a standing artifact; every scan sweeps the catalogue against it.
The bet, stated plainly: the next solar-pro4 is a model nobody benchmarks
because it is small, cheap, and boring — exactly what per-cluster routing
monetizes and leaderboards bury.

### 4. Portfolio scoring: measure for mixing, not just rank
Every audition computes, from the per-item cache:
- **failure decorrelation** vs each incumbent on that cluster;
- **oracle-fusion ceiling** for its best pairings (right whenever either is
  right) — the hard upper bound on what any fusion could capture;
- **ensemble option value** = oracle ceiling − best single's score.
A candidate can earn its keep three ways: on the frontier, as a cascade
stage, or as an ensemble leg. The report says which, with numbers.
This is MIXING-ROADMAP S1 made continuous, and it is the pipeline that
feeds Track B its shortlist instead of Track B guessing.

## Budget governance
One monthly envelope (initial: **$50/mo**), allocated in priority order:
canaries (fixed, first) → S7-ranked auditions → full measurements earned by
auditions → Track B ensemble experiments from the option-value shortlist.
Every dollar ledgered; the envelope is a belt, not a vibe.

## Implementation ladder (what exists → what's next)
| Rung | Piece | Status |
|---|---|---|
| 0 | Content-addressed cache, belts, guards, carry-forward | BUILT |
| 0 | Heartbeat scan (new-model detector) | BUILT, off by default |
| 1 | **Complementarity miner** over existing evidence ($0) | START NOW |
| 2 | S7 rank-catalogue script (+ specialist lanes) | SPEC'D (SERVING S7) |
| 3 | Audition mode: single-cluster sweep at a micro-cap | small handler change |
| 4 | Canary job + drift alarm | new worker job |
| 5 | Coverage ratchet report (monthly artifact) | script over artifacts |
| 6 | Track B ensemble experiments from the shortlist | MIXING Track B |

## What must stay true
- Every number ships with its uncertainty; a stale point says its age.
- Auditions are honest: "measured on extraction only" never masquerades as
  full coverage.
- The envelope is a hard belt. The Observatory never surprises the bill.
- Nulls are published. "We auditioned 12 specialists and none earned a slot"
  is a finding — it is the moat's perimeter, mapped.
