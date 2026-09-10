# Potion

**Measured model routing.** Point an OpenAI-compatible client at Potion and every
request is sent to the cheapest model — or combination of models — that has been
*measured* good enough for that kind of work. Every answer comes back with a receipt
saying what served it and why.

- Landing page: [app.withpotion.com/home](https://app.withpotion.com/home)
- API: `https://api.withpotion.com/v1` (OpenAI-compatible)
- Docs: [app.withpotion.com/docs](https://app.withpotion.com/docs)

## What it does

1. **Reads the request** and classifies it into a kind of work (writing code,
   extraction, summarisation, multi-step reasoning, and so on).
2. **Picks from a measured Pareto frontier** for that kind of work. Each frontier
   is the set of strategies — single models and composites — that nothing else
   beats on all three of quality, cost, and p95 latency. Quality is graded on
   held-out items against known answers and carries its confidence interval.
3. **Applies your policy**: `min_cost` (cheapest above a quality floor),
   `max_quality` (best under a cost ceiling), `latency_bound` (best inside a p95
   budget), or `compound` (a floor *and* a hard latency bound).
4. **Returns a receipt** in the `x-frontier-trace` header: the kind of work, the
   strategy that served it, the frontier version, the policy, and whether anything
   fell back.

Three rules shape everything here:

- **Nothing unmeasured is ever auto-selected.** A new model is tested before it
  is routed to. If nothing measured qualifies for a request, Potion says so in
  the receipt rather than guessing.
- **Ties are reported as ties.** When two options' confidence intervals overlap,
  Potion does not invent a winner — it takes the cheaper one and says they were
  tied.
- **Budgets refuse before spending.** An org's cap stops the request, not the
  invoice.

## Using it

```bash
curl https://api.withpotion.com/v1/chat/completions \
  -H "authorization: Bearer $POTION_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"potion-auto","messages":[{"role":"user","content":"Merge overlapping date ranges."}]}' \
  -i | grep -i x-frontier-trace
```

Any OpenAI SDK works against the **Chat Completions** surface: set `baseURL` to
`https://api.withpotion.com/v1` and the API key to a Potion key. Potion serves
`/v1/chat/completions`, plus `/v1/models`, `/v1/embeddings`, `/v1/completions`
and `POST /v1/outcomes` (report what actually happened after a response; see
SPEC §16). The Responses API (`/responses`) is not served — Vercel AI SDK users
must call `potion.chat('potion-auto')`, since the bare `potion('potion-auto')`
constructor builds a Responses-API model and POSTs to `/responses`. Keys,
policies, usage, and receipts are managed in the dashboard at
`app.withpotion.com`.

`model` takes `potion-auto` to route by measurement, or a known model name to
pin to exactly that model. An unrecognised name is a 400, never a silent
reroute.

One trap worth naming on the Outcome API: its body field is `request_id`, but
the value it wants is the **completion id** — the `id` on the response body,
`chatcmpl-…`. The `x-request-id` response header is a different value and
answers 404. The body is `.strict()`, so a misnamed field is a 400 rather than
a silent no-op.

## Developing

Prerequisites: **Node 20**, **pnpm 9** (`corepack enable`), and Docker only if you
want a real Postgres.

```bash
pnpm install
pnpm verify                 # build + typecheck + lint + tests
pnpm dev                    # API on :3000, dashboard on :3001
```

With no `DATABASE_URL` set, everything runs embedded (in-process Postgres, an
in-process queue, and a deterministic mock provider) — no accounts, no keys, no
spend. For a real database: `docker compose up -d`, then export
`DATABASE_URL=postgres://potion:potion@localhost:5432/potion`.

Live provider calls only happen when a provider key is present in the environment,
and every evaluation run is budget-capped: the harness refuses a run whose projected
spend exceeds its cap.

### Layout

```
apps/server       Fastify API: /v1 serving, /api dashboard routes, auth, budgets
apps/dashboard    Next.js: landing, docs, keys, policies, usage, receipts
packages/core     the contract — pure types (clusters, strategies, frontiers, policies)
packages/cluster  request classification
packages/harness  evaluation runner, scorers, budget cap
packages/pareto   dominance, frontier versioning and diffs
packages/strategies  single-model and composite strategy executors
packages/providers   provider transports + price table
packages/db       Drizzle schema, repositories, migrations
packages/workers  measurement campaigns and platform sweeps
```

- [SPEC.md](SPEC.md) — the engineering contract
- [FRONTIER.md](FRONTIER.md) — the frontier explained without jargon
- [docs/DEPLOY-RUNBOOK.md](docs/DEPLOY-RUNBOOK.md) — how production is run
- [docs/ONBOARDING-RUNBOOK.md](docs/ONBOARDING-RUNBOOK.md) — how an org is onboarded

### Testing

```bash
pnpm test            # all packages
pnpm typecheck
pnpm lint
pnpm --filter @potion/server test        # one package
```

## Status

Private, early, and live with a first deployment. Production is operator-onboarded
(no self-serve sign-up). Measurements are re-run as models are released.
