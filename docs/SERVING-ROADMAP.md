# Serving roadmap — "pick the best model for what I'm building"

**This is a separate track from `docs/LAB-BUILD-PLAN.md`.** The Lab ladder is
paused mid-flight at Step 13a/13c (specs written, awaiting build) and is
untouched by this document; we return to it later. Everything here is
**guarantee-product core work**, which under the additive contract's rule 2
lands product-agnostic first — so when the Lab resumes it inherits all of it
for free through touchpoint 1 (the Lab consumes serving as a client).

Written 2026-08-16, after a working session that fixed three defects and
measured several more. Every claim below is either **verified** (with the
command or commit that showed it) or marked as **unverified**.

---

## 1. What the operator wants, as I understand it

> Someone shows up — with an existing workload **or building from scratch with
> nothing** — and Potion picks the best model, or mix of models, for what they
> are doing. They don't bring provider keys. They don't have to know which
> model is good. It keeps being right as models change, and it can prove it.

Unpacked into the properties that actually bind the build:

1. **No BYOK at all** (hardened 2026-08-17 — it began as "no BYOK
   *requirement*", with BYOK kept as an option). Potion serves from its own
   provider key, which is exactly what lets the choice span the whole catalog
   instead of the one provider a customer happened to bring. Keeping BYOK as
   an option would have preserved the ceiling it imposes for the customers
   most likely to take it.
2. **Valuable from scratch.** A customer with **zero traffic** must get real,
   measured routing on their first request — not a placeholder, not a default.
   This is the hard case and the one most easily faked.
3. **Self-serve works.** Sign up, get a key, point traffic, go. Not public
   yet — the operator is testing it privately.
4. **The auto-switch is visible.** There is an obvious path in the product to
   "this is where you point traffic, this is your policy, here is proof it is
   routing."
5. **Honesty is the product.** Nothing is offered as a choice unless there is
   measurement under it (the standing *dial honesty* decision). Breadth must
   never become "300 models we've never measured."

**Explicitly deferred by the operator:** the deployed URL (Step 13a) and
payments/credits (Step 13b). Both are named below where they gate something,
and neither is worked in this track until the operator says so.

---

## 2. Ground truth — what is already true (verified this session)

| | Status |
|---|---|
| Platform serving (no BYOK) | **Already works.** `context.ts:351-380`: an org with zero servable BYOK keys resolves to the platform provider set, built from the four env keys incl. `OPENROUTER_API_KEY`. Merge is per-provider, org-keys-win. |
| Cross-provider compositions | **Already work.** Every strategy member resolves independently per call (`strategies/helpers.ts:60-90`); a cross-provider ensemble template already exists (`researcher/generate.ts:13`). |
| Self-serve signup | **Fixed** (`4d20795`). Compose hardcoded the flag off; no SMTP meant signup stranded the user. Proven end to end with the dev bypass OFF: signup → link → session → `/api/keys` 200 → policy+key 201 → link replay 401. |
| Connection details | **Fixed** (`89f4736`). `GET /api/endpoint-snippet` 400'd for a fresh org; now falls back to the org's bound policy and returns base_url + a `potion-auto` snippet. |
| Cold-start routing | **Fixed** (`deb0dc8`). Bare db + brand-new org + zero traffic now routes on live measured evidence: `cluster=code-gen;frontier=v1;fallback=0;provenance=live`, and a different prompt routes from a different cluster. |
| Measured platform evidence | **Exists**: Step 5's live sweep, 10/10 clusters, 29 points, all `provider_mode='live'`, 580 live eval results, $3.5774 ledgered. Now committed as `packages/db/baseline/platform-frontiers.json` and imported under `POTION_PLATFORM_BASELINE=1`. |

**What that means:** the engine for "no BYOK + measured routing from scratch"
is now real. What remains is breadth, billing truth, visibility, and safety.

---

## 3. The gaps, with evidence

Ordered by what blocks the experience, not by size.

### G1 — Breadth: the catalog is 24 models, in a file
*(S5, DONE. Proven concretely: the repo's committed prices.json had been
polluted by an earlier scan with two MOCK TEST FIXTURES — the bug caught in
the act. After the fix a full walkthrough scan leaves the file byte-identical.)*
`prices.json` **is** the model registry (`researcher/registry.ts:1-11`). The
only thing that grows it, `research:scan`, writes the file with
`writeFileSync` (`workers/handlers.ts:1255`), and `loadPrices` runs **once at
boot** (`context.ts:312`). So on a container: a scan's results vanish on
redeploy and never affect the running process. Verified externally
(2026-08-16): OpenRouter's `/api/v1/models` returns per-token pricing (already
parsed), `supported_parameters` (incl. `tools`), `context_length` and
`top_provider.max_completion_tokens`; a prior live check recorded ~338 models.

