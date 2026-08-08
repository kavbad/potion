# Potion

**Pareto frontiers of model _combinations_, served behind one OpenAI-compatible endpoint.**
Potion clusters your prompts by task type, benchmarks single models and composite strategies
(cascades, best-of-N, draft-verify, ensembles) per cluster, computes the non-dominated set in
(quality, cost, p95 latency), and serves every request from the frontier point your policy picks.
When a new model ships, the frontier is recomputed and the diff is narrated in plain language.

Policies: `max_quality` (best quality under a cost ceiling), `min_cost` (cheapest above a quality
floor), `latency_bound` (best quality inside a p95 budget), and `compound` — a quality floor **and**
a hard latency bound, cheapest among the survivors. The latency bound excludes rather than trades
off, because a bound stated in a guarantee is an SLO, not a preference; since that exclusion prunes
exactly the cheap serial compositions, Potion reports what your deadline is costing you and the p95
it would have to relax to. A bound binds against **your own served latency** once the cluster has
enough traffic, and says so plainly while it is still working off benchmark numbers.

- [SPEC.md](SPEC.md) — the engineering contract (types, routes, pipeline)
- [FRONTIER.md](FRONTIER.md) — the buyer-facing explanation (3-minute read, no jargon)
- [tasks/todo.md](tasks/todo.md) — phase plan, gate proofs, spend ledger

## Prerequisites

- **Node 20** (`node -v` → v20.x)
- **pnpm 9** (`npm i -g pnpm@9` or `corepack enable`)
- **Docker** — only for Quickstart B (real Postgres/Redis). Quickstart A needs nothing else.

## Quickstart A — zero-services sandbox (~5 min, no keys, no Docker)

Everything runs embedded: **PGlite** (in-process Postgres with pgvector), an **in-process queue**,
and a **deterministic mock provider**. No accounts, no API keys, no network, no spend.

```bash
pnpm install
pnpm verify          # build + typecheck + lint + 233 tests
pnpm demo:customer   # the full customer journey, one continuous run
```

`demo:customer` boots the API on a fresh embedded database (demo data auto-seeds: demo key,
three policies, real code-gen + extraction frontiers computed by the eval harness), uploads the
sample workload, prints the cluster breakdown and the per-cluster frontier tables, creates a
`max_quality` policy ($2/1K ceiling) with a fresh API key, answers three chat requests with their
`x-frontier-trace` headers, then simulates a new-model release and shows the frontier moving
(appeared / vanished / dominated-by + buyer-readable narrative).

More sandbox toys:

```bash
pnpm demo:mock-e2e   # one fake request through cluster → strategy → mock provider
pnpm --filter @potion/pareto demo   # Gate-4 frontier + new-model diff, standalone
pnpm --filter @potion/dashboard walkthrough   # dashboard cold-start, scripted
```

## Quickstart B — full local stack (~15 min, Docker)

Real Postgres 16 + pgvector and Redis via docker-compose; server + dashboard with hot reload.

```bash
docker compose up -d          # Postgres 16+pgvector on :5432, Redis 7 on :6379

export DATABASE_URL=postgres://potion:potion@localhost:5432/potion
export REDIS_URL=redis://localhost:6379   # reserved for the BullMQ queue driver
                                          # (in-process driver is used today; TODO in packages/queue)

pnpm install && pnpm build
pnpm dev                    # API on :3000 + dashboard on :3001, in parallel
```

Open **http://localhost:3001** — connect a provider key (stored masked-only), upload
`apps/dashboard/samples/workload.jsonl`, inspect the frontier chart, pick a policy, and copy the
endpoint snippet. Without `DATABASE_URL` the same commands run entirely on PGlite.

**Optional — live provider keys.** Set any of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`GOOGLE_API_KEY`, `OPENROUTER_API_KEY` and the server escalates from the mock provider to live
transports (and from the mock embedder to OpenAI embeddings when `OPENAI_API_KEY` is present):

```bash
pnpm smoke:live   # capped live smoke test — the ONLY script that can spend real money
```

## Auth & tenancy (M2)

Every customer asset hangs off an **org**; users join orgs via **memberships** with a role
(`admin` | `member` | `viewer`). The dashboard signs in **passwordless by magic link**:

```bash
curl -X POST localhost:3000/auth/request-link -H 'content-type: application/json' \
  -d '{"email":"you@company.com"}'   # dev: first signup auto-provisions a solo org (you are admin)
open "<the link from the email>"     # GET /auth/verify → httpOnly cookie + ps_… bearer token
curl localhost:3000/api/frontiers -H "cookie: potion_session=ps_…"     # dashboard API (session)
curl localhost:3000/v1/chat/completions -H "authorization: Bearer pk_…" # serving stays API-KEY only
```

**Production is operator-onboarded, not self-serve (G2.7):** auto-provisioning is
gated by `POTION_SELF_SERVE` (default ON only in dev mode; OFF otherwise — unknown
emails get a neutral response and no org). Orgs are created and deleted through the
`/operator/*` surface, authenticated by the fail-closed `POTION_OPERATOR_TOKEN`
bearer. See `docs/ONBOARDING-RUNBOOK.md` for the full create → policy → key →
invoice → offboard flow (offboarding is a TRUE-CASCADE deletion — nothing derived
survives).

