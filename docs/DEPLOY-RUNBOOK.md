# Deploy Runbook — single instance, one design partner

Stand up Potion for one partner, hand them a URL, and know how to take it
down cleanly (that part is [ROLLBACK-RUNBOOK.md](ROLLBACK-RUNBOOK.md)).

> ## ⛔ STOP — DO NOT RUN MORE THAN ONE SERVER REPLICA
>
> `InMemoryRateLimiterStore` is the **only** implementation of the rate
> limiter's store seam, and it is what production runs — it is not a test
> stand-in. With N replicas a key's contracted rate **and** daily cap are both
> N×, and a rollout resets every bucket, so a client can lift its own limit by
> inducing one. Filed as **F18**, with a reproducing test in
> `apps/server/test/known-defects.test.ts`.
>
> `docker-compose.ha.yml` (2 replicas behind nginx) exists for the future and
> **must not be used until G2.5** (shared limiter + cache) lands. Single
> instance is a decision, not a limitation: at one replica that entire failure
> class cannot occur. See [driver-semantics.md](driver-semantics.md) row 6 and
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

## §1 Provision the database

Any managed PostgreSQL that satisfies **both**:

- **version ≥ 15** — migration 0023 uses `CREATE UNIQUE INDEX … NULLS NOT
  DISTINCT`, which is PG15+ only. On 13/14 the first boot fails.
- **pgvector available, and the app user may `CREATE EXTENSION`** —
  `0000_init.sql` runs `CREATE EXTENSION IF NOT EXISTS vector`. On managed
  providers this often needs the extension allow-listed first.

Preflight, before anything else:

```bash
psql "$DATABASE_URL" -tAc "SELECT current_setting('server_version_num')::int >= 150000"
psql "$DATABASE_URL" -c "CREATE EXTENSION IF NOT EXISTS vector"
```

Both must succeed. If the second fails, stop — no amount of retrying the
deploy will fix a database that cannot host the extension.

## §2 Secrets

```bash
cp .env.example .env.prod
openssl rand -hex 32   # POTION_MASTER_KEY
openssl rand -hex 32   # POTION_OPERATOR_TOKEN
openssl rand -base64 32 # POSTGRES_PASSWORD
sudo chown root .env.prod && sudo chmod 600 .env.prod
```

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

```bash
pg_dump "$DATABASE_URL" | gzip > potion-$(date -u +%Y%m%dT%H%M%SZ).sql.gz
```

Nightly, retained off-host, **plus** the managed provider's own automated
backups. Back up the artifacts volume too.

**A backup you have not restored is a hypothesis.** Do the restore drill in
§4 of [ROLLBACK-RUNBOOK.md](ROLLBACK-RUNBOOK.md) once, now, and record the
date here when you do.

`POTION_MASTER_KEY` is backed up **separately** — see §2.

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
| One replica (F18) | no horizontal scaling; a restart empties rate-limit buckets | G2.5 |
| No circuit breaker / hedging (F19) | a provider outage becomes latency, not fast failure | F19 |
| Embeddings unpriced (F13) | embedding spend meters at $0 | F13, if the partner uses embeddings |
| No SMTP | magic links are hand-delivered (single-use, 15 min) | by design |
| Container/TLS layer unexecuted | §5–§6 run for the first time on your host | this deployment |