### G2 — Billing truth: the cost we record is not the cost we are charged
*(S3, done. The gap was NOT the one written here first.)*
As originally filed: nothing recorded who paid, and
`usage_daily.platformCostUsd` was the *same SQL expression* as `costUsd`. With
BYOK retired that half dissolved — every served request is ours.
What remained was worse and is now fixed: the recorded cost was **modelled**
from a price table shaped only as input/output per 1M, so it could express
neither a cached-input discount (we overcharged) nor reasoning tokens billed
outside the completion count (we undercharged). Measured, not assumed —
see S3 below. Cost now comes from the provider's own billed figure.

### G3 — The auto-switch has no page
*(S1, done.)*
The API half is fixed, the surface is not. The serving key appears **once**,
transiently, after the policy picker (`policy-picker.tsx:192-220`) and is never
re-retrievable; `/settings` has exactly one subpage (`audit`); the home page
still reads *"Bring your own provider keys"* (`app/page.tsx:41-46`), which is
now the wrong default.

### G4 — From-scratch has no front door of its own
*(S2, done.)*
Cold-start *routing* works, but there is no surface where someone says **"I'm
building X"** and gets a recommendation. The pieces exist — the cluster
assigner classifies arbitrary text (`cluster/assigner.ts`), platform frontiers
now carry live evidence, and the Lab's mission interview does this shape for
harnesses — but nothing joins them on the serving side.

### G5 — Measured breadth is ~3 models per cluster
Even with a large catalog, sweeps measure three class representatives plus a
judge (`handlers.ts:3106-3126`), pruned by `classRepresentative` and
`DEFAULT_CANDIDATE_BUDGET = 20`. Dial honesty says only measured points are
routable, so **routable breadth grows only with evaluation spend**. This is a
budget decision, not a code problem.

### G6 — Platform serving has no spending safety
*(S4, done — plus a FOURTH hole this list missed: an org with no budget row
had no cap at all.)*
Three verified facts, harmless under BYOK and dangerous on our own key: the
budget hard stop **fails OPEN on a db error** (`budgets.ts:78-80`); rate
limiting is **per-API-key only**, with no org or platform ceiling
(`ratelimit.ts:237`) and per-replica (F18); soft budgets never block
(`budgets.ts:64-68`).

### G7 — The baseline only helps a FRESH database
`importPlatformBaseline` never clobbers, so a database that **already** has
mock-provenance platform frontiers (any existing dev db from the demo seed)
keeps them, and under a live server the provenance guard discards them →
`fallback=1` returns. Existing databases need those rows cleared or a live
sweep. Recorded, not yet solved.

### G8 — The measured claim is strongest off the serve path
Known defect, unchanged: the reference-free serve-path judge is below the 0.8
correlation bar; the contractual-grade instrument is the suite/replay path.
Named here so "measured routing" is not read as more than it is.

---

## 4. Roadmap

Phases are dependency-ordered. Each has a **done-when** that is provable, and
names its spend. Nothing here requires the deployed URL unless marked.

### S1 — Make it visible *(smallest, highest daily value)* — **DONE 2026-08-17**
**Fixes G3, part of G4.**
- A durable **Connect & auto-route** page: base_url, serving key (re-issuable,
  shown once per issue), the bound policy in plain language, and **proof** —
  recent requests with the model/strategy that actually served them, read from
  the data already on every response (`x-frontier-trace`).
- Re-frame the home page: platform serving is the default path, BYOK is the
  option.
- Consume `POTION_PUBLIC_URL` so the base_url is right behind a proxy.

**Done when:** a fresh self-serve org can find where to point traffic without
being told, and can see that its requests were routed (not defaulted).
**Spend:** $0.

**Shipped.** `GET /api/connection` + `GET /api/routing-activity`;
`apps/server/src/public-url.ts` (POTION_PUBLIC_URL wins, three call sites
unified); `/` is the connect page and BYOK moved to
`/settings/provider-keys`. The honesty rule: `routed` is read back out of the
`x-frontier-trace` string the caller received and needs BOTH a real frontier
AND a policy-selected point, so the panel cannot disagree with the serving
path; readiness reuses `guardFrontierProvenance` rather than counting rows.
Proven on a bare database for an org that self-served seconds earlier —
10/10 clusters ready all-live, three prompts routing from three different
clusters, page reporting 3 of 3 routed. Walkthrough leg 7b asserts a
non-zero routed count. One gap stayed open on purpose: the readiness list
answers "what can Potion route", not "what should I build with" — that is
S2's job.

### S2 — "What are you building?" *(the from-scratch front door)* — **DONE 2026-08-17**
**Fixes G4.**
- An intent entry point: plain-language description → cluster assignment →
  the live platform frontier for that cluster → a recommended policy and
  operating point, with the measured numbers and their provenance shown.
