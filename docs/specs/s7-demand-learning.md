# S7 — Demand learning: what customers ask for becomes what we measure

**Status: L1–L4 BUILT 2026-08-19, L5 not started.** Written from the
operator's ask; the two decisions in §4 were answered the same day and the
build followed. Every "exists" claim carries its file:line. See §8 for what
shipped, what it is pinned by, and what is still owed.

---

## 1. The ask

> Every time Potion serves a company it should generalize and anonymize what it
> learns about the customer's use of AI — prompts, tasks, subjects — to build
> its own knowledge and rankings of models, and do new tests when it encounters
> something it hasn't tested for. All autonomously.

Unpacked into properties that bind the build:

1. **Serving is the sensor.** Every served request tells us something about
   what the market actually asks models to do. Today that signal is computed
   and thrown away.
2. **The fence between orgs holds.** Nothing one customer sent may become
   another customer's test item, exemplar, or visible artifact. Learning
   crosses the fence only as an aggregate that cannot identify anyone.
3. **Gaps become facts.** "Something we haven't tested for" must be a row with
   a number on it, not an intuition.
4. **A gap schedules its own measurement.** Discovery is worthless if closing
   it needs a human to notice.
5. **Dial honesty survives all of it.** A cell we have learned is in demand is
   not thereby routable. Only measured points route. (Standing constraint,
   `docs/SERVING-ROADMAP.md` §6.)

---

## 2. Ground truth — what already exists

| Piece | Where | State |
|---|---|---|
| Per-request cluster assignment | `apps/server/src/routes/chat.ts:680-696` | Runs on every served request, content-hash cached. |
| Every cluster's cosine, already computed | `packages/cluster/src/assigner.ts:69-82` (`pickBest`), `rank()` at `:31` | `pickBest` scores **every** centroid and returns one. Confidence, runner-up and margin are already paid for. |
| PII redaction | `packages/core/src/redact.ts:56` (`redactPii`), `redactAttrs:94` | Pattern redactor; applied at trace ingest and in trace-derived items (`packages/workers/src/handlers.ts:2006`). |
| Learning from real usage — **org-scoped** | `traces:cluster`, `packages/workers/src/jobs.ts:134-146`, handler `handlers.ts:1879-2360` | Embeds redacted first-messages, buckets by tool-graph signature, mints `agent-<orgHash6>-<slug>` clusters, synthesizes redacted replay suites. Nightly. This is the shape we want — one org wide, not the platform. |
| Org fence on derived artifacts | `packages/db/src/schema.ts:129-140` (`clusters.orgId`, NULL = platform), `:1006` (`derived_suites.orgId` NOT NULL), `evidence_attribution_audit` `:1292` | Customer-derived evidence is owned, ownership-checked, and audited. |
| Platform-scope measurement | `frontier:platform-sweep`, `packages/workers/src/jobs.ts:380-395` | Live sweep of one taxonomy cluster, evidence lands org-NULL, `capUsd` **required** (absent → refusal), width knob added by S6. |
| Autonomous model discovery | `research:scan` nightly (`apps/server/src/server.ts:332`) → `research:cycle` (`handlers.ts:1418`) | Already autonomous for **new models**. Nothing equivalent for **new demand**. |
| Catalog vs frontier | `models` table, `schema.ts:169-190` | Reachable ≠ routable, pinned by test (S5). |
| Proposal lifecycle to copy | `cluster_rubrics`, `schema.ts:1048+` | `pending / approved / rejected / superseded`; only `approved` is ever in force. Customer-derived artifacts ship with status + reason attached. |

**What is not stored today:** `request_logs` (`schema.ts:328-382`) holds no
prompt, no response, no embedding, no confidence — `clusterId` is the only
trace of subject matter, and it is the *routing label*, so it structurally
cannot say "this fit nothing we know."

---

## 3. The gaps (filed as G9 in the serving roadmap)

- **G9a — the signal is computed and discarded.** `chat.ts:694` keeps
  `assignment.clusterId` and drops the confidence; the runner-up and margin
  `pickBest` computed are never materialized. The single best "we have not
  tested for this" indicator is thrown away on every request, for free.
