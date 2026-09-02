# Potion — Production Roadmap (v1.3)

Status legend: ✅ done · 🚧 in flight · ⬜ pending
User-action legend: 🧑 = needs the operator (key, account, or local run)

> Ledger reconciled 2026-09-01. STATE.md wins on any disagreement; per-item
> proofs live in tasks/todo.md.

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

## M3 — Production-grade ✅ (reconciled 2026-09-01 — this section had gone stale as ⬜ while every item shipped; per-item proofs in tasks/todo.md)
- ✅ 21. **Shadow mode + savings report** — and, 2026-09-01, the judge became REAL: candidates are scored in-process by the serve judge (one scale with quality_samples; the Jaccard scorer and the text-bearing queue leg are retired — 5b42bba).
- ✅ 22. **Quality guarantee + auto-rollback** (live judge sampling, keyed windows, incidents, rollback precedence).
- ✅ 23. **Composite streaming** (SSE relay, `x-latency-contract: non-streamed` fallback for non-streamable combinations).
- ✅ 24. **Provider resilience** (resilient wrapper, breakers + breaker-open alerts, failover).
- ✅ 25. **OpenAI parity** (/v1/models, /v1/embeddings, /v1/completions, tools, streaming usage, error shapes).
- ✅ 26. **Observability** (Prometheus /metrics, frontier-decision observations, structured logs).
- ✅ 27. **HA** (graceful shutdown, /readyz, 2-replica reference deploy — docker-compose.ha.yml).
- ✅ 28. **Real queue + workers + artifacts** (queue driver + worker runtime + artifact store; jobs ledgered).
- ✅ 29. **CI/CD + chaos** (GitHub Actions build/test/audit-gate, chaos suite).

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

## G — Core-API evidence ladder (adopted 2026-08-31 from the external review, verified claim-by-claim; the critical path is: outcomes → customer evidence → customer frontier → generations → shadow proof → promotion → verified savings. Protect the sequence.)

### G0 — Correctness + honesty ✅ (complete 2026-09-01)
- ✅ **The measured floor is the written floor** end-to-end: propose AND apply, FloorBody `.min(0)`, 0.38 chain integration-tested (49f675f, f5b100c).
- ✅ **ONE RESOLVER**: the serve chain (`servingDecisionFor`) lives in @potion/pareto; the compiler, the learning period and the serve path share it — the learning bypass (cluster floors ignored, max_quality→0.95, INVERTED infeasible fallback) is dead (cae78d4).
- ✅ **Floors are promises**: feasibility gates on the Jeffreys lower bound at every site; rankings stay mean-based (3949947).
- ✅ **The receipt names the version that served**: `request_logs.router_version` stamped at serve time on exact content match + `;router=vN` trace token; reconstruction demoted to pre-stamp backfill (3709743).
- ✅ **Prod research measures the real world**: `POTION_RESEARCH_PROVIDER=live` in prod compose (06f5395).
- ✅ **Copy tells the truth**: landing bullet ("combinations nobody else has" / "measured on release") corrected; README names the Chat-Completions surface + the /responses AI-SDK trap (442e5b5).
- 🧑 Remaining copy calls (operator): savings "verified" wording · hero "cuts your AI bill in half" / "49%" · "small, redacted" phrasing.

### G1 — Customer evidence 🚧
- ✅ **Shadow judge**: candidates judge-scored in-process by the serve judge — one scale with quality_samples, spend metered, no text on the queue (5b42bba).
- ✅ **Shadow → org evidence**: the router artifact carries "on your traffic" evidence per assignment — Jeffreys intervals, measured-vs-measured costs, lower-bound-gated challenger `qualifies`; read-only, never mints a version (3528019).
- ✅ **Outcome API** (10d7876, SPEC §16): `POST /v1/outcomes` + SDK one-liners — success/score/validator/label/human per completion id, STRICT body, attribution at ingest, append-only latest-signal-wins; 'customer-outcomes' evidence (Jeffreys intervals) rides the router artifact as "your app's verdicts". Observational by contract — the holdout stays the causal instrument.
- ✅ **Full-request eval capture**: the sampler keeps the WHOLE served conversation (system + turns, redacted, parts stripped) + structural facts (tool count, response_format); derived items carry it; over-cap requests are excluded ('too-large'), never truncated into a different task; tool/attachment spans captured as metadata and excluded from suites with a named count. Follow-ups: excluded spans still occupy the sampling cap; response_format not yet enforced at replay.
- ✅ **Challenger promotion proposal**: a shadow-qualified challenger rides the learning period's suite run (measured beside serving, one instrument); retention lower bound ≥ floor mints a `challenger_proposals` row; one-button apply mints the ORG frontier from the same measurements — routing changes through the measured field under the lower-bound selection law, never by fiat. Card on the router page.
- ✅ **Randomized incumbent holdout** (0086): consent-gated (default off, rate ≤5%, slice always visible on Savings), the serve path swaps a randomized slice to the NAMED incumbent (pin outranks; default instrument only; never a mock baseline under live; labeled `;holdout=1` + ledger column; baseline NULL, router_version NULL). The Savings page's "Verified savings" block is the only place the product says verified: measured incumbent mean × routed count vs measured routed spend, seeded-bootstrap CI, the LOWER bound named as the billing basis. ✅ **Invoice basis swapped**: the savings share bills 25% of the holdout-verified LOWER bound only (one `savingsShareLine`; the estimated counterfactual renders as "projected — not billed" context; no live baseline → pure at-cost). Charging stays OFF until the operator's Stripe sitting — the first real invoice will already be honest.

### G2 — Customer frontiers 🚧
- ✅ **Org workload discovery** (0087): the org's consented samples are clustered WITHIN each serving cluster (the traces:cluster recipe on the serve path's own classification text) into `org_workloads` — observed structure only, snapshot per run, medoid exemplars (never fabricated names), cohesion shown, refreshed after each learning period + on demand. Renders on the router page as "what your traffic actually is · not yet routed".
- ⬜ Discovered-workload adoption: derived suites + measurement per discovered workload → explicit routing proposals (never silent) → org frontiers per adopted workload → router generations with shadow/canary/promote/rollback.

---
Spend discipline: all live calls budget-capped through the harness; ledger in tasks/todo.md. OpenRouter key in gitignored `.env` only; revoke after M1b.
