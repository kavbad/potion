# High Availability (ROADMAP #27, SPEC §12.8)

How Potion behaves when pieces of the deployment die, and how to run it
horizontally scaled.

## Architecture

```
            ┌────────┐   round-robin   ┌────────────┐
  clients ─▶│ nginx  │ ──────────────▶ │ server-a   │──┐
            │ :3000  │ ──────────────▶ │ server-b   │──┤ stateless replicas
            └────────┘                  └────────────┘  │
                                       postgres (pgvector)  ◀── shared, node-pg pool
                                       redis (pub/sub + queue) ◀── shared, optional
```

> ## ⛔ Do not deploy multiple replicas yet
>
> The sentence below — "the only cross-request in-memory state that matters
> for correctness" — is **not true today**, and this note exists so the two
> documents cannot drift into disagreeing. The rate limiter's token buckets
> and daily caps are also cross-request in-memory state that matters for
> correctness, and `InMemoryRateLimiterStore` is the ONLY implementation of
> the store seam: it is what production runs, not a test stand-in. At N
> replicas a key's rate AND daily cap are both N×, and a rollout resets every
> bucket. Filed as **F18** with a reproducing test.
>
> (The `/readyz` example further down showing an **open circuit breaker** used
> to be unreachable for the same reason — `factory.ts` called `resilient(p)`
> with no policy. **F19 fixed that**: `DEFAULT_BREAKER` is wired in, so that
> example is now a state the system can actually be in. Hedging remains off
> deliberately — see `docs/driver-semantics.md` row 4.)
>
> Until G2.5 lands, deploy ONE replica:
> [DEPLOY-RUNBOOK.md](DEPLOY-RUNBOOK.md), and see
> [driver-semantics.md](driver-semantics.md) rows 4 and 6.

Server replicas are **stateless**: all durable state lives in Postgres, and
the only cross-request in-memory state that matters for correctness — the
per-org `providersForOrg` BYOK cache — is kept coherent across replicas by
redis pub/sub invalidation (channel `potion:invalidate:keys`). That makes
horizontal scaling `N` replicas a compose/edit away.

## Probes

| Probe      | Meaning      | Checks                                                                 |
| ---------- | ------------ | ---------------------------------------------------------------------- |
| `/healthz` | process up   | nothing — static payload (embedder identity, prices version)           |
| `/readyz`  | can serve    | db ping (`SELECT 1`, 2s timeout) + queue ping (memory: always ok; bullmq: redis round-trip probe) + circuit-breaker summary |

`/readyz` returns **503 with per-check detail** when any dependency fails:

```json
{
  "ok": false,
  "checks": {
    "db": { "ok": false, "driver": "node-postgres", "detail": "timeout after 2000ms" },
    "queue": { "ok": true, "driver": "memory" }
  },
  "breakers": { "openai:gpt-frontier-class": "open" }
}
```

Point your load balancer's readiness/health gate at `/readyz`; keep
`/healthz` for liveness-only checks. The compose healthcheck uses `/readyz`.

## Graceful shutdown

`SIGTERM`/`SIGINT` (what Kubernetes, `docker stop`, and systemd send):

1. **Stop accepting** new connections (`app.close()`); idle keep-alive
   sockets are closed immediately.
2. **Drain in-flight requests** — Fastify awaits them; responses complete
   normally. Cap: **30s** (`SHUTDOWN_TIMEOUT_MS`).
3. **Close handles**: queue (`close()`), db pool, observability SDK, redis
   pub/sub connections.
4. `exit(0)` on a clean drain; **`exit(1)`** if the 30s cap is exceeded or
   the drain itself fails (the orchestrator reaps the container either way).
5. A second signal during the drain is logged and **ignored** — the drain
   is already bounded by the cap.

## Failure modes

### Instance killed (one replica dies)

- In-flight requests on that replica die with it; the client (or nginx on
  `proxy_next_upstream` if configured) retries against the peer.
- The surviving replica keeps serving at full capability — replicas share
  nothing in-process.
- Orchestrator restarts the killed replica; `/readyz` gates re-entry into
  rotation (compose healthcheck → `unhealthy` until db + queue ping pass).

### Postgres down

- `/readyz` → **503** (`checks.db.ok: false` + detail) within ~2s, so the
  replica leaves rotation instead of black-holing traffic.
- Serving endpoints fail fast on query errors (typed errors per the §12.1
  resilience layer); nothing is written partially.
- At **boot**, the node-pg path retries the initial connect **3 times with
  exponential backoff** on transient errors (ECONNREFUSED, timeouts, sqlstate
  08xxx/57P0x), then throws a typed `DbConnectError` — the container crash-
  loops until postgres is back, which compose's `depends_on: service_healthy`
  usually prevents anyway.
- Pool sizing/timeouts are env-tunable: `PG_POOL_MAX` (10),
  `PG_IDLE_TIMEOUT_MS` (30000), `PG_CONN_TIMEOUT_MS` (5000).

### Redis down

- **Cache invalidation degrades, nothing crashes.** The invalidator is an
  optional dependency: `ioredis` is lazy-imported only when `REDIS_URL` is
  set; if redis/ioredis is unavailable the instance boots in **memory-only
  mode** — exactly the pre-HA behavior (local bust + **60s TTL**).
- Consequence: a key create/rotate/revoke on replica A busts A's cache
  immediately; replica B converges within the 60s TTL instead of sub-second.
  **Worst-case staleness window: 60s.**
- Publish failures at runtime are logged and swallowed — key-lifecycle
  requests never fail because a cache fan-out did.
- Future bullmq queue driver (`#28`): `/readyz` reports
  `checks.queue.ok: false` → 503 when its redis probe fails.

### Provider circuit breakers

`/readyz` always carries the `breakers` map from `@potion/providers` (empty
object = all closed). An **open breaker does NOT fail readiness** — the
instance still serves via §12.1 fallback chains; the map is operator signal
for provider-side degradation, surfaced per `provider:model` key.

## Deploy guide (docker-compose.ha.yml)

```bash
export POTION_MASTER_KEY=$(openssl rand -hex 32)   # 64 hex; custody master key
docker compose -f docker-compose.ha.yml up --build
# entry point: http://localhost:3000  (nginx → server-a / server-b)
```

- Replicas build from the repo `Dockerfile` (pnpm workspace build →
  `node apps/server/dist/index.js`, `NODE_ENV=production`).
- `DATABASE_URL` / `REDIS_URL` point at the shared compose services; both
  are required in this topology (PGlite is dev-only — see below).
- Scale out: `docker compose -f docker-compose.ha.yml up --scale server-a=2 …`
  or add another replica service + upstream entry in `deploy/nginx.conf`.
- Healthchecks on the replicas hit `/readyz`; postgres/redis healthchecks
  gate replica start (`depends_on: service_healthy`).

## Capacity notes

- **Stateless serving → horizontal scale.** CPU (embedding + provider
  fan-out) is the binding constraint per replica; add replicas linearly.
  The 60s provider-cache TTL bounds decrypt/audit volume per org.
- The pg pool defaults (10 conns/replica) mean `N` replicas open `10N`
  connections — size `max_connections` accordingly or lower `PG_POOL_MAX`.
- **PGlite is single-node dev only.** It is an in-process embedded Postgres:
  no replica can share it, no concurrent writer, no network protocol. Any
  multi-instance deployment MUST use `DATABASE_URL` (node-pg) + `REDIS_URL`.
- nginx round-robin is connection-level and stateless — safe for the API,
  which has no session affinity (auth is bearer/session-token, verified
  against the shared db on every request).