- **Routes:** `POST /auth/request-link` · `GET /auth/verify` · `POST /auth/logout` ·
  `GET /auth/me` · `POST /auth/invite` (admin-only: teammates join an existing org by invite
  ONLY — role defaults to `member`).
- **RBAC on `/api/*`:** viewer = read-only (GET) · member = + writes (keys metadata, policies,
  workloads) · admin = + invite / revoke / rotate. The role comes from the session's membership.
- **Email delivery** is pluggable (`SendEmail` in `apps/server/src/routes/auth.ts`); the default
  LOGS the link (dev). SMTP is a documented TODO: wire `POTION_SMTP_HOST` / `POTION_SMTP_PORT` /
  `POTION_SMTP_USER` / `POTION_SMTP_PASS` / `POTION_SMTP_FROM` to a real transport in prod.
- **Dev-mode bypass:** `POTION_DEV_AUTH=1` lets unauthenticated `/api/*` traffic act as the
  demo org's admin (keeps the pre-auth local-tool flow alive). When `POTION_DEV_AUTH` is unset
  the bypass is ON outside production and **OFF by default in production**
  (`NODE_ENV=production`) — do not set `POTION_DEV_AUTH=1` there. In prod, also terminate TLS
  and set the session cookie's `Secure` flag at the proxy.

## Architecture map

Dependency direction: arrows point from consumer to dependency (`apps` depend on `packages`,
never the reverse; `core` depends on nothing but zod).

```
 apps/dashboard (Next.js 15)  ──HTTP only──▶  apps/server (Fastify 5)
                                                  │
        ┌───────────────┬───────────────┬────────┼───────────────┐
        ▼               ▼               ▼        ▼               ▼
   packages/       packages/       packages/  packages/     packages/
   cluster         harness         pareto     strategies    queue
   (embed,         (eval runner,   (dominance, (6 strategy   (memory |
    centroids,      scorers, judge, frontier    interpreters)  bullmq*)
    assignment)     budget cap)    version/diff,     │   │
                        │   │       recompute)       │   │
                        ▼   ▼           │            ▼   ▼
                     packages/db ◀──────┴───── packages/providers
                     (Drizzle schema, 12 tables,  (anthropic/openai/google/
                      PGlite | node-pg, repos)     openrouter/mock, prices.json)
                                │                       │
                                └──────────┬────────────┘
                                           ▼
                                      packages/core
                                (THE CONTRACT: TaskCluster,
                                 StrategyConfig, Frontier(Point),
                                 Policy, PriceTable — pure types)
```

\* BullMQ driver is a marked TODO; the in-process driver backs all runs today.

## The six-gate story

1. **Gate 0 — skeleton & contracts:** workspace, core types, mock provider; a fake request flows end to end.
2. **Gate 1 — providers & strategies:** 4 live transports + retry; all 6 strategies run on mock; costs verified to the cent.
3. **Gate 2 — clustering:** 10-cluster taxonomy, pgvector centroids; **89%** held-out assignment accuracy (≥85% required).
4. **Gate 3 — eval harness:** 3 baselines + 3 composites × 2 suites on mock; quality ordering confirmed; budget-cap refusal demonstrated.
5. **Gate 4 — Pareto engine:** dominated strategy excluded; simulated new-model release diffs v1→v2 with a narrative.
6. **Gates 5+6 — serving & dashboard:** OpenAI-compatible endpoint with `x-frontier-trace`, 50 RPS load test (platform p95 overhead **9.66ms**); Next.js dashboard walkthrough cold-start < 5 min.

Full proofs (commands + output) are recorded in [tasks/todo.md](tasks/todo.md).

## Testing & verification

```bash
pnpm verify                                # build + typecheck + lint + test (CI gate)
pnpm test / pnpm typecheck / pnpm lint     # individual legs
pnpm --filter @potion/cluster evaluate     # held-out confusion matrix
pnpm --filter @potion/server loadtest      # 50 RPS open-loop load test
pnpm harness --help                        # eval runner CLI (budget-capped)
```

## Eval suite provenance (M1a)

Not all eval results are equal — the harness enforces where a suite came from:

- **`packages/harness/suites/simulated/`** — `code-gen.jsonl` + `extraction.jsonl`
  were *generated from the mock eval corpus*
  (`packages/providers/src/mock/eval-corpus.ts`): the same module answers them.
  They are **TEST/CI SIMULATION ONLY, never evidence of real-world quality**.
  `runEval` refuses them without an explicit `simulatedOk` / `--simulated-ok`
  opt-in, marks `RunSummary.simulated: true`, and the CLI prints a loud banner.
- **`packages/harness/suites/*.jsonl` (8 breadth suites)** — independently
  authored, each carrying a `// provenance: authored, unvalidated — pending
  live calibration` header (JSONL `//` lines are comments; the loader skips
  them).
- The mock provider module exports `MOCK_PROVIDER_DISCLAIMER` for any surface
  that displays mock-backed results.

## Spend discipline

This was a **mock-first build: total live spend $0.00**. All gates, tests, seeds, and demos run on
the deterministic mock provider (same code paths, mock transport) with live prices used only as
_accounting_ numbers. Every eval run is budget-capped — the harness refuses runs whose projected
spend exceeds the cap — and the only live-spend script (`pnpm smoke:live`) ships capped and is not
executed without keys. Keep it that way: mock first, cap always, well under $50 total ever.
