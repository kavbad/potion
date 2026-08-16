# Step 13c spec — Platform serving: full breadth without BYOK

Phase one. **No code.** Operator-inserted after the 13a/13b split; executes
**immediately after Step 13a** (order: 13a → **13c** → 14 → 15 → 16 → 13b → 17).
Lettering is not execution order — 13b (Gate C) still executes late, by design.

**What this step is.** Serve a customer's traffic from a **platform-owned
OpenRouter key** so the frontier can span the whole catalog instead of the one
provider a customer happened to bring a key for — and make the auto-switch
*visible* in the product. Billing stays **invoiced** (the existing
`json-file` backend + `--margin-pct`), for **operator-onboarded partners only**.

**Explicitly out of scope (stays in 13b):** Stripe, prepaid credits, abuse
controls for strangers, guided self-serve onboarding, and
`POTION_SELF_SERVE=1`. §7 states plainly why self-serve *cannot* ride this
step.

**Contract position.** This is **guarantee-product core work**, not Lab work,
under the additive contract's rule 2 (`docs/LAB-ROADMAP.md`): core extensions
land product-agnostic first. The Lab then inherits full breadth **for free**
through touchpoint 1 (it consumes serving as a client) — no Lab code changes.

---

## 1. The finding that reframes this step: platform serving already works

Reading the code first changed the shape of the work. **The platform fallback
is already built, wired, and shipping:**

