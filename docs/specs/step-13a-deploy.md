# Step 13a spec — Deploy the stack

Phase one per `docs/LAB-BUILD-PLAN.md` (Step 13 was split into 13a — Deploy
the stack — and 13b — Gate C flip; execution order 13a → 14 → 15 → 16 → 13b →
17). This step stands up Potion on real infrastructure so the operator can
reach the Lab at a URL and run a harness end to end. **No payments, no
self-serve, no abuse controls — those are 13b.** Auth stays on
(`NODE_ENV=production`, dev-auth bypass off); `POTION_SELF_SERVE` stays unset.

Binding inputs read before writing: the plan's Step 13a/13b entries; the
status ledger; `docs/REHEARSAL-COVERAGE.md` (what the deploy rehearsal ran and
the seven container/TLS items it could not); `docs/DEPLOY-RUNBOOK.md`;
`docs/HA.md`; `CLAUDE.md`; and the deploy artifacts (`Dockerfile`,
`deploy/docker-compose.prod.yml`, `deploy/Caddyfile`, `.env.example`). Vendor
pricing was web-verified on **2026-08-15** (§1, sources footnoted).

**Done when** (plan, verbatim): the operator can reach the Lab at a real URL
over TLS, `/readyz` is green on the domain, and a harness runs end to end
through the deployed path (an operator-onboarded org, not localhost).

---

## 1. Vendor recommendation

This is a recommendation, not a survey: one pick and one runner-up per slot,
each argued from **this codebase** at its real scale — **roughly zero to a
handful of users, a single always-on instance**. Neon is the incumbent
assumption (it is what `.env.example`, the compose, and the runbook name); it
is **not** a constraint, and §1.1 argues against it because the code does.

**Prices below were web-verified on 2026-08-15** and are tagged `[verified]`;
anything I could not confirm to the dollar is tagged `[estimate — confirm at
vendor]`. Vendor pricing pages move; the operator re-confirms at provisioning.

### 1.1 Postgres — **pick: a small always-on managed Postgres with native pgvector (Render Postgres); runner-up: co-located Postgres on the app VM. Argued against: Neon (the incumbent).**

**Why not Neon, grounded in code — the operator invited this.** Three facts
turn Neon's serverless model into a poor fit here:

1. **`READYZ_DB_TIMEOUT_MS` is a hardcoded `2_000` constant
   (`apps/server/src/readiness.ts:12`), NOT an environment variable.** Neon
   suspends idle compute and cold-starts on the next connection; a cold start
   slower than 2s makes `/readyz` report the database unhealthy, which the
   compose healthcheck (`/readyz`, 10s × 6) then treats as an unhealthy
   container. **The `DEPLOY-RUNBOOK.md` §1 mitigation — "raise
   `READYZ_DB_TIMEOUT_MS` above the observed cold start" — is not actually
   available**: it is a constant, not a knob (confirmed by grep; overridable
   only in tests via `opts`). So the *only* real mitigation for Neon
   autosuspend is **disabling scale-to-zero**, which throws away Neon's whole
   cost advantage. (13a build will correct that line in the runbook.)
2. **Always-on Neon is not cheap at this scale.** Compute bills at
   **$0.106/CU-hour** `[verified]`; always-on is ~$19/mo at the 0.25-CU floor
   and **~$76/mo at 1 CU** (720 h × $0.106). For a product with zero-to-a-
   handful of users, paying always-on rates to dodge a cold-start trap is the
   worst of both worlds.
3. **The code needs almost nothing Neon-specific.** pgvector is **storage-only
   here** — `cluster_exemplars.embedding vector(384)` (`schema.ts:147`,
   `0000_init.sql`) is written by `rebuild-centroids` and never queried with a
   distance operator; the serving-path cluster routing is pure JS cosine over
   **in-memory** centroids (`packages/cluster/src/assigner.ts`). The app
   self-migrates via the idempotent F12 ledger. So the DB needs only
   **PG ≥ 15 + the `vector` extension**, and provider lock-in is near zero.

