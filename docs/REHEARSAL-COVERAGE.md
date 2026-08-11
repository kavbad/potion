# Rehearsal coverage record

What the deployment rehearsal actually executed, and what it could not — so
[DEPLOY-RUNBOOK.md](DEPLOY-RUNBOOK.md) is honest about its own coverage rather
than reading as uniformly verified.

Run: 2026-08-10, macOS, PostgreSQL **17.10** (Homebrew) + pgvector **0.8.6**,
isolated cluster on port 55432. No container runtime was available on the
authoring machine.

---

## Executed — database layer

`pnpm --filter @potion/db rehearse-postgres`, **9/9 passed**. Every step below
had **never run outside PGlite before** (row 5 of
[driver-semantics.md](driver-semantics.md)), including code written the same
day: the F12 ledger, its baselining probe, transaction-per-migration, and the
0033 repair.

```
PASS  0. preflight: PostgreSQL >= 15 (0023 uses NULLS NOT DISTINCT)
          server_version_num=170010 (major 17)
PASS  0. preflight: pgvector present (0000_init does CREATE EXTENSION vector)
          vector v0.8.6
PASS  1. first boot: every migration applies on node-postgres
          executed 34/34, baselined 0
PASS  2. second boot: executes nothing (the F12 ledger, on the real driver)
          executed 0, ledger holds 34
PASS  3. platform evidence survives two reboots (F12, on real Postgres)
          before {"pf":1,"tf":0,"pe":1,"te":0} after {"pf":1,"tf":0,"pe":1,"te":0}
PASS  4. upgrade boot: historical prefix baselined WITHOUT executing
          baselined 33, executed ["0033_evidence_attribution_repair.sql"]
PASS  5. F17: TRUE-CASCADE erasure of an org with 1200 request_logs
          seeded 1200, report says 1200, rows left 0
PASS  6. F21: a migration with divider comments boots (real path)
          executed in 1ms, probe table present=true
PASS  7. schema_migrations is readable and complete
          34 rows, first=0000_init.sql, last=0033_evidence_attribution_repair.sql
```

### What each step retired

| Risk (from the deploy plan) | Outcome |
|---|---|
| `CREATE EXTENSION vector` unavailable | **retired** — created cleanly |
| `NULLS NOT DISTINCT` needs PG15+ | **retired** on 17.10; still a hard requirement to preflight |
| `db.transaction()` per migration on real PG | **retired** — all 34 files applied transactionally |
| Ledger baseline probe (`information_schema`) written against PGlite | **retired** — reads correctly on node-pg |
| `execute().rowCount` divergence | **retired, and it settled F17** |
| `ctid` chunked delete untested on PG | **retired** — 1200 rows, all erased, true count reported |
| F21 divider comment hangs the boot | **retired on the real boot path**, not just unit timing |

**F17 is now a measurement, not an inference.** It also converts the
walkthrough's erasure claim from something we would have asserted falsely at
scale into something narrowed to what it proves (`FIXTURE SCALE ONLY`), with
the real proof living here.

---

## Not executed — container / TLS layer

No Docker, Colima, Podman, or OrbStack on the authoring machine. **These run
for the first time on the production host.** Each is written as an artifact
and marked in the runbook.

| Step | Artifact | First real run | What to watch |
|---|---|---|---|
| Image build | `Dockerfile` | §5 | Builds the whole workspace (`pnpm install --frozen-lockfile && pnpm build`); several minutes, large image, copies the full tree because workspace symlinks resolve in place |
| Compose bring-up | `deploy/docker-compose.prod.yml` | §5 | `depends_on: service_healthy` gating; `start_period: 40s` must cover migrations on a cold database |
| Server healthcheck | compose `healthcheck` | §5 | Uses `/readyz` (db + queue + breakers), not `/healthz`. A failing db shows up here, not as a crash |
| BullMQ against **real Redis** | `QUEUE_DRIVER=bullmq` | §5 | Never verified against real Redis anywhere — tests use `ioredis-mock`, which shares one in-process data context (F20). This is a genuine first |
| TLS / ACME | `deploy/Caddyfile` | §6 | Ports 80 and 443 must be internet-reachable for issuance; check renewal too |
| `/metrics` 403 | `deploy/Caddyfile` | §6 | **Load-bearing** — `route-inventory.ts` justifies `/metrics` being public with "network-restricted by deployment posture". Until the curl returns 403 that justification is a phantom decision |
| HTTP→HTTPS redirect | `deploy/Caddyfile` | §6 | Caddy default; verify rather than assume |

### Also unexecuted, and not fixable by any local rehearsal

- **Live provider transports** — every 429 / 5xx / timeout / auth / refusal
  path. Tests stub `fetch`. With F19 (breaker and hedging dead in production)
  an upstream outage costs the full retry ladder.
- **The real embedder** — dimension-guarded to 384, but clustering quality on
  real vectors is unmeasured, and `POTION_CLUSTER_THRESHOLD` must be 0.2
  rather than the mock-tuned 0.62.
- **`NODE_ENV=production` auth path** — the dev-auth bypass is off; real
  sessions and API keys only.
- **Backup/restore against a real managed provider** — the procedure is
  written; the drill belongs to the host.

---

## Honest summary

The database layer — where every identified risk sat — is verified against
real PostgreSQL. The container and TLS layer is written but unrun, and the
runbook says so at the top rather than in a footnote. The first production
deploy is therefore a *partial* first run, and the steps that are genuinely
new are enumerated above so nobody has to guess which half was proven.
