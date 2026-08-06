# tests/chaos — fault-injection tests (ROADMAP #29, SPEC §12.9)

Why a separate workspace package instead of `apps/server/test`: the four
chaos scenarios span THREE layers — the eval harness (`@potion/harness`,
db killed mid-eval), the queue (`@potion/queue`, redis down), and the server
(`@potion/server`, shadow instance kill, `/readyz` breaker reflection). A
root-level package imports all of them as built workspace deps, keeps
`apps/server/test` focused on route behavior, and is picked up automatically
by the root `pnpm test` / `pnpm -r typecheck` (via `tests/*` in
pnpm-workspace.yaml). CI runs it as part of the standard test step.

Scenarios (true behavior is documented in each file header):

| file | fault | contract proven |
| --- | --- | --- |
| `src/db-killed-mid-eval.test.ts` | PGlite closed mid-`runEval` | typed `DrizzleQueryError` (cause: "PGlite is closing/closed"); partial rows = completed items only (no run transaction); `resume` re-run on the same data dir is idempotent (content-addressed cacheKey, zero duplicates) |
| `src/redis-down.test.ts` | `redis://localhost:1` | bullmq `enqueue`/`getJob` → typed `QueueUnavailableError` with credential-redacted URL; `QUEUE_DRIVER=memory` wins over a dead `REDIS_URL` (documented precedence) and the server boots/serves |
| `src/shadow-instance-kill.test.ts` | candidate provider dead (`failRate=1`) and frozen (`hangMs`) | primary responds within SLO (shadow is fire-and-forget after the response); shadow failure swallowed (warn/metric only, no row); server stays healthy |
| `src/breaker-exhaustion.test.ts` | `chaosProvider(failRate=1)` behind `resilient()` | breaker opens after `failureThreshold` failed attempts; requests fail fast (elapsed << retry budget); `breakerStates()` reports open and `/readyz` reflects it |
