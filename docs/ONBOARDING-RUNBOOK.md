# Operator Onboarding Runbook (G2.7)

Create a partner org, hand them a policy-bound serving key, invoice them monthly, and
— when the relationship ends — erase everything they ever derived. Every step is a
copy-paste shell block against a running `apps/server`.

## 0. Prerequisites (5 min)

- `DATABASE_URL` pointing at the production database (PGlite dir or Postgres).
- `POTION_OPERATOR_TOKEN` set in the server's environment. **Fail-closed**: when this
  variable is unset, the `/operator/*` surface does not exist — every call 401s.
  Pick a long random value; it is compared timing-safely.
- Self-serve signup is OFF in production by default (`POTION_SELF_SERVE` unset +
  dev bypass off): unknown emails get a neutral response and no org. Operator
  onboarding — this runbook — is the only way a partner org comes into being.

```bash
export POTION_API=https://your-potion-host
export POTION_OPERATOR_TOKEN=op_...   # the server's configured value
```

## 1. Create the org (1 min)

```bash
curl -s -X POST "$POTION_API/operator/orgs" \
  -H "Authorization: Bearer $POTION_OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"id": "org-acme", "name": "Acme Corp", "adminEmail": "platform@acme.com"}'
```

The 201 response carries `magicLink` — **hand-deliver it to the partner admin**
(SMTP is deliberately absent; the link is single-use and expires in 15 minutes, so
send it when they're ready to click). The link signs them into their org as admin.

## 2. Policy + serving key in one call (1 min)

The partner admin (or you, via their session) creates the policy and a bound key in
one request:

```bash
curl -s -X POST "$POTION_API/api/policies" \
  -H "Cookie: potion_session=<their session>" \
  -H "Content-Type: application/json" \
  -d '{"policy": {"type": "min_cost", "qualityFloor": 0.85}, "name": "prod", "createKey": true}'
```

The response returns the raw `pk_...` key **exactly once**. Scopes (ENFORCED since
G2.3): keys default to the `serve` scope — serving, org reads, and self-service
policy/workload operations, at **member grade**. Admin mutations (incident resolve,
incumbent designation, budgets, alert rules, rubric/research/trace ops, live
sweeps) require a **`serve+admin`** key — mint one deliberately via
`POST /api/api-keys {"name": "...", "scopes": "serve+admin"}` when the partner's
automation genuinely needs it. Unknown scope values fail closed to serve-only.

## 3. BYOK provider key (optional, 1 min)

If the partner brings their own provider key, they POST it to `/api/keys` (custody:
envelope-encrypted at rest, every decrypt audited). Otherwise serving uses platform
env keys and their usage is invoiced.

## 3b. Ingest the partner's real traffic (G2.8)

The guarantee is built from the partner's OWN workload, so onboarding is not
finished until their traffic is in. `POST /v1/traces` takes SPEC §14.1 spans;
the partner needs an adapter from whatever their agent already emits.

`scripts/claude-code-to-traces.ts` is the reference adapter — written against
Claude Code session transcripts for the G2.8 capstone, and the shape any other
exporter should copy:

```bash
# ALWAYS dry-run first: writes the batches to artifacts/, POSTs nothing.
pnpm tsx scripts/claude-code-to-traces.ts --dir <transcripts> --dry-run

# Then ingest.
pnpm tsx scripts/claude-code-to-traces.ts --dir <transcripts> \
  --api-url http://localhost:3000 --api-key pk_<partner-serving-key>
```

Three properties an adapter MUST keep, each learned the hard way in G2.8:

1. **Faithful.** One tool span per tool call, in order, with real `tool.args` /
   `tool.result`. Collapsing repeated calls hands clustering a tidy workload
   that is not the customer's, and hides exactly the defects worth finding.
2. **Scrub before it leaves, then truncate.** The platform redacts at ingest,
   but that is the second line. Do credential scrubbing in the adapter, and do
   it BEFORE any length cap — truncating first can cut a key into a fragment no
   pattern recognises. `--verify-scrub` re-reads the generated payload and
   refuses to emit if anything key-shaped survived (it is on by default).
3. **Real model ids.** Do not map the partner's models onto price-table aliases
   to make cost attribution look populated. Unknown models price at $0 at
   ingest, which correctly says "these models are not in the price table yet" —
   add them to `prices.json` as an onboarding step instead.

After ingest, cluster and check the shape:

```bash
curl -s -X POST localhost:3000/api/traces/cluster \
  -H 'content-type: application/json' -b "$COOKIE" -d '{"sinceDays":90}'
# poll /api/jobs/:id → clusters[], each with sessions + suiteId
```

**Set `POTION_CLUSTER_THRESHOLD=0.2` whenever the platform embedder is real.**
The default 0.62 is tuned for the mock embedder and collapses to 6% accuracy on
OpenAI embeddings (G0.5 held-out sweep). Since G2.8 the agent-clustering path
honours the override and REFUSES a live embedder above 0.4 rather than silently
producing one cluster per session.

**Expect the corpus to bound the guarantee.** A cluster cannot span tool
signatures, so a partner whose traffic splits across many tool graphs gets many
small clusters, and a cluster below `SUITE_VERIFY_MIN_PAIRS` (5) can never
render a retention verdict. Report that to the partner as a coverage fact
before promising a contract on it.

## 4. Verify serving (1 min)

```bash
curl -s -X POST "$POTION_API/v1/chat/completions" \
  -H "Authorization: Bearer pk_..." \
  -H "Content-Type: application/json" \
  -d '{"model": "potion-auto", "messages": [{"role": "user", "content": "hello"}]}'
```

Expect 200 with an `x-frontier-trace` header. Traffic now accumulates: traces
cluster nightly into their agent workloads, replay suites synthesize, rubrics can be
generated and reviewed at `/rubrics`, and live sweeps
(`POST /api/frontiers/live-sweep`) turn their frontiers live.

## 5. Invoice (monthly, 2 min)

```bash
pnpm --filter @potion/server invoice -- --org org-acme --period 2026-08
```

Reads the usage rollup (served requests plus cost-only overhead: guarantee judging,
rubric generation, live eval sweeps), renders HTML, saves via the json-file backend.
An org with no traffic produces an empty invoice, not an error.

## 6. Offboarding: TRUE-CASCADE deletion

The standing decision (owner, 2026-08-07), verbatim:

> OPERATIONAL purge (retention) = stale-never-delete as built (tombstone cacheKeys,
> historical frontiers stay explainable). ORG-LEVEL DATA DELETION (offboarding /
> legal erasure) = TRUE CASCADE — evidence rows AND tombstones included, historical
> explainability knowingly sacrificed.

```bash
curl -s -X DELETE "$POTION_API/operator/orgs/org-acme" \
  -H "Authorization: Bearer $POTION_OPERATOR_TOKEN"
# → 202 {"jobId": "..."}
curl -s "$POTION_API/operator/jobs/<jobId>" \
  -H "Authorization: Bearer $POTION_OPERATOR_TOKEN"
# → the per-table deletion report (status + evidence, always)
```

What is erased: every trace span, derived suite and item, rubric, calibration
record, eval run/result, frontier and its points, research cycle, request log,
usage row, budget, alert rule and delivery, share token, provider key (the
ciphertext itself), custody/auth audit rows, sessions, memberships — and org
members who belong to no other org (their `users` row is PII). What survives:
platform assets only — the shared taxonomy, price table, recipe library, and
platform frontiers. The walkthrough's step 14 proves this end-to-end on every run.

## Safety rails (already enforced by the code)

- `org_demo` cannot be deleted (409): it holds platform-wide unauthenticated
  request logs and is re-seeded at every boot.
- Deletion is idempotent — a repeated job is a recorded no-op.
- The cascade never touches platform rows: clusters with `org_id IS NULL`, models,
  strategy_configs, recipe_status are asserted unchanged in tests.
- The operator token is compared timing-safely and the surface fails CLOSED when
  the token is unconfigured.
