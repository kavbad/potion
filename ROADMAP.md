# Potion — Production Roadmap (v1.2)

Status legend: ✅ done · 🚧 in flight · ⬜ pending
User-action legend: 🧑 = needs the operator (key, account, or local run)

## M1a — Evidence integrity ✅ (2026-08-04)
1–12. Provenance end-to-end, serve guard, staleness engine, mock quarantine, suite v2 manifests, benchmarks, embedding canonicalization, dataset audit, judge spend accounting, walkthrough, ledger. See tasks/todo.md.

## M1b — Real numbers ⬜ (operator-run package)
- 🧑 Gate-3 live rerun on v2 suites (`--cap 25`) — docs/M1B-RUNBOOK.md
- 🧑 Gate-2 rerun on OpenAI embeddings (needs OPENAI_API_KEY locally)
- 🧑 10-cluster frontier sweeps (`--cap 15`)
- Orchestrator: analysis + frontier publication + ledger reconciliation ($50 hard cap; used $0.00001146)

## M2 — Safe to sell ✅ (2026-08-05)
13. Tenant model ✅ 14. Auth (magic-link/RBAC) ✅ 15/16. Key lifecycle + AES-256-GCM custody ✅ 17/18. Rate limits + metering + invoicing ✅ 19. Security pack ✅ 20. Legal templates ✅
Proofs: 464 tests, walkthrough 10/10. See tasks/todo.md → M2 Gate Proofs.

## M3 — Production-grade 🚧
- ⬜ 21. **Shadow mode + savings report**: sampled live traffic re-scored against frontier candidates; per-org "you saved $X / could save $Y" report + dashboard page.
- ⬜ 22. **Quality guarantee + auto-rollback**: live judge sampling; if rolling quality < guarantee, operating point auto-rolls back and an incident is emitted.
- ⬜ 23. **Composite streaming**: 7th strategy type — start cheap, upgrade mid-stream on low confidence; SSE relay with token-prefix continuity.
- ⬜ 24. **Provider resilience**: retry/backoff/jitter, per-model circuit breakers, hedged requests, failover chains, error taxonomy.
- ⬜ 25. **OpenAI parity**: /v1/models, /v1/embeddings, /v1/completions, tool calling, streaming usage chunks, error-shape parity — drop-in replacement.
- ⬜ 26. **Observability**: OTel traces (optional), Prometheus /metrics, structured logs with request-id, frontier-decision spans.
- ⬜ 27. **HA**: graceful shutdown, /readyz, pg pool + retry, cross-instance cache invalidation, 2-replica reference deploy.
- ⬜ 28. **Real queue + workers + artifacts**: BullMQ driver, worker runtime (eval/sweep/staleness jobs), S3/MinIO artifact store.
- ⬜ 29. **CI/CD + chaos**: GitHub Actions (build/test/audit-gate/SBOM), deploy skeleton, chaos suite; folds in M2 audit re-triage (next/drizzle bumps) + tenant pen-test hardening.

## M4 — Wildfire ✅ (complete 2026-08-06 — 811 tests, walkthrough 13/13, audit PASS)
- ✅ 30. **SDKs**: Python + TypeScript, thin over OpenAI client, per-request policy hints (`X-Potion-Policy`), savings fields in responses. (sdks/python `potion-ai` + sdks/typescript `@potion/sdk`; FrontierTrace header parser; typed errors incl. BudgetExceededError)
- ✅ 31. **Playground + sharing**: in-dashboard playground across frontier points; shareable read-only frontier & savings-report links (viral loop). (SSE streaming proxy, compare mode, masked share tokens, real 404 post-revoke)
- 🔗 32. **Public leaderboard**: verified live frontiers per task cluster, reproducible — the proof engine. **Moved to M4b: rides with #37 as the public face of the recipe library.**
- ✅ 33. **Alerts & integrations**: Slack/email/webhook routing for incidents, rollback events, budget anomalies. (masked webhook URLs, test endpoint with shape parity, breaker-open alerts edge-deduped)
- ✅ 34. **Enterprise**: SSO/SAML, audit-log export, SCIM provisioning. 🧑 (OIDC done — PKCE-S256 + RS256 JWKS, magic-link parity; unified audit trail custody+auth + JSONL export; SAML/SCIM deferred w/ reserved paths — docs/ENTERPRISE.md)
- ✅ 35. **Budget autopilot**: org-level budgets with hard-stop, anomaly detection, forecast. (chat-path 429 hard stop, forecast-vs-cap warn state, nightly sweep + budget events)

## M4b — Autoresearcher ✅ (complete 2026-08-06 — 865 tests, walkthrough 14/14, audit PASS)
- ✅ 37. **Autoresearcher**: candidate generator (template grammar × class-pruned registry, ≤20/cycle, cache-pruned), new-model detection (research:scan — OpenRouter /models diff, nightly), budget-capped research cycles (research:cycle, $5 live cap/cycle, own ledger on research_cycles.spend_usd), paired-bootstrap heldout promotion gate (live-evidence-gated, seeded, IEEE754-hardened), recipe library + /recipes + /api/recipes. Migration 0014_research; packages/researcher (26 tests).
- ✅ 32. **Public leaderboard**: /api/leaderboard (auth-exempt) + dashboard /leaderboard — live-verified frontier recipes only, verification-run provenance per entry, org opt-in adoption list, honest `awaiting_live_verification` state pre-M1b. Simulated evidence never appears.

## M5 — Agent workloads ✅ (complete 2026-08-06 — 886 tests, walkthrough 15/15, audit PASS)
- ✅ 36. **Agent traces**: POST /v1/traces idempotent batch ingest (OTel GenAI subset, UNIQUE(org,trace,span), ingest-time pricing alias+model-id), session rollup with loop signals (same tool-call signature ≥3×) + per-span cost-attribution waterfall, retention policy (0 = metadata-only redaction, N = nightly delete, org-scoped purge), traces:cluster worker (redact-first → embed → tool-signature buckets → greedy cosine agent-<slug> clusters → synthesized redacted replay suites with version bumps → mock sweep → first frontier; idempotent re-runs), X-Potion-Cluster chat hint (explicit, 400 unknown — never silent), /api/frontiers merges db-registered agent clusters beyond the static taxonomy, dashboard /traces (rollup + LOOP/METADATA-ONLY badges + waterfall + agent-cluster frontier links + admin cluster/retention islands). Migration 0015_traces. Highest-value workload class.

---
Spend discipline: all live calls budget-capped through the harness; ledger in tasks/todo.md. OpenRouter key in gitignored `.env` only; revoke after M1b.