**The pick — Render Postgres (Basic tier).** Always-on by default (the
autosuspend/`/readyz` question simply does not arise), **native pgvector**
`[verified]`, **automatic point-in-time recovery on every paid database**
(3-day retention on Hobby, 7-day on Pro workspaces) `[verified]`. The guarantee
*is* the customer evidence (`CLAUDE.md`), so managed PITR — not a hand-rolled
dump on one disk — is the right protection. A pool of **10 direct connections,
one per process** (`packages/db/src/pool.ts:16`, shared by the in-process
worker — §2) fits the smallest tiers; no PgBouncer is wanted.

- **Monthly cost at our scale:** **~$6/mo** (Basic-256mb) rising to **~$19/mo**
  (Basic-1gb) as the pgvector working set / `request_logs` grow `[verified —
  Render Postgres Basic-256mb $6/mo]`. Start at the smallest tier that holds
  the working set; it is a slider, not a migration.
- **Switching cost: LOW.** A `DATABASE_URL` swap plus
  `pnpm --filter @potion/db rehearse-postgres`; the F12 ledger prevents
  re-migration; `pgvector + PG15` is the only hard filter. Outgrowing Render
  (to RDS, Neon, or self-managed) is the same one-line swap.
- **Disqualifier found by reading code:** any managed Postgres that does not
  offer the `vector` extension fails at migration `0000_init.sql`
  (`CREATE EXTENSION vector`) — boot-blocking, not degraded; and any PG < 15
  fails `0023` (`NULLS NOT DISTINCT`). Verified stack: 17.10 + pgvector 0.8.6
  (`REHEARSAL-COVERAGE.md`).

**Runner-up — co-located Postgres 17 + pgvector as a fourth compose service on
the app VM.** Cheapest ($0 extra), zero network latency, always-on, no
autosuspend, single vendor — the "one box" ethos taken to its conclusion, and
it fits the CX22's 40 GB. The reason it is runner-up and not the pick: you own
backups entirely (the runbook §8 nightly off-host `pg_dump` + VM snapshots),
and app and evidence then share one disk. Acceptable for a single partner; for
a product whose value is the evidence, managed PITR earns its second vendor.

*(If the operator prefers to keep Neon: it works with **scale-to-zero
disabled** at ~$19–76/mo — the runbook's existing posture — but that is the
choice this section argues against.)*

### 1.2 Host / compute — **pick: a single always-on VM running the existing compose (Hetzner CX22); runner-up: DigitalOcean/Linode droplet.**

The deployment is `docker compose up -d` of three services (server, redis,
caddy) with named volumes (Redis AOF, Caddy certs). Two code facts fix the
shape of the host:

1. **The worker is IN-PROCESS.** `buildServer` calls `runWorker(...)`
   directly (`apps/server/src/server.ts:216`); the BullMQ consumer is created
   lazily on the same Redis connection and shares the Fastify event loop
   (`packages/queue/src/bullmq.ts:184`); the Dockerfile CMD is only the server.
   There is no worker service in the compose because there is no worker
   process. A **~24-minute `lab:run` leg** (stated in code:
   `handlers.ts:3600`; a job runs legs back-to-back until terminal, so its
   wall-clock is *unbounded* by the per-leg cap) is CPU/IO time **inside the
   process that also serves `/v1/chat/completions`**. → Prefer **≥ 2 vCPU** so
   a long leg does not starve serving, and **rule out request-timeout-bounded
   platforms** (serverless functions cannot host a 24-min in-process job).
2. **Single replica is a hard invariant (F18).** The compose and runbook both
   shout "DO NOT SCALE PAST ONE REPLICA" — `InMemoryRateLimiterStore` is the
   only store, so N replicas multiply every rate/daily cap by N. → An
   **always-on single VM is the correct home**; autoscaling platforms are
   actively wrong here until G2.5.

