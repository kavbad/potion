# Deploy Runbook — single instance, one design partner

Stand up Potion for one partner, hand them a URL, and know how to take it
down cleanly (that part is [ROLLBACK-RUNBOOK.md](ROLLBACK-RUNBOOK.md)).

> ## ⛔ STOP — DO NOT RUN MORE THAN ONE SERVER REPLICA
>
> **F18 is CLOSED.** `InMemoryRateLimiterStore` used to be the only
> implementation of the rate limiter's store seam, and it was what production
> ran: with N replicas a key's contracted rate **and** daily cap were both N×,
> and a rollout reset every bucket, so a client could lift its own limit by
> inducing one. `RedisRateLimiterStore` now fills the seam (atomic Lua
> refill+check+consume) and is selected whenever `REDIS_URL` is set — which
> this compose file sets. Tests:
> `apps/server/test/f18-shared-rate-limit.test.ts`.
>
> `docker-compose.ha.yml` (2 replicas behind nginx) is no longer blocked by
> the limiter. Remaining before scaling out: the per-org **serving-latency**
> rollup cache and the budget hard-stop memo are still per-replica 60s memos.
> Neither multiplies a limit — both read shared database state and only
> cache the ANSWER — so each bounds staleness by one window rather than by
> the replica count. See [driver-semantics.md](driver-semantics.md) row 6 and
> `docs/HA.md`.

---

## §0 What has actually been executed (read this first)

This runbook is honest about its own coverage. Two layers, verified very
differently:

| Layer | Status | Evidence |
|---|---|---|
| **Database** — migrations, F12 ledger + baselining, transaction-per-migration, cascade erasure, F21 boot path | ✅ **EXECUTED** against PostgreSQL **17.10 + pgvector 0.8.6** | `pnpm --filter @potion/db rehearse-postgres` — **9/9 passed** |
| **Container / TLS** — compose, Caddy, cert issuance, `/metrics` 403, healthchecks, image build | ⚠️ **UNEXECUTED** — no container runtime was available on the authoring machine | none; §6 says what to watch |

Everything in §1–§4 has been run for real. **§5 (compose bring-up) and §6
(TLS) run for the first time on your host** — treat their first execution as
part of the deployment, not as a formality, and expect to correct this
document while doing it.

---

## §1 Provision the database — Neon

**Shape (decided 2026-08-10): PostgreSQL is Neon; Redis is co-located on the
host.** One managed service instead of two at this scale, and Neon's
branch/PITR restore is the fastest path through §3 of the rollback runbook —
the step most likely to matter and least likely to be practised.