- Optional sharpening: paste two or three representative prompts to confirm
  the cluster rather than guess it.
- Output is a working configuration plus the snippet from S1 — never an empty
  dashboard.

**Done when:** someone with no traffic describes what they're building and
leaves with a policy, a key, and a routed first request whose evidence they can
inspect. **Spend:** $0 (embedding only; the frontier is already measured).

**Shipped.** `POST /api/plan` (read-only) + the `/build` page, now nav step 1.
`ClusterAssigner.rank()` scores every cluster so the runner-up and the margin
are visible. Three honesty rules hold the surface up: `basis` is a field, not
prose; alternatives and margin always ship, so a near tie renders as one; an
infeasible policy shape returns **with its reason** and is never dropped or
quietly widened. Samples outrank the description, and the override is shown.
Proven on a bare database through the dashboard's own proxy: idea → Code
Generation → `single · or-deepseek` q=1.000 $0.1044/1K → policy + key →
`fallback=0;provenance=live`. **Known limitation:** under the mock embedder,
description-only classification is keyword-driven and weak for prose that
avoids cluster vocabulary (a support-email description scored 0.047, margin
0.008 — the caveat fired, and three real prompts corrected it). The real fix
is `POTION_EMBEDDER=openai`, which the deployment turns on.

### S3 — Billing truth — **DONE 2026-08-17**
**Fixes G2. Prerequisite for charging anyone for platform serving.**
- Record the funding source per serving request (`paid_by: platform | byok`)
  plus the resolved provider — both already known at request time, just not
  written.
- Make `platformCostUsd` genuinely distinct: platform-paid only.
- Invoice bills platform-paid spend at cost + margin (`--margin-pct` already
  exists in the invoice CLI); BYOK spend keeps its informational meaning.

**Done when:** ~~an org with mixed BYOK/platform traffic produces an invoice
that bills exactly the platform-paid half~~ — restated, because BYOK is no
longer offered: **the recorded cost of a served request equals what the
provider actually billed, and every request carries the counterfactual needed
to price on outcomes.** **Spend:** ~$0.0002 (one measurement probe).

**Shipped.** Migration 0039 records `paid_by` and `baseline_cost_usd` per
request. The baseline is the one with a deadline — "money saved" compares
against a price table and a frontier that both drift, so it is a fact when
recorded and an estimate when reconstructed.

Leg 2 turned out to be the important one, and not what this doc predicted. It
assumed the fix was a richer price shape (cache-read and reasoning rates). A
$0.000007 probe showed the real answer: **OpenRouter returns the cost it
actually billed**, so `costUsd()` now prefers that and models only as a
fallback for transports that report none. Measured, not assumed —
`deepseek-chat` came back 9% *over*-modelled because 3 of 10 prompt tokens
were cached, and `gpt-5-mini` returned `completion_tokens: 0` alongside
`reasoning_tokens: 107`, which no token-based model could ever have counted.
Cached input makes us overcharge the customer; reasoning tokens make us
undercharge ourselves. This should also close the Step 5 campaign's ~0.3%
reconciliation residual, which was exactly this drift.

### S4 — Spending safety on our own key — **DONE 2026-08-17**
**Fixes G6. Required before the operator points a real key at anything
long-running, and non-negotiable before strangers.**

**Shipped, and reordered ahead of S3** — billing truth matters once someone
is invoiced (deferred); this protects the operator's own card the moment a
key is set. Who pays is answerable per request via `providersForOrg().byok`,
so it did not have to wait for S3. A **fourth** hole turned up in the code
that was not on this list: an org with no budget row had **no cap at all**.
Now `POTION_PLATFORM_ORG_CAP_USD` defaults ON at $10 (never overriding a
customer's own), the check fails closed when we pay, an org rate bucket sits
at 10× the per-key allowance, and `POTION_PLATFORM_DAILY_CAP_USD` is the
operator's kill switch (defaults OFF; its denominator over-counts BYOK until
S3, which is the safe direction). All scoped to live + platform-paid, pinned
by negative tests so BYOK and mock are provably unchanged. Live leg: **5
served, 6th refused**, $0.001368 metered across three runs. The first live
attempt failed honestly — a $0.02 cap was above what the experiment could
spend — and the recalibration is recorded rather than quietly fixed.
- Budget hard stop **fails closed** for platform-paid orgs (fail-open on a db
  error is acceptable when the customer pays; not when we do).
- An **org-level** ceiling in addition to per-key, and a platform-wide daily
  kill switch.
- A required hard-stop cap for any org enabled for platform serving.

**Done when:** a runaway loop on a platform-served org is bounded by a cap that
provably kills it, and the db-error path refuses rather than allows.
**Spend:** ≤ $1 to re-prove the kill on live pricing.