**The pick — Hetzner CX22** (2 vCPU / 4 GB / 40 GB): **€4.49/mo ≈ $5**
`[verified]`. Runs the compose verbatim; 2 vCPU covers the in-process-worker
reality; 40 GB holds the image, Redis AOF, and Caddy state (and a co-located
Postgres if §1.1's runner-up is chosen).

- **Monthly cost:** ~$5/mo. **Switching cost: LOW** — it is a Docker host;
  `git pull && docker compose up -d --build` on any VM.
- **Disqualifier found by reading code:** Fly.io Machines / Cloud Run / Vercel
  / Lambda — auto-stop/scale-to-N and request/function timeouts collide with
  (a) the single-replica invariant and (b) a 24-min in-process job. A
  persistent Fly Machine is technically possible but forces decomposing the
  co-located-Redis compose and fighting auto-stop; not worth it at this scale.

**Runner-up — DigitalOcean or Linode shared droplet** (2 vCPU / 2–4 GB,
**~$12/mo** `[estimate — confirm at vendor]`). Identical "docker compose on a
VM" model, pricier, but US data-center proximity to a US partner and one-click
managed VM snapshots/backups.

### 1.3 Redis — **pick: co-located Redis 7 on the VM (as the compose already does); runner-up: Upstash Redis.**

Redis holds **queue state only — no customer evidence** (compose comment;
runbook §8): all evidence lives in Postgres. F10's idempotency ledger makes a
redelivery safe, so losing Redis costs in-flight jobs (re-enqueued), not data.
BullMQ needs a *real* Redis — `ioredis-mock` shares one in-process context and
is not production-valid (F20); `redis:7` with AOF on the `redisdata` volume is
exactly that. At single-instance scale a managed Redis adds a vendor, a network
hop, and cost for nothing.

- **Monthly cost:** **$0** (co-located). **Switching cost: LOW** — a
  `REDIS_URL` swap.
- **Runner-up — Upstash Redis** (serverless, free tier / pay-per-command):
  only if compute later moves off the VM or the queue must survive a full VM
  rebuild. **Caution grounded in BullMQ:** it needs blocking commands + Lua;
  confirm the serverless tier supports `BLPOP`/streams before switching. Not
  warranted now.

### 1.4 Object storage — **pick: none needed at this stage; runner-up (if ever): Cloudflare R2.**

Nothing in the default serving/worker path writes app data to local disk:
**derived suites are in Postgres** (migration `0021` explicitly moved them off
worker-local disk — `packages/db/src/repos/derived-suites.ts`); **artifacts are
written only when `ARTIFACT_STORE ∈ {local,s3}`**, which the prod compose does
not set, so sweep/harness JSON is not persisted at all by default
(`apps/server/src/server.ts:209`); **guarantee reports are generated on demand**
(`routes/guarantee-report.ts` → `reply.send`), never stored. The only prod disk
state is the Redis AOF and Caddy volumes, both on the VM.

- **Monthly cost:** **$0.** **Runner-up if needed later — Cloudflare R2**
  (no egress fees), wired through the existing `ARTIFACT_STORE=s3` seam
  (`packages/artifacts/src/s3.ts`). Provision only if artifact persistence or
  report exports are turned on.

### 1.5 DNS / TLS — **pick: Caddy in-compose (Let's Encrypt) + DNS-only at the registrar/Cloudflare; runner-up: Cloudflare proxied + origin cert.**

`deploy/Caddyfile` already provisions Let's Encrypt certs on the site vars
and **enforces the `/metrics` 403** that `route-inventory.ts`'s "network-
restricted by deployment posture" justification depends on (Caddyfile:17). The
server publishes no ports — it is reachable only through Caddy — so keeping TLS
at Caddy keeps that load-bearing posture in one file we own.

- **Monthly cost:** **$0** (Let's Encrypt) + a domain (~$10–15/yr).
  **Switching cost: LOW.**
- **Runner-up — Cloudflare proxied (orange-cloud) + origin cert:** adds
  DDoS/WAF, but then the `/metrics` restriction must move to a Cloudflare rule
  and be re-verified, and ACME must switch to DNS-01 (HTTP-01 breaks behind the
  proxy). **Disqualifier/caution found in code:** an orange-cloud proxy applied
  carelessly breaks the ACME HTTP-01 challenge *and* defeats the "reachable
  only through Caddy" `/metrics` guarantee — so **default to DNS-only** and put
  the proxy on later, deliberately, with the `/metrics` 403 re-proven.

### 1.6 Error + uptime monitoring — **error pick: Sentry (free Developer tier); uptime pick: UptimeRobot (free).**

No error-reporting SDK is wired anywhere (grep: the only "sentry" strings are a
customer-facing MCP *connector* and audit fixtures). `/metrics` (Prometheus,
gated by `POTION_METRICS`), `/healthz` (process up), and `/readyz` (db + queue
+ breaker) exist; OTel tracing is off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is
set.

- **Error — Sentry, Developer/free tier: 5,000 errors/mo, 1 user, 30-day
  retention** `[verified]`. Net-new: a minimal `@sentry/node` init in
  `buildServer` covers the in-process worker too (they share the process by DEFAULT — §2; `POTION_WORKER=off` plus the compose `worker` service splits them, see DEPLOY-RUNBOOK §10),
  so one wiring point instruments everything. The honest-stub convention wants
  an unwired failure path to be visible; error reporting for a partner-facing
  deploy is worth the single init. **This is the only net-new *code* the
  monitoring slot requires**, and it is a 13a build item, not a vendor choice.
  Team tier is **$26/mo** `[verified]` — add only if 5k errors/mo is exceeded.
  Runner-up: **GlitchTip** (self-hosted, Sentry-compatible) for no third party.
- **Uptime — UptimeRobot, free: 50 monitors @ 5-min, 1 status page** `[verified]`.
  **Zero code** — external HTTP checks against endpoints that already exist.
  Configure **two** monitors: `https://host/healthz` (is the process up) and
  `https://host/readyz` (are db/queue/breakers healthy) — the pair distinguishes
  "server down" from "dependency down." Runner-up: **Better Stack free** (10
  monitors @ 3-min + status page + log drain) — faster interval, fewer monitors.

### 1.7 The bill, at our real scale

| Slot | Pick | Monthly |
|---|---|---|
| Host/compute | Hetzner CX22 (2 vCPU/4 GB) | ~$5 |
| Postgres | Render Postgres Basic | ~$6–19 |
| Redis | co-located on the VM | $0 |
| Object storage | none | $0 |
| DNS/TLS | Caddy + Let's Encrypt | $0 (+ domain ~$1/mo amortized) |
| Error | Sentry Developer | $0 |
| Uptime | UptimeRobot | $0 |
| **Total** | | **~$11–25/mo + domain** |

For contrast, an always-on Neon at 1 CU is **~$76/mo for the database alone** —
the number that most sharpens §1.1.

**Pricing sources (web-verified 2026-08-15):** Neon compute $0.106/CU-h and
scale-to-zero behavior; Render web/Postgres Basic tiers + pgvector + PITR
retention; Hetzner CX22 €4.49/mo (post-April-2026 pricing); Fly.io shared-cpu /
MPG (for the disqualifier); Sentry Developer 5k errors + Team $26; UptimeRobot
free 50 monitors / Better Stack free 10 monitors. Figures marked `[estimate]`
were not confirmable to the dollar and must be re-checked at the vendor before
purchase.

---

## 2. Scope, and two build gaps the code review found

**In scope (13a):** provision the six slots above; bring the compose up on the
host; run migrations on the F12 ledger; execute the seven unexecuted
container/TLS rehearsal items (§4); re-prove the org-budget mid-run kill on
live pricing (§5); wire the one net-new monitoring init (Sentry, §1.6); write
the deployment status doc (§8). Onboard one org through the deployed path and
run a harness end to end (§7).

**Out of scope (13b, carried by name):** payments and credits for fuel; abuse
controls; guided (self-serve) onboarding; the explicit `POTION_SELF_SERVE=1`
flip; the novice loop measured on strangers.

**Two gaps found by reading the code — both are 13a build work, not vendor
questions:**

1. **`POTION_SERVING_URL` is required by `lab:run` and is absent from the prod
   compose.** The lab agent calls back to the serving base URL, and
   `handlers.ts:3540` **throws if it is unset**. Because the worker is
   in-process, this is the loopback endpoint of the same container (e.g.
   `http://localhost:3000`). **Without it, a deployed harness cannot run — the
   13a DoD fails.** 13a build adds it to `deploy/docker-compose.prod.yml` and
   `.env.example`.
2. **`POTION_PUBLIC_URL` should be set** to the public `https://host` so Lab
   links and the connector-OAuth **callback URL are correct** (it otherwise
   falls back to the request Host header — `routes/lab.ts:987`). This matters
   for the Step 10/12 OAuth flow, whose callback URL must match exactly. 13a
   build sets it in the prod env.

Also recorded: **the `DEPLOY-RUNBOOK.md` §1 line offering to "raise
`READYZ_DB_TIMEOUT_MS`" is wrong** — that value is a hardcoded constant, not an
env var (§1.1). 13a build corrects the runbook.

---

## 3. Operator provisioning checklist

Everything the operator supplies, with precise values, so provisioning can
start while the rest of the build proceeds. Each item is independent; do them
in any order and hand the values to the build as a filled `.env.prod`.

### 3.1 Accounts to create

| # | Account | Plan / tier | Notes |
|---|---|---|---|
| 1 | **Compute host** — Hetzner Cloud (or DO/Linode) | CX22, 2 vCPU / 4 GB / 40 GB, ~$5/mo | Ubuntu 22.04/24.04 LTS; install Docker + the compose plugin. Give it a static IPv4. |
| 2 | **Postgres** — Render (or the co-located runner-up, then skip) | Render Postgres **Basic**, PG **17**, region near the host | Enable/confirm **pgvector**; grab the **connection string with `sslmode=require`**. |
| 3 | **Domain + DNS** — registrar or Cloudflare | — | An **A record** `potion.<domain>` → the host's IPv4. **DNS-only / grey-cloud** (no proxy — §1.5). |
| 4 | **Error monitoring** — Sentry | Developer (free) | Create a project (platform: Node); copy the **DSN**. |
| 5 | **Uptime monitoring** — UptimeRobot | Free | Created *after* the URL is live (§4); two HTTP(S) monitors. |
| 6 | **Provider key** for the live budget re-proof | — | An `OPENROUTER_API_KEY` (or partner BYOK) with a few dollars of headroom; used only for §5 under a hard cap. |

### 3.2 Values to generate and set (the `.env.prod`)

Generate the two secrets locally and keep `POTION_MASTER_KEY` backed up
**separately from any database dump** (a dump plus this key is full custody
compromise):

```bash
openssl rand -hex 32   # → POTION_MASTER_KEY   (64 hex; loses all BYOK keys if lost)
openssl rand -hex 32   # → POTION_OPERATOR_TOKEN
```

`.env.prod` (root-owned, `chmod 600`; `.env*` is gitignored — confirm
`git status --short | grep -c '\.env'` prints `0` before any commit):

| Variable | Value | Why / source in code |
|---|---|---|
| `POTION_API_SITE` / `POTION_APP_SITE` / `POTION_ROOT_SITE` | `api.<domain>` / `app.<domain>` / `<domain>` | Caddy provisions TLS for each (`deploy/Caddyfile`). `:443` only for the local rehearsal. A single `POTION_SITE` was split into these three; the old name is read by nothing. |
| `DATABASE_URL` | Render/Neon connection string, `sslmode=require` | `db.ts:35`. Direct endpoint if Neon (no `-pooler`). |
| `PG_POOL_MAX` | `10` (default) | `pool.ts:32`; one pool, shared by the in-process worker. |
| `PG_CONN_TIMEOUT_MS` | `15000` | Compose default; raised over the code default (5000) for cold-connect headroom. |
| `POTION_MASTER_KEY` | the 64-hex above | `custody/src/master.ts:5`; encrypts BYOK keys. |
| `POTION_OPERATOR_TOKEN` | the 64-hex above | `routes/operator.ts:45`; **fail-closed** — unset ⇒ no org can be created. |
| `POTION_SERVING_URL` | `http://localhost:3000` | **NEW (§2).** Required by `lab:run` (`handlers.ts:3540`, throws if unset); loopback because the worker is in-process. |
| `POTION_PUBLIC_URL` | `https://potion.<domain>` | **NEW (§2).** Correct Lab links + OAuth callback URL. |
| `REDIS_URL` | `redis://redis:6379` | Compose service name; co-located Redis. |
| `QUEUE_DRIVER` | `bullmq` | `queue/src/index.ts`; real Redis, not the memory driver. |
| `POTION_EMBEDDER` | `openai` | `context.ts:258` (default `mock`). |
| `POTION_CLUSTER_THRESHOLD` | `0.2` | `context.ts:274`; **throws at boot if outside (0,1)**. The mock default 0.62 collapses live clustering (G0.5 trap). |
| `OPENAI_API_KEY` | platform key (embedder + platform work) | `context.ts:230`; also used by the embedder. |
| `OPENROUTER_API_KEY` | the §5 key | Live budget re-proof; partner BYOK preferred for partner traffic. |
| `SENTRY_DSN` | Sentry DSN (item 4) | **NEW** — consumed by the 13a Sentry init (§1.6). |
| `POTION_METRICS` | `0` (recommended) or `1` | `server.ts:100`. `0` = the meter and route do not exist; prefer until a private scraper is deployed. If `1`, the `/metrics` 403 (§4) is load-bearing. |
| `POTION_SELF_SERVE` | **unset** | `auth.ts:205`; signup stays off. Operator onboarding is the only way an org is born. |
| `NODE_ENV` | `production` (set by the image) | `auth.ts` `devAuthBypassEnabled`. Since P1-2 the bypass is an ALLOW-LIST — it is on only for `development`/`test`, so an unset or misspelled NODE_ENV leaves it OFF rather than opening it. Setting it to `production` is still correct and is what makes `POTION_DEV_AUTH=1` a fatal boot refusal. |

Deliberately **not** set: `POTION_DEV_AUTH` (leave unset — off in prod),
`POTION_SEED_DEMO` (no demo org in prod), `ARTIFACT_STORE` (no disk artifacts —
§1.4). Optional resilience knobs (`POTION_BREAKER_*`) keep their defaults.

### 3.3 Postgres preflight (run before first boot; destructive — scratch DB first)

```bash
psql "$DATABASE_URL" -tAc "SELECT current_setting('server_version_num')::int >= 150000"   # t
psql "$DATABASE_URL" -c "CREATE EXTENSION IF NOT EXISTS vector"                             # succeeds
DATABASE_URL=... pnpm --filter @potion/db rehearse-postgres                                 # 9/9 PASS
```

If `CREATE EXTENSION vector` fails, **stop** — a database that cannot host the
extension cannot boot the schema, and no retry of the deploy fixes it.

---

## 4. The seven unexecuted rehearsal items — run for real on the host

`REHEARSAL-COVERAGE.md` verified the **database** layer against real PostgreSQL
but could not run the **container/TLS** layer (no container runtime on the
authoring machine). These seven run for the first time on the host and are part
of the deployment, not a formality. Each has a pass criterion; failures are
recorded and the runbook corrected in place.

| # | Item | Command / trigger | Pass criterion |
|---|---|---|---|
| 1 | **Image build** | `docker compose -f deploy/docker-compose.prod.yml --env-file .env.prod build` | Builds the whole workspace (`pnpm install --frozen-lockfile && pnpm build`); completes; image runs. |
| 2 | **Compose bring-up** | `… up -d` | `depends_on: service_healthy` gates on Redis; `start_period: 40s` covers cold-DB migration; all services `Up`. |
| 3 | **Server `/readyz` healthcheck** | compose healthcheck | Container reports `healthy`; `/readyz` = 200 (db ping + queue ping + breaker summary). |
| 4 | **BullMQ against real Redis** | first job (e.g. the guarantee 60s sweep, or a lab run) | A job is consumed by the in-process BullMQ worker against `redis:7` — never verified outside `ioredis-mock` (F20). AOF present in `redisdata`. |
| 5 | **TLS / ACME issuance** | the three site vars set, ports 80/443 reachable | `curl -sSI https://potion.<domain>/healthz` → `200`; a real Let's Encrypt cert; check renewal config. |
| 6 | **`/metrics` 403** (load-bearing) | `curl -s -o /dev/null -w '%{http_code}' https://host/metrics` | `403` — this **is** the "network-restricted by deployment posture" that `route-inventory.ts` asserts. Until it returns 403 that justification is a phantom. (If `POTION_METRICS=0`, prove the route is absent instead.) |
| 7 | **HTTP→HTTPS redirect** | `curl -sSI http://host/healthz \| head -1` | `308` → https (Caddy default; verify, don't assume). |

Not fixable by any host rehearsal, recorded as standing residuals (not 13a
exits): live provider transports (429/5xx/timeout paths — F19), real-embedder
clustering quality, and a managed-provider backup/restore drill (do it once and
record the date per runbook §8).

---

## 5. The org-budget mid-run kill, re-proven on live pricing (the named Step 3 item)

Step 3's DoD names "a mid-run budget hard-stop provably kills it." It was proven
in mock; 13a re-proves it on **live-priced spend**, end to end, on the deployed
stack. The chain, named from the code:

`enforceBudgetHardStop` (`routes/budgets.ts:193`) compares month-to-date
live-priced spend to the org's `monthlyCapUsd` when `hardStop === true` → **429
`budget_exceeded`** → the lab agent's `ServingClient` maps it to
`{ kind: 'budget-exceeded' }` (`serving-client.ts:103`) → the run loop
transitions to **`killed-budget` (reason `org-budget`)** and returns
(`loop.ts:416`). This is distinct from the harness fuel cap (`reason 'fuel'`,
`loop.ts:379`).

**The re-proof (bounded, live):** create an org with `hardStop: true` and a
**very low `monthlyCapUsd`** (e.g. `$0.05`); issue a real serving request that
spends a few live-priced cents; the **next** request crosses the cap and
returns 429 `budget_exceeded`; a lab run in flight transitions
`killed-budget`/`org-budget`. Total live spend is bounded by the cap plus one
request — **well under $1** — and runs under an explicit
`KEY_RISK_ACCEPTED=<ISO date>`, ledgered in `tasks/todo.md` (projected vs actual
vs cumulative), exactly like the Step 8 felt leg.

**Recorded residual, not fixed here:** `enforceBudgetHardStop` **fails OPEN on a
db error** (`budgets.ts:189`). The re-proof proves the *closed* path (cap
exceeded ⇒ kill); the fail-open-on-db-error path is a known behavior, flagged
so the ledger does not read the proof as covering it.

---

## 6. Live verification spend cap

- **Ceiling:** **≤ $1** total live model spend for all of 13a, gated by an
  explicit `KEY_RISK_ACCEPTED=<ISO date>` the operator sets at run time (the
  Step 8 precedent). The §5 re-proof is the only intentional live spend; a
  single end-to-end harness run on the deployed path (§7) is mock-provider by
  default and adds $0 unless the operator opts into a live felt leg under the
  same cap.
- **Fail-closed:** no live spend without the risk-acceptance env; the ledger
  row is written before and after.

---

## 7. What gets proven walkthrough-style on the real stack

The 13a definition of done is a proven walkthrough on the deployed host, not an
assertion:

1. **Reachable over TLS:** `curl` shows `/healthz` 200 over https, `/metrics`
   403 (or absent), `http→https` 308 (§4 items 5–7).
2. **`/readyz` green on the domain** — db + queue + breakers healthy through
   Caddy.
3. **Operator onboarding end to end** against the deployed URL, following
   `ONBOARDING-RUNBOOK.md` verbatim (create org → hand-delivered magic link →
   policy + serving key → BYOK → ingest → serve). Not localhost.
4. **A harness runs end to end through the deployed path** — intent → generated
   spec → run → report (the Step 8 novice loop), with `POTION_SERVING_URL` set
   so `lab:run` can call back. Mock provider by default ($0); optional live
   felt leg under the §6 cap.
5. **The org-budget mid-run kill on live pricing** (§5), ledgered.
6. **The seven container/TLS items** (§4) executed, each with its evidence line.

---

## 8. The deployment status doc

13a build produces **`docs/DEPLOY-STATUS.md`** (and corrects
`REHEARSAL-COVERAGE.md` / `DEPLOY-RUNBOOK.md` where the host run contradicts
them). It records, for the real host: the provider actually chosen per slot and
why; versions (PG, pgvector, Node, image digest, Caddy); the seven items'
outcomes with the exact `curl`/log evidence; the live budget-kill proof with
its ledger reference; and the standing residuals carried into the deployment —
**F18** (single replica, no horizontal scale), **F19** (no breaker/hedging in
prod → provider outage becomes latency), **F13** (embeddings unpriced, if the
partner uses them), and the budget-hard-stop **fail-open-on-db-error** (§5).

---

## 9. Risks / what could go wrong

- **In-process worker vs serving (the sharpest one).** A 24-min `lab:run` leg
  runs on the same event loop as `/v1/chat/completions`. ≥ 2 vCPU mitigates but
  does not eliminate head-of-line effects; the honest fix (a separate worker
  service) is deferred — 13a does not introduce it, and the status doc names it.
- **Managed-PG connection ceiling.** The pool is 10 direct connections; the
  smallest managed tiers cap concurrent connections low. Confirm the chosen
  tier allows ≥ 10 direct connections, or lower `PG_POOL_MAX` to match.
- **TLS/ACME first-run friction.** Ports 80/443 must be internet-reachable for
  HTTP-01 issuance; a proxied DNS record (orange-cloud) silently breaks it
  (§1.5). DNS-only is the default for exactly this reason.
- **The `/metrics` posture is only as real as item 6.** If the compose is ever
  edited to publish the server's port, the 403 is bypassed and the
  route-inventory justification becomes a phantom again. Keep `POTION_METRICS=0`
  unless a private scraper is deployed.
- **Vendor-doc churn.** If the operator keeps Neon rather than the §1.1 pick,
  the runbook/compose/`.env.example` already match; if they take Render, 13a
  build updates those three files' DB shape. Either way the app code is
  unchanged (one `DATABASE_URL`).
- **Backup drill is a hypothesis until run.** Whichever PG is chosen, restore
  once and record the date (runbook §8) — a backup never restored is not a
  backup.

---

## 10. Test plan / verify (unfiltered)

- **Local, pre-host:** `pnpm build && pnpm typecheck && pnpm lint && pnpm test`
  stays green with the two new env vars wired and the Sentry init added
  (the init must be a no-op when `SENTRY_DSN` is unset, and that no-op is
  test-covered). Verify output kept **unfiltered**, as every step.
- **Host, first boot:** `rehearse-postgres` 9/9 against the provisioned DB;
  compose up; the seven §4 items with their pass criteria captured verbatim.
- **Live:** the §5 budget-kill re-proof, ≤ $1, ledgered before/after.
- **Walkthrough:** §7, items 1–6, on the domain.

Any deviation from this spec is recorded here in a §11 build-deviations section
during phase two, never made silently (binding protocol).

## 11. Definition of done (restated)

The operator reaches the Lab at `https://potion.<domain>` over a real
Let's Encrypt cert; `/readyz` is green on the domain; `/metrics` returns 403 (or
is absent) and `http→https` redirects; an operator-onboarded org runs a harness
end to end through the deployed path with `POTION_SERVING_URL` set; the seven
container/TLS rehearsal items are executed with evidence; the org-budget mid-run
kill is re-proven on live pricing under a ≤ $1 ledgered cap; `POTION_SELF_SERVE`
is unset and auth is on; and `docs/DEPLOY-STATUS.md` records what actually ran,
which vendors were chosen, and the standing residuals. Verify unfiltered.
