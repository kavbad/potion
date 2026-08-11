# Rollback Runbook — taking it down cleanly

The companion to [DEPLOY-RUNBOOK.md](DEPLOY-RUNBOOK.md). Four different
situations get four different responses, and picking the wrong one is how a
bad deploy becomes a data-loss incident.

> **Coverage.** The database procedures (§3, §4, §5) use paths verified
> against real PostgreSQL 17.10 by `pnpm --filter @potion/db
> rehearse-postgres` (9/9). The compose and TLS steps are **UNEXECUTED** —
> they run for the first time on your host. Correct this document as you go.

---

## Decision table

| Situation | Do | Do **not** |
|---|---|---|
| Bad release, schema unchanged | **§1 revert the image** | restore the database |
| Bad release, new migration applied | **§2 revert + assess**, then §3 only if the migration corrupted data | assume the ledger can undo it |
| Data damaged or lost | **§3 restore from backup** | keep serving while deciding |
| Partner relationship ends | **§5 offboarding** (TRUE-CASCADE erasure) | delete the whole deployment |
| Just pausing service | **§4 drain and stop** | `docker compose down -v` |

**`docker compose down -v` destroys the volumes — the database, Redis, and
Caddy's certificates.** Never use it against a live deployment.

---

## §1 Revert to the previous image (no schema change)

```bash
git log --oneline -5
git checkout <previous-sha>
docker compose -f deploy/docker-compose.prod.yml --env-file .env.prod up -d --build
docker compose -f deploy/docker-compose.prod.yml ps
curl -sS https://your.host/readyz | jq .
```

Migrations are **forward-only**. An older image against a newer schema is
usually fine — columns it does not know about are ignored — but a **removed**
column is not. Check whether the range you are reverting past contains a
destructive DDL before doing this.

## §2 A bad migration shipped

The F12 ledger guarantees a migration runs **exactly once**. It does not undo
one. So:

```bash
psql "$DATABASE_URL" -c "SELECT filename, applied_at, baselined FROM schema_migrations ORDER BY applied_at DESC LIMIT 5"
```

- **Schema-only mistake** (a stray index, a wrong default): fix forward with a
  new migration. Do not hand-edit `schema_migrations`.
- **The migration mutated rows**: this is the F12 class. Restore from backup
  (§3). Rewriting rows to "undo" it is guesswork, and guessing at tenant data
  is what caused F12 in the first place.

To deliberately re-run a repaired migration, delete **just its row** and
redeploy — knowing it will execute against current data:

```bash
psql "$DATABASE_URL" -c "DELETE FROM schema_migrations WHERE filename = '00NN_thing.sql'"
```

## §3 Restore from backup

```bash
# 1. Stop writes first. A restore under live traffic races the thing you are fixing.
docker compose -f deploy/docker-compose.prod.yml stop server

# 2. Restore into a SCRATCH database and verify there before touching production.
createdb potion_restore
gunzip -c potion-<timestamp>.sql.gz | psql "postgres://…/potion_restore"

# 3. Sanity-check the restore.
psql "postgres://…/potion_restore" -c "SELECT count(*) FROM orgs"
psql "postgres://…/potion_restore" -c "SELECT count(*) FROM guarantee_verdicts"
psql "postgres://…/potion_restore" -c "SELECT count(*) FROM schema_migrations"

# 4. Point DATABASE_URL at the restored database, then bring the server back.
docker compose -f deploy/docker-compose.prod.yml --env-file .env.prod up -d server
curl -sS https://your.host/readyz | jq .
```

**Restore drill.** Do steps 1–3 once against a scratch database *before* you
need them, and record the date and outcome here:

```
Last restore drill: ____________  by: ____________  result: ____________
```

**`POTION_MASTER_KEY` is not in the dump.** Restoring the database without it
leaves every stored BYOK provider key undecryptable. Confirm you hold the key
*before* declaring a restore successful.

## §4 Drain and stop (reversible)

```bash
docker compose -f deploy/docker-compose.prod.yml stop server   # stop serving; data intact
docker compose -f deploy/docker-compose.prod.yml start server  # resume
```

In-flight jobs: BullMQ redeliveries are safe — F10's `job_executions` ledger
makes a redelivered job refuse rather than re-spend. A job killed **mid-spend**
leaves spend its next attempt will refuse to complete; per-call metering makes
that visible and the reconcile flags it. Nothing makes provider calls
transactional.

## §5 Offboarding — erase everything the partner derived

The contractual path, not a cleanup shortcut. Full steps in
[ONBOARDING-RUNBOOK.md](ONBOARDING-RUNBOOK.md) §6.

```bash
curl -s -X POST "$POTION_API/operator/orgs/org-acme/delete" \
  -H "Authorization: Bearer $POTION_OPERATOR_TOKEN"
# → 202 {"jobId": "..."}  → poll /api/jobs/:id for the per-table report
```

Keep the report: it is the erasure receipt, with a row count per table.

**This path is verified at scale.** The rehearsal ran the cascade against real
PostgreSQL with 1200 `request_logs` — four times the 500-row chunk — and
erased all of them, reporting the true count (F17). Note that the
**walkthrough's** version of this proof runs on PGlite and is valid only at
fixture scale; the real-Postgres run is the one that counts.

`DEFAULT_ORG_ID` (`org_demo`) is refused by design: it holds platform-wide
unauthenticated request logs and is re-seeded at boot.

## §6 Full teardown

Only when the deployment itself is being retired, and only after §5 and a
final backup:

```bash
pg_dump "$DATABASE_URL" | gzip > potion-final-$(date -u +%Y%m%dT%H%M%SZ).sql.gz
docker compose -f deploy/docker-compose.prod.yml down          # keeps volumes
docker compose -f deploy/docker-compose.prod.yml down -v       # DESTROYS volumes
```

Then destroy the managed database, revoke provider keys, and **securely
destroy `POTION_MASTER_KEY`** — while any encrypted BYOK material still
exists in a backup, that key is live credential material.