- **G9b — no shape record.** Whether a request carried tools, how long its
  context was, whether it asked for JSON — all present in the envelope, none
  recorded. A cluster's frontier can be fully measured and still wrong for
  half its traffic (measured on tool-free items, served to tool callers).
- **G9c — learning does not aggregate.** `traces:cluster` learns per org by
  design. There is no platform-scope view of demand, and no mechanism that
  could produce one without moving customer content.
- **G9d — no coverage model.** Nothing compares demand to measurement. G5
  ("measured breadth is ~3 strategies per cluster") is stated as a budget
  problem; nobody can say *which* three-model cluster is costing customers
  the most.
- **G9e — measurement is human-triggered.** Live spend requires
  `KEY_RISK_ACCEPTED` plus a hand-written ledger row (standing rule,
  `CLAUDE.md`). Autonomy means money moving without a person in the loop;
  that is a decision, not an implementation detail (§4).

---

## 4. Two decisions only the operator can make

**D1 — Privacy posture.** `docs/legal/PRIVACY_POLICY.md` §2 carries an open
placeholder on exactly this question, and currently promises quality
improvement runs on *"aggregated, de-identified measurements (not
prompt/response content)"*.

- **(a) Structural only.** Cross-org learning uses envelope facts alone —
  cluster id, confidence, tool presence, token profile. No content-derived
  value ever crosses the org fence. Weakest discovery: cannot tell two
  unrelated things that both land in `general` apart.
