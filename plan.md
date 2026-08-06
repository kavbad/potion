# Plan — Complete the Roadmap (M3 → M5)

Directive (user, 2026-08-05): "proceed. go until the entire roadmap is complete."

## Stage 0 — Foundations (orchestrator, this session)
1. Commit `ROADMAP.md` — M3 items #21–#29 verbatim as established; M4 #30–#35 and M5 #36 reconstructed (flagged v1.2).
2. Extend `SPEC.md` with M3 interface contracts (§10) — resilience policy, queue/workers/artifact store, observability, shadow/savings, guarantee/rollback, composite streaming, OpenAI parity, HA, CI/chaos.
3. Commit M2 audit re-triage is folded into #29.

## Stage M3 — Production-grade (waves, stage-gated)

**Wave 1 — parallel foundations (disjoint packages)**
- `m3-resilience` (#24): packages/providers — retry/backoff/jitter, circuit breaker, hedged calls, failover chains, error taxonomy, chaos mock.
- `m3-queue-workers` (#28): packages/queue BullMQ driver + packages/workers + ArtifactStore (Local/S3-MinIO) + server enqueue endpoints.
- `m3-observability` (#26): packages/observability — OTel (optional), Prometheus /metrics, pino structured logs, request-id.

Gate: each merged only when build+typecheck+lint+full tests green on integrated tree.

**Wave 2 — parallel, depends on W1**
- `m3-shadow` (#21): shadow serving + shadow_results + savings report API + dashboard page (uses #24, #26; queue hook for #28).
- `m3-openai-parity` (#25): /v1/models, /v1/embeddings, /v1/completions, tool-calling passthrough, error-shape parity, contract tests.
- `m3-ha` (#27): graceful shutdown, /readyz, pg pool, redis pub/sub cache invalidation, 2-replica compose + docs/HA.md (uses #26, #28).

**Wave 3 — parallel, depends on W2**
- `m3-guarantee` (#22): live quality sampling, guarantee policy, auto-rollback + incidents (uses #21, #26).
- `m3-composite` (#23): composite streaming strategy (7th StrategyConfig type) + SSE relay (uses #24).
- `m3-cicd-chaos` (#29): GitHub Actions CI/CD, chaos test suite, M2 audit re-triage (next/drizzle bumps), tenant pen-test hardening.

## Stage M4 — Wildfire (per ROADMAP.md #30–#35)
SDKs → playground/sharing → public leaderboard → alerts/integrations → enterprise SSO → budget autopilot. Wave split decided at M3 completion based on dep graph.

## Stage M4b — Autoresearcher (#37 + #32, user-directed 2026-08-05)
Dispatch AFTER M4 Wave 1 merges, BEFORE M5. Contracts SPEC §15. packages/researcher + workers jobs + migration 0013 + /recipes + /leaderboard.

## Stage M5 — Agent workloads (#36)
Trace ingestion (OTel GenAI conventions) → agent-session clustering → frontier optimization for traces → per-trace cost attribution.

## Working rules (inherited)
- Mock-first; live validation via operator runbook. $50 cap ledger untouched.
- `.env` never committed; key never printed.
- Master stays green after every merge: build + typecheck + lint + full test suite.
- /mnt-safe merge method: integrate in $HOME worktree → `git update-ref` + temp-index repair.
- SPEC contracts are sacred; agents update their SPEC section on-branch.