- `apps/server/src/context.ts:351-380` — `resolveOrgProviders`: an org with
  **zero servable BYOK keys returns the `platform` provider set**
  (`:353-354`, `:372`). Platform providers are built at boot from four env
  vars — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`,
  **`OPENROUTER_API_KEY`** (`context.ts:228-235`, `:343-349`).
- The merge is **per-provider, org-key-wins, platform-env as the base map**
  (`context.ts:355-356`, `:361`). A BYOK decrypt failure falls back to the
  platform key rather than failing the request (`:363-370`).
- The dashboard already says so out loud: *"no key connected for a provider?
  Potion serves that provider on its own platform keys"*
  (`apps/dashboard/app/page.tsx:72-77`).
- Compositions are **already cross-provider by construction**: every strategy
  member is resolved independently per call (`packages/strategies/src/helpers.ts:60-90`),
  and the candidate generator has an explicit cross-provider ensemble template
  (`packages/researcher/src/generate.ts:13`, `registry.ts:75-96`).

**So "set `OPENROUTER_API_KEY` on the server and BYOK-less orgs serve on it" is
true today.** What is *not* true is the rest of the promise. Four things are
genuinely missing, and they are this step:

| # | Gap | Why it blocks "full breadth, invoiced" |
|---|---|---|
| **A** | **The model registry is a FILE** (`prices.json`), mutated with `writeFileSync` | Breadth cannot survive a deploy (§2) |
| **B** | **Metering never records WHO PAID** | You cannot invoice platform-paid tokens (§3) |
| **C** | **Frontiers measure ~3 models, not the catalog** | Breadth of *reach* ≠ breadth of *routing* (§4) |
| **D** | **The auto-switch has no front door** | The product's core behaviour is invisible (§5) |

Plus one landmine that fires the moment a live key is set (§6) and the safety
rails our own money now requires (§7).

---

## 2. Item A — the registry must move off the filesystem

**The defect.** The canonical model list *is* `prices.json`
(`packages/researcher/src/registry.ts:1-11`: the registry is "the class-pruned
view of the versioned price table"). The one dynamic path that grows it —
`research:scan` — **writes the repo file**:
`writeFileSync(ctx.pricesPath, …)` (`packages/workers/src/handlers.ts:1255-1259`).

In the 13a deployment that is a container with no persistent app disk. A scan
that ingests OpenRouter's catalog would write into the container filesystem and
**vanish on the next deploy**, silently reverting the catalog to the 24 baked-in
entries. Worse, `loadPrices` is read **once at boot** (`context.ts:312`), so a
mid-life scan does not even affect the running server.

**The work.** Move the price table into Postgres (a `model_prices` table, one
row per entry, plus a `version`/`updated_at` head), keep `prices.json` as the
**seed** for a fresh database, and make `research:scan` write rows instead of
bytes. Serving reads the table with the same 60s-style cache discipline used
elsewhere, so a scan takes effect without a redeploy.

**Non-negotiables carried from existing behaviour:**
- The version bump on merge (`packages/pareto/src/recompute.ts:165-171`)
  **deliberately invalidates cached eval cells** — preserve that exactly, or
  stale evidence attaches to re-priced models.
- `PriceEntry.provider` is a **closed Zod enum**
  (`packages/core/src/schemas.ts:184-190`) — every OpenRouter model lands as
  `provider: 'openrouter'`, which is correct and already how the scanner stamps
  them (`scan.ts:137`).
- Unpriced listings are **skipped, not added** (`scan.ts:121-124`) — keep this.
  It is load-bearing: the serve-path resolver **throws** on an unknown model
  (`packages/strategies/src/resolve.ts:12-17`), so an unpriced model in the
  registry would be a routable model we cannot cost.

**Ingest is already sufficient.** Verified live on 2026-08-15: OpenRouter's
`/api/v1/models` returns per-model `pricing.prompt` / `pricing.completion` as
**per-token decimal strings** (the scanner already parses these and multiplies
by 1e6 — `scan.ts:70-83`, `:140-141`), plus `context_length`,
`top_provider.max_completion_tokens`, and `supported_parameters` (which
includes `tools` / `tool_choice`). A prior live check recorded **338 models**
(`packages/providers/src/live/openrouter.ts:5-8`).

**Two fields worth ingesting that we currently drop:**
- `supported_parameters` ⊇ `tools` — lets the registry mark **tool-capable**
  models. The Lab's single-strategy-tools partition needs exactly this, and
  today it is inferred rather than known.
- `top_provider.max_completion_tokens` — feeds the `max_tokens` enforcement
  that makes cost projections dominate actuals (the `c248d74` estimator work).

**One honesty caveat to record, not paper over:** OpenRouter prices also carry
`input_cache_read`, `input_cache_write`, and `internal_reasoning` keys. Our
`PriceEntry` has only `inputPer1M`/`outputPer1M`, so **cost estimates will
under-count reasoning-heavy models**. That is a known, stated bound of the
estimate — related to the recorded G0.2 finding that reasoning models eat the
completion budget — not something this step silently fixes.

---

## 3. Item B — metering must record who paid

**The defect.** `OrgProviders.byok` and `byokProviders` are computed at
`context.ts:120-121, 348, 357, 362, 372, 378` and **consumed nowhere in
production code**. The serving path never records which credential paid:
`request_logs.provider` is documented **NULL on serving rows**
(`packages/db/src/schema.ts:306-312`), and `usage_daily.platformCostUsd` is the
*same SQL expression* as `costUsd` (`packages/db/src/repos/usage.ts:113-114`).

Under BYOK that was fine — the customer paid their provider directly and the
number was informational. **Under platform serving it is the invoice.** You
cannot bill "what Potion paid on the customer's behalf" from a table that does
not distinguish it, and an org that is *partly* BYOK (say OpenAI BYOK,
everything else platform) makes the distinction per-request, not per-org.

**The work.** Record the funding source on every serving row — a
`paid_by: 'platform' | 'byok'` dimension (plus the resolved `provider`, which
the serving path already knows and simply does not write). It flows from the
per-request provider resolution that already exists, so this is threading a
value that is computed, not inventing one. Then:

- `platformCostUsd` becomes **genuinely distinct** from `costUsd`: platform-paid
  tokens only.
- The invoice bills platform-paid spend at cost + margin — and
  `--margin-pct` **already exists** in the invoice CLI
  (`apps/server/src/billing/cli.ts:1-3`).
- BYOK spend keeps its current meaning (informational; the customer already
  paid their provider).

This is the one item that is genuinely load-bearing for the business model, and
it is small — a column, a threaded value, and a rollup that stops conflating two
things.

---

## 4. Item C — breadth of reach vs breadth of routing (dial honesty)

The standing decision binds here, verbatim from `docs/LAB-ROADMAP.md`:

> **Dial honesty:** no quality/cost/speed control is exposed without
> measurement underneath it.

Ingesting 338 models does **not** mean routing to 338 models. Today's candidate
sets are deliberately narrow — the org live sweep measures exactly **three
singles plus a judge** (`packages/workers/src/handlers.ts:3106-3126`), chosen by
`classRepresentative` (cheapest per class). A frontier only ever contains
**measured** points, and selection (`packages/core/src/select.ts:21`) only ever
picks from the frontier.

**The design, stated as a rule:**

- **Catalog** = what we can *reach* (the priced registry — now the full
  OpenRouter list). Grows with a scan; costs nothing.
- **Frontier** = what we have *measured* on this workload. Grows only with
  evaluation spend. **Only the frontier is routable.**
- An unmeasured model is **visible and never auto-selected**. It may be shown
  as a candidate with an explicit "unmeasured" state — never as a dial position.

**What platform serving actually buys us here** is not routing breadth on day
one; it is that **we can now measure anything without asking the customer for a
key.** The key-availability filter that prunes sweep candidates reads
`process.env` (`handlers.ts:3101-3116`), and its own comment already says the
quiet part: *"The registry carries OpenRouter-routed equivalents for every
class, so one key can cover the sweep."* One platform key makes the entire
catalog measurable, which is the real unlock.

**Explicitly refused:** OpenRouter's `/models` also returns a `benchmarks`
object (`artificial_analysis` intelligence/coding/agentic indices). We ingest it
as metadata **at most**, and it must **never** influence selection. Routing on
third-party benchmark percentiles is precisely the incumbent's game `CLAUDE.md`
says we do not play; first-party measured quality is the entire positioning.

**Widening the candidate set is a knob, not a rewrite:** `classRepresentative`
+ `DEFAULT_CANDIDATE_BUDGET = 20` (`packages/researcher/src/generate.ts:55`)
already parameterise this. Widening costs evaluation dollars, so it is capped
(§8) and expands deliberately.

---

## 5. Item D — the auto-switch needs a front door

**The defect, as the operator found it.** The auto-switch is real
(`potion-auto` is advertised in `GET /v1/models` —
`apps/server/src/routes/openai-parity.ts:81`; routing is 100% policy + frontier,
`chat.ts:515-538`), but the product barely admits it exists:

- `base_url` and the serving key appear **exactly once**, transiently, after
  clicking "Apply policy & create API key" on `/policy`
  (`apps/dashboard/components/policy-picker.tsx:192-220`). The key is
  **never re-retrievable** (`:206-209`).
- There is **no settings page** — `/settings` has one subpage, `audit`.
- The home page is framed *"Bring your own provider keys"*
  (`apps/dashboard/app/page.tsx:41-46`) — which, after this step, is no longer
  the primary path and actively misleads.
- `baseUrl` is derived from the request `Host` header with a `localhost:3000`
  default and **no configured public base URL**
  (`apps/server/src/routes/dashboard.ts:151-155`) — wrong behind the 13a proxy.
  (13a already sets `POTION_PUBLIC_URL`; this consumes it.)

**The work — one page, "Connect & auto-route":** a durable surface showing the
`base_url`, the serving key (re-issuable, shown once per issue), the bound
policy in plain language (*"quality ≥ 0.9, then cheapest"*), and the **proof it
is working** — recent requests with which model/strategy actually served them,
read from the data already on every response (`x-frontier-trace`,
`chat.ts:258-271`). Re-frame the home page so **platform serving is the default
path and BYOK is the option**, which is the honest ordering after this step.

---

## 6. The landmine: setting a live key flips `providerMode` globally

**This will change routing for every org the moment the key is set, and it must
not be discovered in production.**

`ctx.providerMode` is decided **once at boot** by env-key presence
(`context.ts:288`) — it is not per-org and not per-request. And
`guardFrontierProvenance` (`apps/server/src/routes/chat.ts:235-254`) discards
any frontier containing a point whose `providerMode !== 'live'` when the server
is live (`:243-252`).

So on a server that today runs mock (no provider keys), **adding
`OPENROUTER_API_KEY` flips the whole server to `live`, and every
mock-provenance frontier — including the seeded platform frontiers — is
refused.** Traffic then silently rides `liveDefaultStrategy` (cheapest priced
entry in a band, `context.ts:82-93`) with `provenance=blocked`, `fallback=1`.
That is *correct, honest behaviour* (it refuses to serve mock-derived evidence
as live), and it is also a routing change nobody would predict from "we added a
key."

**Handling, decided here rather than discovered:** before/with the key going
live, the platform frontiers must be **re-measured live** (the platform sweep
already exists and is env-gated and budget-gated —
`handlers.ts:3306-3311`, `:3359-3368`, metered under the reserved
`org_platform_ops` org, `:3232`). Until a cluster has live-provenance platform
evidence, that cluster's traffic honestly rides the fallback, and the step's
status doc says which clusters are in which state. The `hasLiveEvidence`
"once live, never regress" taint rules (`packages/pareto/src/recompute.ts:421-436`)
keep it from sliding back.

---

## 7. Why self-serve cannot ride this step (and what would be needed)

The operator wants self-serve. Stated plainly: **platform serving + open signup
= strangers spending our OpenRouter balance.** Three specific facts make that
unsafe today, all verified:

1. **The budget hard stop fails OPEN on a db error** —
   `apps/server/src/routes/budgets.ts:78-80`. Under BYOK a fail-open costs the
   customer; under platform serving it costs **us**.
2. **Rate limiting is per-API-key only** — the bucket key is `key.id`
   (`middleware/ratelimit.ts:237`). There is **no org-level and no
   platform-wide limit**, so N keys = N × the cap. And it is per-replica (F18).
3. **Soft budgets never block** (`budgets.ts:64-68`), and a brand-new org has
   no cap at all unless one is set.

**Therefore, for this step:** platform serving is enabled **per-org, by the
operator**, for onboarded partners, with a **required** hard-stop monthly cap —
an org may not be platform-served without one. `POTION_SELF_SERVE` stays unset.
The three items above are the concrete abuse-control backlog that 13b must
clear before strangers touch a platform key, and they are now named rather than
implied.

---

## 8. Cost, caps, and what gets proven

- **Serving spend** is the customer's traffic, bounded per org by the required
  hard-stop cap (§7) and metered as platform-paid (§3).
- **Measurement spend** (widening frontiers, §4) is the discretionary cost and
  is capped explicitly per sweep, ledgered in `tasks/todo.md` projected vs
  actual vs cumulative, under `KEY_RISK_ACCEPTED` — the standing convention.
- **Verification spend for this step: ≤ $5**, enough to (a) scan the catalog
  ($0 — `/models` is free), (b) run one live platform sweep on one cluster to
  produce genuine live-provenance evidence, and (c) serve a handful of real
  requests end to end.

**Proven walkthrough-style:**
1. A scan ingests the live OpenRouter catalog **into the database**, survives a
   simulated redeploy, and takes effect without a boot.
2. An org with **no BYOK key** serves a real request on the platform key,
   routed by its policy from a **live-provenance** frontier point.
3. `request_logs` shows that request as **platform-paid**, with the provider
   recorded; the invoice for that period bills it at cost + margin, and a
   BYOK-paid request in the same period is **excluded** from the billed total.
4. An unmeasured catalog model is **visible and not auto-selected** — the
   dial-honesty property, asserted by test.
5. The org's hard-stop cap kills mid-run spend (the 13a proof, now on a
   platform-paid org).
6. The "Connect & auto-route" page shows base_url, key, policy, and the last N
   requests with the model that actually served them.

---

## 9. Risks

- **Registry migration touches the boot path.** `prices.json` is read at boot
  by both server and workers; moving it to the db without a seed path would
  brick a fresh database. The seed must be part of the same change.
- **`GET /v1/models` currently advertises the entire price table**
  (`openai-parity.ts:73-91`) with no filtering. After a full-catalog scan it
  would advertise 338 models as if all were routable — directly contradicting
  §4. This surface must distinguish catalog from frontier.
- **Alias collisions at scale.** `aliasForOpenRouterId` disambiguates with
  `-2`, `-3` suffixes (`scan.ts:31-41`); at 338 models collisions become
  ordinary, and aliases are used in cache keys and strategy configs. Alias
  stability across scans needs a test.
- **Provider diversity degrades.** `crossProviderPeers` filters on the
  `provider` field (`registry.ts:82`), so every OpenRouter-routed model counts
  as **one** provider — the ensemble template's diversity intent quietly
  weakens when everything routes through OpenRouter.
- **Single point of failure.** All traffic through one vendor's key means an
  OpenRouter outage is a total outage — and F19 (breaker/hedging dead in prod)
  means it becomes latency, not fast failure.
- **Margin risk.** Serving at cost + margin with per-token upstream pricing
  means a customer's expensive-model traffic is our cost until invoiced. The
  per-org cap is the only thing bounding it.

---

## 10. Definition of done

The catalog lives in the database and survives a redeploy; a BYOK-less org
serves real traffic on the platform OpenRouter key, routed by its policy from
live-provenance evidence; every serving row records who paid and the invoice
bills only platform-paid spend at cost + margin; unmeasured models are reachable
but never auto-selected (dial honesty, test-asserted); each platform-served org
has a required hard-stop cap and it provably kills spend; the "Connect &
auto-route" page makes the auto-switch visible with its own proof; the
`providerMode` flip (§6) is handled deliberately with per-cluster state
recorded; `POTION_SELF_SERVE` remains unset and §7's three abuse-control gaps
are filed by name for 13b. Verify unfiltered.