- **(b) k-anonymous aggregates (this spec's default).** Cross-org learning may
  use a *running centroid* of request embeddings, published only after ≥K
  distinct orgs (default K=5) and ≥N requests contribute. No per-request
  embedding is ever persisted; no prompt or response text is ever stored;
  no customer-derived text becomes a cross-org test item. Needs the §2
  placeholder resolved, a matching ToS §6.4 line, and an org-level opt-out.
- **(c) Content descriptors.** An LLM summarizes redacted prompts into task
  labels. Strongest signal, and it makes Potion a processor of content for its
  own purposes. Requires explicit opt-in per org. Not recommended as default.

**D2 — Autonomous spend.** Either (a) a standing daily authorization —
`POTION_AUTONOMOUS_LEARNING_DAILY_USD`, default **0 = off**, ledger rows written
by the job — or (b) the loop stops at a *proposal* and the operator approves
each probe. (a) is what "autonomously" asks for; (b) is what today's rules say.
This spec builds the mechanism so that (b) is (a) with the cap unset.

**DECIDED 2026-08-19 by the operator: D1(b) and D2(a)** — k-anonymous
aggregates, and a standing daily cap that the operator can switch on and off,
"and it can be a premium feature".

The premium half is read as TWO LAYERS, and the build reflects that reading:

- **Platform switch** — `POTION_AUTONOMOUS_LEARNING_DAILY_USD`, default 0.
  Off means the loop still discovers, ranks and plans; it cannot buy. That is
  the same mechanism as "propose, don't buy", which is why it is one build.
- **Per-org entitlement** — `orgs.learning_priority`. What a priority
  customer buys is ORDER: when the day's budget affords one measurement, its
  unmet demand is measured first. It buys no visibility into anyone, never
  lowers the k-gate, and never attaches an org to a published cell. The
  billing and plan surface around that flag is NOT built (§8).

---

## 5. Design

### L1 — Keep what is already computed *(content-free, ~$0)*
- Serve path calls `rank()` instead of `assign()` — same one embedding, same
  cache, no added cost — and records `cluster_confidence`, `runner_up_cluster`,
  `margin` on `request_logs`.
- Record a **shape** jsonb from the envelope only: message count, system
  present, tools present + count, requested JSON mode, stream flag, declared
  `max_tokens`, and prompt/completion token **buckets** (not exact counts).
- Nothing here is content-derived; it lands under the existing
  service-operations basis and needs no D1 answer to ship.

**Done when:** a served request's log row states how well it fit, what it
nearly was instead, and what shape it had — and a test proves no extra
embedder call was added.

### L2 — Demand cells *(the generalize + anonymize step)*
- New table `demand_cells`, keyed `(bucket, shape_class, week)` where `bucket`
  is a taxonomy cluster for confident assignments, or a **fixed-seed LSH
  bucket** (16 sign bits of a committed random projection) for everything the
  threshold sent to `general`.
- Each cell holds counts, a distinct-org count, a confidence distribution, a
  token profile, and a **running centroid sum** — updated by UPSERT at
  aggregation time. Per-request vectors are never written; the sum is the only
  survivor.
- **k-anonymity is a write gate, not a display filter.** A cell below K orgs
  is not published — it is not written into the readable table at all. A
  private staging row carries the contributor set until K is met, and the
  contributor set never leaves the aggregator.
- Org-level opt-out excludes an org's traffic from cells entirely.

**Done when:** a database with traffic from one org produces zero published
cells; the same traffic from K orgs produces one; and no table anywhere holds a
per-request embedding.

### L3 — Coverage ledger *(makes "untested" a number)*
- For every published cell, join demand against evidence: how many **live**
  platform frontier points serve that cluster, and do they satisfy the cell's
  shape constraints — `models.supports_tools = true` when the cell is
  tool-carrying, `context_length ≥` the cell's p95 prompt bucket, and so on.
- A gap score = demand volume × distinct orgs × unmet-ness, with the reason
  named as data (`no_live_points`, `no_tool_capable_point`,
  `context_too_short`, `unassigned_region`) rather than prose.
- Surfaces on the operator page as a ranked list. This alone is worth shipping
  even if D2 lands on (b): it tells the operator where the next dollar goes.

**Done when:** a seeded database where one cluster's measured points are all
tool-incapable, and its traffic is tool-carrying, ranks that cell first with
reason `no_tool_capable_point`.

### L4 — The autonomous probe *(the money leg)*
- `learning:probe` takes the top-ranked gap and:
  1. **Synthesizes** eval items for it from the cell's *descriptor* — cluster
     exemplars plus the shape constraints — via the existing generation path.
     **Never from customer prompts.** This is the line that keeps L2 an
     aggregate rather than a laundering step.
  2. Selects candidates from the `models` registry **filtered by the cell's
     shape constraints**, which is the thing today's class-representative
     pruning cannot express.
  3. Runs the standard `frontier:platform-sweep` machinery under a per-run cap
     drawn from the standing daily authorization, writes its own ledger row
     (projected / actual / cumulative), and refuses outright if the cap is
     unset — honest stub, never a silent mock (`false-live` rules).
- Results enter the platform frontier under live provenance through the
  existing path, so the next matching request routes on them. No new routing
  code, and no new way for unmeasured things to become routable.

**Done when:** with the cap set, a run of the loop on a database whose top gap
is real produces new live frontier points for that cell, a ledger row, and a
subsequent request that routes to one of them — and with the cap at 0, the same
run produces a refusal and no spend.

### L5 — Taxonomy growth *(new subjects, not just new models)*
- When an unassigned LSH cell passes density and k-org thresholds, write a
  `cluster_proposals` row — same lifecycle as `cluster_rubrics`
  (`pending/approved/rejected/superseded`) — carrying a generated name,
  description and exemplars, plus a **held-out re-evaluation** using the
  existing `packages/cluster/src/evaluate.ts` and `confusion.ts`: what the new
  cluster does to overall assignment accuracy and to every existing cluster's
  confusion.
- Auto-approval is gated on that evaluation (accuracy does not regress, mean
  margin improves) and is **off by default** — because adopting a cluster moves
  centroids, and moving centroids changes every future routing decision.
  Proposals that fail the gate stay listed with their reason.

**Done when:** a synthetic demand region that fits no existing cluster produces
a proposal with a measured accuracy delta attached, and adopting it improves
held-out accuracy while leaving prior clusters' confusion within tolerance.

---

## 6. What this refuses to do

- **No customer prompt, response, or per-request embedding becomes a
  cross-org artifact.** Ever. Tests pin it.
- **No third-party benchmark scores** feed selection — already pinned by test
  in S5, restated because a "rankings" feature is exactly where that slips in.
- **No cell becomes routable by being popular.** Demand schedules
  measurement; measurement alone publishes points.
- **No silent widening.** A probe that cannot afford its cap refuses; it does
  not shrink the candidate set and report success.
- **No k-anonymity by display.** Below K, the row is not written.

---

## 7. Sequencing

```
L1 (free signal) ──> L2 (cells) ──> L3 (coverage) ──┬──> L4 (autonomous probe)   [needs D2]
                          ▲                          └──> L5 (cluster proposals)
                          └── needs D1
```

L1 and L3's read model can ship under today's legal posture. L2 needs D1. L4
needs D2 and is the only leg with real spend; its cost is whatever the standing
cap is set to.

---

## 8. Build status (2026-08-19)

| Leg | State | Where |
|---|---|---|
| L1 — keep the signal | **DONE** | migration `0041_demand_signal.sql`; `packages/core/src/shape.ts`; `assignRanked` in `packages/cluster/src/assigner.ts`; both serve paths (`routes/chat.ts`, `routes/openai-parity.ts`) |
| L2 — demand cells | **DONE** | `0042_demand_cells.sql`; `packages/core/src/{demand,lsh}.ts`; `packages/db/src/repos/demand.ts`; `apps/server/src/demand.ts` + flush timer |
| L3 — coverage ledger | **DONE** | `packages/core/src/coverage.ts`; `packages/pareto/src/coverage.ts` |
| L4 — autonomous probe | **DONE (mechanism)** | `0043_learning_runs.sql`; `packages/workers/src/learning.ts`; `learningProbeHandler` + `capabilityFilter` on the platform sweep; nightly enqueue in `server.ts` |
| L5 — taxonomy growth | **NOT STARTED** | — |

**The properties that are pinned by test, not just asserted here:**

- the demand signal costs **no extra embedding call** (`cluster.test.ts`), and
  is recorded on a **cache hit** as well as a miss (`demand-signal.test.ts`) —
  repetition is what makes a demand cell, so a signal that only survived
  cache misses would systematically under-count the commonest workloads;
- `shape` is **content-free**: same structure, different text, identical
  shape, and tool NAMES never appear (`shape.test.ts`, `demand-signal.test.ts`);
- publication is a **write gate**: one org's traffic, at any volume, is
  staged privately and never written to the readable table
  (`packages/db/src/demand.test.ts`, `apps/server/test/demand-learning.test.ts`);
- a published cell carries an org **count** and no org identity, and no
  per-request embedding exists anywhere — the accumulator holds a sum
  (`demand.test.ts` in core and db);
- an **opted-out** org is excluded at observation, not filtered later
  (`demand-learning.test.ts`);
- coverage refuses to read **absence of evidence as coverage**: unknown
  context length is `context_too_short`, and mock points are not live points
  (`coverage.test.ts` in core and pareto);
- a tool-capable **cascade is not tool coverage**, because the serve path
  narrows tool requests to single points (`pareto/src/coverage.test.ts`);
- autonomy is **off by default**, an in-flight run counts against the day at
  its projection so two probes cannot double-spend, and the gap's reason
  decides the candidate filter (`workers/src/learning.test.ts`);
- `learning:probe` is a **single-attempt** job — a blind retry would re-spend;
- the accumulator is **memory-bounded** (5_000 cells; the LSH key space is
  65_536 buckets × shapes, each centroid ~3KB), and observations the bound
  turns away are counted and logged rather than silently lost.

**Still owed, and none of it is hidden behind a default:**

1. **L5.** Dense unassigned regions accumulate as `lsh:` cells and are
   reported as `unassigned-region-needs-taxonomy` skips by the probe, which
   is honest but not yet a proposal.
2. **Surfaces.** Nothing renders demand, coverage or the learning ledger yet,
   and the org opt-out / priority flags have no API. Both are database
   columns an operator can set today.
3. **Legal.** `PRIVACY_POLICY.md` §2's placeholder and ToS §6.4 still need
   the D1(b) posture written into them before this runs for anyone but the
   operator. The build holds to the stricter reading in the meantime.
4. **A live proof.** The probe's spending path has never run live — by
   construction, since the cap defaults to 0. When it first does, it needs
   the same ledgered projected-vs-actual treatment as every campaign before
   it; the difference is that the row is written by the job.
