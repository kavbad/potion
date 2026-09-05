# What Potion does, in plain language

**Most "AI router" products pick one model per request. Potion picks a _recipe_ — and it can prove
the recipe is worth its price.**

## The idea: a frontier of model combinations

For each kind of task you send us (writing code, extracting fields, summarizing, and so on), there
are dozens of ways to answer: one cheap model, one expensive model, a cheap model that asks a
stronger one for help only when unsure, three drafts with a judge picking the best, and more. Each
option has a quality score, a price, and a speed.

Some options are simply bad deals: another option is better quality _and_ cheaper _and_ at least as
fast. Throw those away. What remains is the **Pareto frontier** — the short list of options where
you only ever trade up: every step along it buys measurably more quality for measurably more money.
Nothing on the frontier is a bad deal; nothing off it is worth buying.

A router picks a road; a compiler designs the route. A router chooses a model by guesswork. Potion
compiles a plan around a point on a measured frontier — so when you spend more, you can see exactly
what the extra money bought.

## How it's computed

1. **Your workload is clustered.** We group your prompts into task types (code generation,
   extraction, summarization…) using embeddings over a curated taxonomy.
2. **Each cluster is benchmarked.** A fixed suite of representative tasks per cluster is run against
   every candidate recipe — single models and combinations alike — and scored for quality. We record
   the cost per 1,000 requests and the p95 latency of each.
3. **The frontier is the non-dominated set.** Any recipe beaten on quality, price, and speed by
   another is excluded. The survivors, sorted from cheapest to best, are your menu.
4. **Everything is versioned.** Every frontier is stored with a version number and the price list it
   was computed from, so results are auditable and comparable over time.

## What happens when a new model comes out

This is the part routers can't do. When a new model is released, we add it to the price list and
automatically benchmark a shortlist of recipes built around it — solo, as the cheap stage of a
cascade, as the strong stage, as best-of-three with a judge, as a drafter with an expert verifier.
The affected frontiers are recomputed and **the change is explained in one sentence per movement**.

A real example from our test suite: a simulated new model "mock-new-x" launched at a mid-tier
quality profile but priced below the mid tier. After recompute, **best-of-3(new model) with a judge
appeared on the frontier at quality 0.93 for $0.69 per 1K requests — and single(frontier-class),
previously the top option at quality 0.90 for $2.49 per 1K, fell off the frontier because the new
combination is _cheaper and higher quality_.** Nobody had to notice the launch or hand-tune
anything; the frontier moved, the narrative said why, and serving picked it up immediately.

## What the dashboard chart shows

One chart per task cluster: **cost per 1K requests on the horizontal axis, quality in plain words
on the vertical axis**, and each point's size encodes its p95 latency. The shaded region is
dominated territory — bad deals you never have to consider. The frontier line is your menu, and a
marker shows **"you are here"**: the point your current policy selects. You can read it in five
seconds: left is cheaper, up is better, stay on the line.

## The three policy types

- **max_quality (cost ceiling):** give me the best answer money can buy, as long as it stays under $X per 1K requests.
- **min_cost (quality floor):** give me the cheapest recipe that still scores at least Y quality.
- **latency_bound (p95 limit):** give me the best recipe that answers within Z milliseconds, 95% of the time.

Every response carries an `x-frontier-trace` header naming the cluster, recipe, and frontier
version it was served from — so the chart and your bill always agree.

*Technical detail lives in [SPEC.md](SPEC.md); engineering progress and proofs in
[tasks/todo.md](tasks/todo.md).*
