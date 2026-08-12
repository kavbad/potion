# Lab roadmap — pre-L0 assumption verification

Read-only pass, 2026-08-11, per the agent instructions in
[LAB-ROADMAP.md](LAB-ROADMAP.md). No code was changed. Each assumption gets a
verdict line, then the evidence. Where a verdict is PARTIAL, the gap is named
as the product-agnostic core work rule 2 requires — recorded, not improvised
around.

| # | Assumption | Verdict |
|---|---|---|
| A1 | Platform frontiers with generic coverage for cold start | **PARTIAL** — the concept and machinery exist; live-labeled generic coverage does not exist yet in any deployable state |
| A2 | Serving supports the runtime as a client (streaming, tools, attribution) | **PARTIAL** — attribution and streaming pass; tool passthrough is `single`-strategy only |
| A3 | Step synthesis can accept Lab run records | **PASS** (adapter work expected, exactly as the assumption predicted) |
| A4 | Usage/invoicing can carry one more attribution dimension additively | **PASS** — with a recommended shape (parallel rollup, not PK widening) |
| A5 | `POTION_SELF_SERVE` is the single self-serve flag, off until Gate C | **PASS** — with one polarity nuance to carry into Gate C |

---

## A1 — Platform frontiers / cold-start coverage: PARTIAL

**What holds.** Platform scope is first-class: `org_id NULL = platform`,
version chains are scope-exact, and the serving read is org-preferred with
platform fallback (`packages/db/src/repos/frontiers.ts:1-8`). The generic
task taxonomy exists with **10 clusters** (`packages/cluster/data/taxonomy.json`:
code-gen, code-review, extraction, summarization, classification,
multi-step-reasoning, creative, rewrite-edit, rag-answer, agentic-tool-use).
Live machinery that *publishes* platform-scope frontiers exists — the
research-cycle promotion path calls `saveFrontier(ctx.db, clusterId, …)` with
no org (`packages/workers/src/handlers.ts:1726`), and the suite/sweep
machinery runs live under `POTION_EVAL_PROVIDER=live`.

**What does not hold.** "Enough generic coverage" is not true today anywhere
a Lab could deploy:

- The boot seed computes frontiers for **2 of 10** clusters
  (`SEED_CLUSTERS = ['code-gen', 'extraction']`,
  `apps/server/src/seed.ts:76`), on the **mock provider**, explicitly
  labeled a simulation (`seed.ts:8-11,151`). Under the imported dial-honesty
  rule, SIMULATED evidence cannot back autopilot's cold-start suggestions.
- `frontier:live-sweep` is org-scoped by construction (payload requires
  `orgId`); there is no platform-scope live sweep job today.
- No production database exists yet (pre-Gate-A), so no live platform
  frontiers exist anywhere.

**Gap, as rule-2 core work:** a platform-scope live frontier sweep across the
taxonomy clusters (machinery mostly present; needs either a platform variant
of the live-sweep job or an operator research-cycle motion), run once against
the deployed instance, ledgered. This is also useful to the guarantee product
(richer platform fallback), which is what rule 2 wants.

## A2 — Serving as runtime client: PARTIAL

**Streaming: PASS.** `stream:true` yields SSE for `single` strategies and for
composite strategies; other multi-call strategies return JSON with an
explicit `x-latency-contract: non-streamed` header — a documented contract,
not a silent downgrade (`apps/server/src/routes/chat.ts:12-17`).

**Per-call attribution: PASS.** `request_logs` carries `api_key_id`,
`cluster_id`, `strategy_hash`, `frontier_version`, `policy_type`, `usage`,
`latency_ms`, `status`, and `completion_id` (the `chatcmpl-…` correlation
label joining quality to spend, G2.1 — `packages/db/src/schema.ts:319`). A
runtime can attribute per step by capturing the completion id per call. No
harness-id dimension exists — expected; that is touchpoint 4 in L4.

**Tool passthrough: the constraint.** `tools`/`tool_choice` are forwarded
unmodified **only on `single` strategies**; any other operating point returns
a 400 by design (`chat.ts:671-677` — cascades/best-of-N fan out calls and
cannot do coherent mid-call tool negotiation). Consequence for L0/L1, to
design around rather than "fix": **tool-calling harness steps are pinned to
single-model frontier points.** Autopilot must select single-strategy points
for any step that carries tools, or the runtime must split tool steps from
non-tool steps across policies. This is a real product constraint the L1
autopilot design must encode; changing it would be a serving semantic change
and therefore a contract violation.

## A3 — Step synthesis accepts Lab run records: PASS

The ingest surface is generic, not converter-shaped: `POST /v1/traces`
accepts an **OTel GenAI subset**, idempotent on (org, trace, span), priced at
ingest (`apps/server/src/routes/traces.ts:3-6`). The step read model accepts
either `gen_ai.operation.name === 'llm_call'` or span name `llm.call`
(`packages/db/src/repos/traces.ts:282`), and step-level synthesis builds
eval items from those spans (post-capstone item 2). The Claude Code converter
is transcript-specific by design (`scripts/claude-code-to-traces.ts:1`) and
does **not** need to generalize: the Lab runtime emits §14.1-shaped spans
directly as it executes — an adapter in Lab code, zero core change. The
assumption's "converter work expected" was exactly right.

## A4 — One additive attribution dimension: PASS (with a recommended shape)

`usage_daily` is keyed `(org_id, day, cluster_id)` with a composite primary
key (`packages/db/src/schema.ts:408-427`); invoices aggregate over it.
Two additive paths exist; one is safer:

- **Recommended: a parallel per-harness rollup** (new table keyed
  org/day/harness), fed from the same `request_logs` rows via a nullable
  `harness_id` attribution column. Existing `usage_daily` rows, sums, and
  invoices are byte-identical to today; the harness P&L is a new read.
- Not recommended: widening the `usage_daily` PK — that changes row identity
  under the existing invoice queries, which is precisely the "semantic change
  to existing invoices" the assumption forbids.

Either way the L4 work is additive-by-construction. Verdict PASS because an
additive path demonstrably exists; the shape above should be treated as part
of the finding.

## A5 — `POTION_SELF_SERVE` single flag, off until Gate C: PASS

It is the single gate: `selfServeEnabled()`
(`apps/server/src/routes/auth.ts:200-210`) is the only decision point, the
route inventory documents it on `POST /auth/request-link`
(`route-inventory.ts:176`), and the tenancy report names it as the posture
flag. The deploy compose pins it empty (`deploy/docker-compose.prod.yml`,
`POTION_SELF_SERVE: ""`).

**Nuance to carry into Gate C:** unset does not always mean off — unset
defaults to ON **when the dev-auth bypass is active** (tests/walkthrough)
and OFF otherwise. Production posture is therefore off-by-default as the
assumption requires, but any future environment that enables the dev bypass
also silently enables self-serve. Gate C's "deliberately flipped on" should
be an explicit `POTION_SELF_SERVE=1`, never an inherited default.

---

## Summary for the L0 planner

Nothing here blocks the Lab's architecture; both PARTIALs are the good kind —
mechanisms exist, coverage or scope is the gap:

1. **A1** needs a platform-scope live sweep motion (core work, also benefits
   the guarantee product) before autopilot cold start is honest.
2. **A2**'s tool constraint is a design input for L0/L1, not a defect: tool
   steps ride single-strategy points, by serving's own documented contract.

Per the operating instructions, no Lab code was scaffolded and Gate A is
untouched.