1. Create a Neon project on **PostgreSQL 17** (17.10 + pgvector 0.8.6 is what
   the rehearsal verified). Anything ≥15 satisfies 0023's `NULLS NOT
   DISTINCT`; do not go below.
2. Create the `potion` database and a role for the app.
3. Enable pgvector — `0000_init.sql` runs `CREATE EXTENSION IF NOT EXISTS
   vector`, and the app role must be allowed to create it:

   ```bash
   psql "$DATABASE_URL" -c "CREATE EXTENSION IF NOT EXISTS vector"
   ```

4. Take the **DIRECT endpoint**, not the `-pooler` one, and keep
   `sslmode=require`:

   ```
   DATABASE_URL=postgres://USER:PASS@ep-xxxx.REGION.aws.neon.tech/potion?sslmode=require
   ```

   This is a single instance with `PG_POOL_MAX=10`. Neon's PgBouncer pooler
   buys nothing at that size, and its transaction-mode semantics are a
   divergence nothing here has tested — the rehearsal ran against a direct
   connection.

### ⚠️ Neon autosuspend vs `/readyz` — decide this before going live

Neon suspends an idle compute and cold-starts it on the next connection. Two
timeouts in this codebase sit right on top of that:

| Knob | Default | Interaction |
|---|---|---|
| `READYZ_DB_TIMEOUT_MS` | **2 000 ms** (`apps/server/src/readiness.ts`) | a cold start slower than 2s makes `/readyz` report the db unhealthy |
| compose `healthcheck` | `/readyz`, 10s interval, 6 retries | sustained `/readyz` failures mark the container unhealthy |
| `PG_CONN_TIMEOUT_MS` | 5 000 ms (raised to **15 000** in compose) | pool connect can otherwise fail during a cold start |

So an idle deployment can wake to a failed readiness probe rather than a slow
first request. **Pick one:**

- **Recommended: disable scale-to-zero** on the Neon compute for this
  deployment. A partner-facing instance that sleeps is trading a real failure
  mode for a small bill.
- ~~Or keep autosuspend and raise `READYZ_DB_TIMEOUT_MS`~~ — **this option
  does not exist** (corrected 2026-08-20, 13a spec §2): the value is a
  hardcoded constant in `apps/server/src/readiness.ts`, not an environment
  variable; it is overridable only in tests. With autosuspend the only real
  mitigation is disabling scale-to-zero — which is the recommendation above,
  and also §1.1 of the 13a spec's argument for an always-on Postgres instead.

This is written from reading the code, **not** from watching it happen: it is
an UNEXECUTED interaction, and the first idle-then-wake cycle on the real host
is where it gets confirmed or corrected.

### Preflight

```bash
psql "$DATABASE_URL" -tAc "SELECT current_setting('server_version_num')::int >= 150000"
psql "$DATABASE_URL" -c "CREATE EXTENSION IF NOT EXISTS vector"
```

Both must succeed. If the second fails, stop — no amount of retrying the
deploy fixes a database that cannot host the extension.

## §2 Secrets

```bash
cp .env.example .env.prod
openssl rand -hex 32   # POTION_MASTER_KEY
openssl rand -hex 32   # POTION_OPERATOR_TOKEN
sudo chown root .env.prod && sudo chmod 600 .env.prod
```

- `DATABASE_URL` is the Neon direct endpoint from §1 (it carries the
  password; there is no separate `POSTGRES_PASSWORD` in this shape).
- **`POTION_MASTER_KEY` encrypts every stored BYOK provider key. If it is
  lost, they are unrecoverable.** Back it up **separately from database
  dumps** — a dump plus this key in one place is full custody compromise.
- `POTION_OPERATOR_TOKEN` is fail-closed: unset ⇒ `/operator/*` 401s and no
  partner org can be created.
- `POTION_SELF_SERVE` stays **unset**. Operator onboarding
  ([ONBOARDING-RUNBOOK.md](ONBOARDING-RUNBOOK.md)) is the only way an org
  comes into being.
- `POTION_CLUSTER_THRESHOLD=0.2` with a real embedder. The default 0.62 is
  **mock-tuned**; the walkthrough prints this warning on every run and it is a
  genuine production trap (G0.5).
- `.env*` is gitignored except `.env.example`. Confirm before any commit:
  `git status --short | grep -c '\.env'` must print `0`.

## §3 Migration preflight (EXECUTED — rerun it against your database)

```bash
DATABASE_URL=postgres://... pnpm --filter @potion/db rehearse-postgres
```

This is the same script that verified the database layer. It is
**destructive** (it drops and recreates `public`), so run it against a
scratch database first, then read the results:

```
PASS 0. preflight: PostgreSQL >= 15         server_version_num=170010
PASS 0. preflight: pgvector present         vector v0.8.6
PASS 1. first boot: 34/34 migrations apply on node-postgres
PASS 2. second boot: executes nothing (F12 ledger)
PASS 3. platform evidence survives two reboots (F12)
PASS 4. upgrade boot: prefix baselined WITHOUT executing
PASS 5. F17: erasure of an org with 1200 request_logs — 0 rows left
PASS 6. F21: a migration with divider comments boots (1ms)
PASS 7. schema_migrations readable and complete (34 rows)
```

## §4 First boot of the real database

The app migrates on boot (`apps/server/src/context.ts`). On a **brand new**
database everything applies and is recorded. On a database that predates the
F12 ledger, the runner **baselines** the historical prefix without executing
it — this is deliberate: re-running 0023 would move platform evidence into a
tenant's pool. Confirm afterwards:

```bash
psql "$DATABASE_URL" -c "SELECT filename, baselined FROM schema_migrations ORDER BY filename"
```

## §5 Bring it up  ⚠️ UNEXECUTED

```bash
docker compose -f deploy/docker-compose.prod.yml --env-file .env.prod up -d --build
docker compose -f deploy/docker-compose.prod.yml ps
```

What to watch, since this is its first real run:

- **The image build** — `Dockerfile` builds the whole workspace with
  `pnpm install --frozen-lockfile && pnpm build`. Expect several minutes and a
  large image; it copies the full tree because workspace symlinks resolve in
  place.
- **`server` healthcheck** uses `/readyz`, not `/healthz`: db ping + queue
  ping + breaker summary. `start_period` is 40s to cover migrations.
- **The server publishes no ports.** If you can reach it without going through
  Caddy, the compose file has been edited and `/metrics` is exposed.
- `depends_on: service_healthy` gates on Postgres and Redis being ready, so a
  slow database delays rather than fails the boot.

## §6 TLS and `/metrics`  ⚠️ UNEXECUTED

`POTION_SITE=your.host` makes Caddy provision a Let's Encrypt certificate
automatically (ports 80 and 443 must be reachable from the internet). Verify:

```bash
curl -sSI https://your.host/healthz | head -1        # 200
curl -sS  -o /dev/null -w '%{http_code}\n' https://your.host/metrics   # 403
curl -sSI http://your.host/healthz | head -1         # 308 → https
```

**The `/metrics` 403 is load-bearing.**
`apps/server/src/security/route-inventory.ts` classifies `/metrics` as public
with the justification *"the surface is network-restricted by deployment
posture"* — `deploy/Caddyfile` **is** that posture. Until this curl returns
403, that justification is a phantom decision. Scrape over the private network
instead, or set `POTION_METRICS=0` so the surface does not exist at all.

## §7 Onboard the partner

Follow [ONBOARDING-RUNBOOK.md](ONBOARDING-RUNBOOK.md) end to end against the
deployed URL — create org → hand-deliver the magic link → policy + serving key
→ BYOK → ingest → verify serving. Do not substitute localhost: the point is to
exercise the deployed path.

## §8 Backups

Neon gives you PITR and branching. **Use them, and do not rely on them alone**
— a provider-side snapshot is still one vendor away from being unavailable.

```bash
# Off-platform dump, nightly, retained off-host.
pg_dump "$DATABASE_URL" | gzip > potion-$(date -u +%Y%m%dT%H%M%SZ).sql.gz
```

Redis is **not** in the backup set: it holds queue state only — every piece of
customer evidence lives in Neon — so losing it costs in-flight jobs, which are
re-enqueued, not restored.

**A backup you have not restored is a hypothesis.** Production is Render
Postgres 17 (Frankfurt), not Neon (this section predated the move). Render
keeps daily backups and point-in-time recovery on the dashboard; the drill
that proves the path end to end is `scripts/restore-drill.sh`, run on
potion-prod: a read-only `pg_dump` of the live database, a restore into a
throwaway `postgres:17` container, and a table/row-count comparison. The
dump stays under `/opt/potion/backups` (0600). Run it after any migration
that adds a table, and before a partner's first month closes.

`POTION_MASTER_KEY` is backed up **separately** — see §2. It is not in the
dump, and a restore without it leaves every stored BYOK key undecryptable.

## §9 Upgrades

```bash
git pull && docker compose -f deploy/docker-compose.prod.yml --env-file .env.prod up -d --build
```

New migrations apply on boot, exactly once, recorded in `schema_migrations`.
Take a dump first (§8): the ledger prevents *repeat* application, not a
mistake inside a new migration.

---

## Known limits of this deployment

| Limit | Consequence | Fix |
|---|---|---|
| ~~One replica (F18)~~ | **fixed** — shared Redis limiter; buckets survive rollouts and span replicas | done |
| No circuit breaker / hedging (F19) | a provider outage becomes latency, not fast failure | F19 |
| Embeddings unpriced (F13) | embedding spend meters at $0 | F13, if the partner uses embeddings |
| No SMTP | magic links are hand-delivered (single-use, 15 min) | by design |
| Container/TLS layer unexecuted | §5–§6 run for the first time on your host | this deployment |

## Added 2026-08-23

- `POTION_REASONING_MODELS` (server, non-secret): comma-separated roster aliases known to be reasoning models, e.g. `or-inkling-small,or-inkling`. Below 1024 output tokens they are skipped before the call; the server also learns new ones from evidence (`apps/server/src/routing/reasoning.ts`).
