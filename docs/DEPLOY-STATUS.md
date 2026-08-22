# Deploy status — 2026-08-21/22

**Verdict: partner-ready, with three stated residuals.** Every step a design
partner will take was executed against the production deployment from a
machine that is not the server, and the budget kill-switch was re-proven live
under a ≤$1 cap. The rehearsal found three partner-blocking bugs and one
material weakness; all four are fixed and redeployed.

## The deployment

| | |
|---|---|
| Host | Hetzner CX23, Falkenstein (eu-central), Ubuntu 26.04 LTS, 2 vCPU / 3.7 GiB / 38 GB |
| Services | `docker compose`: redis · server (Fastify) · dashboard (Next) · caddy — single replica (F18) |
| Database | Render Postgres 17, Frankfurt, Basic plan, `sslmode=require`; 52 tables; 10 platform frontiers imported at first boot |
| DNS | `api.` `app.` `@` `www` → 178.105.98.174 (GoDaddy, TTL 600) |
| TLS | Let's Encrypt on all four names, valid to 2026-11-20; http → https 308 |
| Error reporting | Sentry, server process only (deploy plan D6) |
| Price table | `POTION_PRICES_PATH=/app/.tranche/prices.json` — the table the committed frontiers were measured against |
| Self-serve | off (`POTION_SELF_SERVE` unset, `POTION_MAGIC_LINK_IN_RESPONSE` unset) |
| Research store | off-laptop copy at `/opt/potion/research-backup/` (sha256 verified) |

## Phase C — the seven rehearsals (spec §4), across both vhosts

| # | Item | Evidence |
|---|---|---|
| 1 | Image build | Succeeded after `scripts/build-ordered.mjs` (runtime-dependency order; the Lab's dev-only cycles broke a clean build) |
| 2 | TLS issuance ×2 (+ apex, www) | `ssl_verify_result 0` on api./app./withpotion.com/www; issuer Let's Encrypt |
| 3 | http → https ×2 | `308` on all four names |
| 4 | `/readyz` | `200 {"ok":true,"checks":{"db":{"ok":true,"latencyMs":10},"queue":{"ok":true}}}` |
| 5 | `/metrics` on `api.` | **403** ("not available on the public listener") — the load-bearing check |
| 6 | Unauthenticated `/v1` | `401` with no key, `401` with a bad key |
| 7 | Server publishes no ports | only caddy binds 80/443; `ufw` deny-in default (22/80/443 allowed) |

## Phase D — the partner walkthrough, from this laptop

1. **Org created** through `POST /operator/orgs` → 201 with a magic link.
2. **Signed in** via the link → `307 → https://app.withpotion.com/`, session cookie set (httpOnly, secure), `GET /api/auth/me → 200`, role `admin`.
3. **Policy + key** in one call: `POST /api/policies {min_cost, qualityFloor 0.85, createKey}` → 201, `pk_…` (scope `serve`).
4. **Real request** (OpenAI-compatible, from the laptop):
   `200` in 3.8 s, correct answer, receipt
   `x-frontier-trace: cluster=classification;strategy=220a2558;frontier=v4;policy=min_cost;fallback=0;provenance=live`
5. **Coverage cases**: code-gen → `200` (strategy 220a2558, 14.6 s — consistent with its measured p95); creative → `200` routed to `or-sonnet` at full price (the honest "nothing cheaper qualifies" case); a yes/no reasoning prompt classified as classification → `200`.
6. **Metering**: `GET /api/usage/current` → 4 requests, $0.0016 cost against a $0.0313 "best model for everything" baseline (95% saving on this traffic). Daily rollups populate via `POST /api/usage/aggregate`.
7. **Budget kill re-proof** (spec §5/§6): cap set to **$0.01, hardStop** via `PUT /api/budgets`. 16 cheap requests reached 31% of cap; full-price requests crossed it at #5 (`state: exceeded`). The next request after the verdict-cache window → **`429 budget_exceeded`**: *"monthly budget cap reached (hard stop): MTD $0.02 ≥ cap $0.01"*, one `budget_events` row. Total rehearsal spend ≈ $0.02.

## What the rehearsal caught (all fixed, on `main`, redeployed)

1. **Magic link pointed at the API host over plain http.** The operator route built it from the raw request; partners sign in on `app.`. Now `POTION_APP_URL/api/auth/verify`.
2. **Post-verify redirect went to `localhost:3001`.** The dashboard used the container's own URL. Now the configured public origin (forwarded headers as fallback); cookie marked `secure` over https.
3. **Production served from the pre-tranche price table.** Routing chose the measured models; the provider layer didn't know them → `503 unknown model`. Now `POTION_PRICES_PATH` points at the measured table. *Rule going forward: a baseline republish and the serving price table move together.*
4. **Hard-stop verdict cached 60 s** → a burst overshot the cap by ~3 full-price requests. Now 5 s.

## Residuals (stated, not hidden)

- **Overshoot bound**: up to 5 s of traffic past an exceeded cap (one cheap query per org per 5 s). On the cheapest routes that is fractions of a cent; on full-price routes, a few cents per second of burst.
- **Dashboard error reporting** is not wired (server only — D6).
- **No email**: magic links are hand-delivered by the operator (D5, by design).
- **Orgs without a budget row** are bounded by the platform default cap ($10/month, fail-closed); the onboarding runbook should tell the operator to set the partner's own cap at step 2.
- **Single replica**: resize the server before scaling out; two replicas would need a redesign of budget/state ownership (F18).

## Operate it

- Bring-up / upgrade: `docs/DEPLOY-RUNBOOK.md` · onboarding: `docs/ONBOARDING-RUNBOOK.md`
- Deploy from the laptop: `rsync` the tree to `/opt/potion/app`, then `docker compose -f deploy/docker-compose.prod.yml --env-file .env.prod build && … up -d` (≈5 min).
- Secrets: `/opt/potion/.env.prod` (0600) and the laptop's `.env.prod`; the master key is additionally stored off both machines.