### S5 — Breadth — **DONE 2026-08-17**
**Fixes G1, enables G5.**
- Move the model registry from `prices.json`-on-disk into the database; keep
  the file as the seed for a fresh db; `research:scan` writes rows, not bytes,
  and takes effect without a redeploy.
- Ingest the OpenRouter catalog with pricing, tool-capability
  (`supported_parameters ⊇ tools`) and `max_completion_tokens`.
- Keep **catalog ≠ frontier**: everything reachable, only measured points
  routable. `GET /v1/models` must stop advertising the whole table as if it
  were routable.
- ~~Record the honest bound: our price shape is input/output per 1M, so
  cache-read and reasoning-token pricing are not modelled~~ — **superseded by
  S3 leg 2**, which stopped modelling billed cost altogether and reads the
  provider's own figure. The price table still *projects* cost (preflight
  estimates, frontier `costPer1K`), and those projections keep the shape's
  limits; what a customer is charged no longer does.
- **Refused:** OpenRouter's `benchmarks` field must never influence selection.
  Routing on third-party benchmark percentiles is the incumbent's game.

**Done when:** a scan ingests the live catalog into the db, survives a
simulated redeploy, takes effect without a boot, and an unmeasured model is
visible-but-never-auto-selected (asserted by test). **Spend:** $0 (the models
endpoint is free).

**Shipped.** Migration 0040 adopts the `models` table — which turned out to be
**dead**, declared in the schema and read/written nowhere. prices.json is
demoted to a seed that never clobbers a live row. Proven concretely: the repo's
committed `prices.json` had been polluted by an earlier scan with two *mock
test fixtures*; after the change a full walkthrough scan leaves the file byte-
identical.

`/v1/models` was misrepresenting something sharper than this doc recorded: it
listed every alias like `potion-auto`, implying you could pick one. You cannot
— `body.model` is a **label**, and the strategy comes from cluster + policy +
frontier. A test now proves it by sending two different `model` values and
requiring the same resolved strategy. Each entry carries `potion.role` and
`potion.measured`; the OpenAI fields are untouched.

The benchmarks refusal is now **pinned by test**, not just stated: adding it
later has to be a decision made against a failing test rather than a
convenience slipped in beside context lengths.

**Residual, recorded:** the serving path's model *resolver* is still built at
boot, so a freshly discovered model cannot be **served** until the next
restart. Narrow — it cannot be routed to before it is measured, and
measurement runs in the workers, which do read the live registry — but real.

### S6 — Widen what is measured
**Fixes G5 and G7. The only phase whose cost is real.**
- Widen sweep candidate sets beyond three class representatives, deliberately
  and per-cluster.
- A repeatable "measure this cluster live" job with a per-run cap, ledgered
  projected-vs-actual as every live campaign has been.
- Re-measure any cluster still holding mock-provenance platform frontiers
  (G7), or clear them so the baseline can fill.

**Done when:** each taxonomy cluster's platform frontier spans more than three
measured strategies, all live-provenance, ledgered. **Spend:** operator-set cap
under `KEY_RISK_ACCEPTED`; scales with how much breadth is wanted.

---

## 5. Sequencing

```
S1 (visible) ─┬─> S2 (from-scratch door)
              └─> S3 (billing truth) ──> S4 (safety) ──> [13b payments, later]
S5 (breadth) ─────────────────────────> S6 (measure it)
```

- **S1 → S2** is the fastest path to a product the operator can sit down and
  use, both cold and warm. Neither needs the URL.
- **S3 → S4** is the money path: know who paid, then make sure it can't run
  away. S4 is the gate before any real key runs unattended.
- **S5 → S6** is the breadth path and can run in parallel; S6 is where the
  spend lives.
- **Deploy (13a)** is orthogonal: everything above is testable locally, and
  gets better the day it has a URL.

## 6. Standing constraints (inherited, not negotiable here)

- **Dial honesty** — no control exposed without measurement underneath.
- **Catalog ≠ frontier** — reachable is not routable.
- **Provenance never downgrades** — live evidence is never superseded by mock;
  the "once live, never regress" taint rules stand.
- **Additive contract rule 2** — this is product-agnostic core; the Lab
  inherits it through touchpoint 1 with no Lab code changes.
- **Every live run is ledgered** — projected vs actual vs cumulative, before
  and after, under an explicit risk acceptance.
- **Honest stubs** — an unbuilt path throws or self-labels; never a silent
  fallback.

## 7. Not in this track

- **The deployed URL (Lab Step 13a).** Spec is written and awaiting build.
- **Payments, credits, abuse controls for strangers (Lab Step 13b).** S4 covers
  the safety subset needed for the operator's *own* key; charging strangers
  needs 13b in full.
- **The Lab ladder itself** (Steps 13c, 14–17). Paused, unmodified, resumed on
  the operator's word.
