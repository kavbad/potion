# Deploy plan — 13a executed for the serving product

**Derived from `docs/specs/step-13a-deploy.md` (2026-08-15) on 2026-08-20.**
The spec is binding for everything it covers — vendors (§1), env values (§3),
the seven container/TLS rehearsals (§4), the live budget-kill re-proof (§5),
the ≤$1 live cap (§6), the status doc (§8). This plan does two things the
spec cannot: **sequences the work**, and **applies the serving-product pivot**
that happened after the spec was written. Deltas are listed first because
they are the part that would silently bite.

**DoD, restated for the partner era:** a design partner can be onboarded by
the operator, sign in at `https://app.<domain>`, mint a serving key in the
dashboard, send an OpenAI-compatible request to `https://api.<domain>/v1`
from their own machine, see the `x-frontier-trace` receipt, and watch the
request appear on Connect — with a budget that provably kills spend at its
cap. TLS real, `/readyz` green, `/metrics` 403 or absent, self-serve off.

---

## 0. Pivot deltas (build items the spec does not contain)

| # | Delta | Why now |
|---|---|---|
| D1 | **`dashboard` compose service.** New Dockerfile stage building `apps/dashboard` (`next build`, standalone output), service on the compose network with `POTION_API_URL=http://server:3000`. | The compose ships redis+server+caddy only. Every partner-facing surface — landing `/home`, `/docs`, keys UI, usage, `/build` — lives in the dashboard. Without D1 the deploy has an API and no product. |
| D2 | **Two vhosts in the Caddyfile.** `api.<domain>` → `server:3000` (carrying the `/metrics` 403 block); `app.<domain>` → `dashboard:3001`. Two A records. `POTION_PUBLIC_URL=https://api.<domain>`. | Browser traffic must hit the dashboard (its `/api/*` route handlers proxy to the server with the session cookie); SDK traffic must hit the server directly with Bearer keys. Path-splitting one host confuses the two `/api/*` namespaces — hosts split them cleanly, and the docs' Base URL stays honest. |
| D3 | **BYOK is gone.** Onboarding runbook's BYOK step is deleted; the platform `OPENROUTER_API_KEY` serves all orgs; every partner org gets a budget row (`hardStop: true`) at creation, and the platform caps (`POTION_PLATFORM_ORG_CAP_USD`, default $10) stay on. | Operator decision 2026-08-17. The spec's §7 step 3 still says "→ BYOK →". |
| D4 | **Partner journey replaces the Lab harness as the DoD walkthrough** (spec §7 item 4). The Lab is paused; `POTION_SERVING_URL` still gets wired (spec §2 gap 1 — cheap, and 13c wants it) but a `lab:run` is no longer the proof. | The proof must be the thing the partner will do. |
| D5 | **Magic-link posture:** `POTION_MAGIC_LINK_IN_RESPONSE` stays **unset** in prod. Operator mints the partner's first link per `ONBOARDING-RUNBOOK.md` and hand-delivers it. No email vendor in scope. | The inline-link convenience is the any-email session-mint hole; it exists for the laptop, never for a URL a stranger can reach. |
| D6 | **Sentry init (spec §1.6) covers the server process only.** Dashboard error reporting is a recorded residual, not scope. | One wiring point, in-process worker included. |

Cost impact of the deltas: **$0** — the dashboard rides the same CX22; a
second A record is free; everything else is configuration.

## 1. Sequence

**Phase A — operator provisioning (parallel with B; ~an hour of clicking).**
Spec §3.1 verbatim, with one change: **two** A records (`api.`, `app.`) both
DNS-only. Produce `.env.prod` per spec §3.2 plus the D1–D5 values
(`POTION_PUBLIC_URL=https://api.<domain>`, dashboard vars). Generate and
separately back up `POTION_MASTER_KEY` (spec §3.2 warning stands).

**Phase B — build deltas on this machine (a day).**
1. Dashboard Dockerfile stage + compose service + healthcheck (D1).
2. Caddyfile two-vhost rewrite, `/metrics` 403 preserved on `api.` (D2).
3. Env wiring: `POTION_SERVING_URL`, `POTION_PUBLIC_URL` into compose +
   `.env.example` (spec §2 gaps 1–2); `SENTRY_DSN` + the no-op-when-unset
   init with its test (spec §1.6, §10).
4. Runbook surgery: BYOK step out of `ONBOARDING-RUNBOOK.md` (D3); the wrong
   `READYZ_DB_TIMEOUT_MS` line out of `DEPLOY-RUNBOOK.md` (spec §2).
5. Local verify unfiltered: build, typecheck, lint, test (spec §10).

**Phase C — host bring-up (half a day).**
Postgres preflight (spec §3.3, `rehearse-postgres` 9/9) → compose up → the
**seven rehearsal items** (spec §4) with evidence captured verbatim, now
across BOTH vhosts (TLS issuance ×2, redirect ×2, `/metrics` on `api.` only).

**Phase D — the partner walkthrough + proofs (half a day).**
1. Operator onboards a **rehearsal org** through the deployed path
   (runbook, post-D3: create org → hand-delivered link → sign in at `app.` →
   policy + serving key in the UI).
2. From a machine that is not the server: OpenAI SDK against
   `https://api.<domain>/v1` → 200, `x-frontier-trace` present, request on
   Connect's routing-activity, usage visible.
3. The three coverage cases (any-partner readiness): one well-covered
   workload, one marginal, one uncovered — the uncovered one must show
   `fallback=1` honesty, not a pretend route.
4. **Budget mid-run kill re-proof on live pricing** (spec §5 verbatim,
   ≤$1 under `KEY_RISK_ACCEPTED`, ledgered before/after; fail-open-on-db-error
   residual recorded, not covered).
5. Write `docs/DEPLOY-STATUS.md` (spec §8) + standing residuals: F18 single
   replica, F19, F13, budget fail-open, dashboard-Sentry (D6), in-process
   worker head-of-line (spec §9).

## 2. The bill (spec §1.7, unchanged by the deltas)

~$11–25/mo + domain: Hetzner CX22 ~$5, Render Postgres Basic $6–19, the rest
$0-tier. Neon-always-on remains the argued-against ~$76 comparison.

## 3. Out of scope, named

Payments/credits, abuse controls, `POTION_SELF_SERVE=1` (all 13b); email
delivery vendor (D5 defers it); HA/multi-replica (F18 stands); the Lab ladder.
G8 resolution and the multi-turn cluster run **in parallel** as P1s — they are
readiness work, not deploy work (see the partner-readiness priorities,
2026-08-20).
