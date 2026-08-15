# Step 12 spec — Adversarial pass on the Lab surface

Phase one per `docs/LAB-BUILD-PLAN.md`. This step is **judged by what it
catches**, not by what it proves. Every prior step ended by asserting its own
correctness; this one is paid to falsify those assertions. It also carries
Step 10's bound obligations (§7).

Binding inputs read before writing: the plan's Step 12 entry and the Gate C
step it precedes; `docs/LAB-BUILD-STATUS.md`; and every deferral, residual
and named Step 12 target across the Lab specs (Steps 3–11) — gathered into
§2 rather than left scattered.

**Done when** (plan, verbatim): findings are filed with severities, all
criticals fixed and pinned by tests, and the Lab's route inventory is
complete and classified.

## 1. Scope and method

**In scope.** The Lab surface as built: spec parsing (Step 2/3), the MCP
boundary (Step 10/11), token custody (Step 10), spend paths (Steps 5–8, 10),
and the tenancy + authz of all 19 `/api/lab/*` routes against the existing
inventory lenses — plus the runtime loop that ties them together (pore,
checkpoint gate, caps, redactor) and the catalog format's honesty gates.

**Out of scope, named:** the guarantee product's own surfaces except where a
Lab path crosses them (serving, budgets, request-log metering — the Lab rides
these and the crossings ARE in scope); Step 16's pro instruments; anything
requiring production infrastructure (Step 13).

**Method — four passes, in this order:**

1. **Inventory pass (structural, $0).** Re-derive the route inventory from
   the live route tree, re-run the tenancy and mock-eligibility sweeps, and
   diff Lab routes against every lens. Output: a classification exhibit that
   is complete by test, not by inspection.
2. **Targeted pass ($0).** Every named deferral in §2 gets an explicit
   attempt, each one either reproduced (→ finding) or refuted-in-writing
   (→ recorded as "attempted, not reproducible, here is why"). A deferral
   that is merely *not attempted* is a failure of this step.
3. **Independent pass ($0).** Multi-agent adversarial fan-out with the
   independence rules of §5 — lenses that do not know each other's findings,
   verification by skeptics prompted to refute, and explicit permission to
   falsify the build's own DoD claims (§5 names which).
4. **Live pass (the bound leg, ≤$1).** The real GitHub OAuth grant flow
   (§7), then the MCP-boundary and custody lenses re-pointed at that real
   flow rather than the mock.

**Ordering rule:** structural before targeted before independent before
live. A finding from an earlier pass narrows the later ones; the live pass
runs last so it exercises the code as it will actually ship.

## 2. The target inventory — every named deferral, in one place

Gathered from the specs. Each row is an obligation of pass 2: reproduce or
refute in writing.

| # | Target | Named in | Class |
|---|---|---|---|
| T1 | Injection-string corpus over tool RESULTS — rules-bypass phrasing, role-confusion, nested `SYSTEM:` framing | S10 §3 | MCP boundary |
| T2 | Malicious MCP server protocol fuzzing — malformed JSON-RPC, oversized/slow streams beyond the byte cap, capability lying | S10 §3 | MCP boundary |
| T3 | Exfiltration THROUGH tool arguments — the model induced to send data outward | S10 §3 | MCP boundary |
| T4 | Cross-connector interaction attacks (one grant's data reaching another's call) | S10 §3 | MCP boundary |
| **T5** | **Split-token echo ACROSS multiple results** — a token divided over several tool results, each shard below the fragment floor | S10 §12(1) | Custody |
| **T6** | **Sub-shard reassembly** — shards under `SPLIT_TOKEN_MIN_MATCH` (12 chars), including interleaved/encoded shards; the redactor's known residual | S10 §12(1) | Custody |
| T7 | Arbitrary/layered transforms of a held token — gzip+base64, rot-N, custom encodings (the redactor covers standard whole-token encodings only) | S10 §12(1) | Custody |
| **T8** | **The act/read classification audit** — every one of the 29 act and 87 read classifications re-examined against the vendor's real tool semantics; a tool marked `read` that mutates is a pore that never fires | S11 §11, §2 | Classification |
| T9 | Live-model persuasion resistance — the structural floor holds, but does a REAL model obey an injected instruction? | S11 §4, §11 | Injection |
| T10 | Master key in the worker environment — the custody perimeter now spans two processes | S10 §10 | Custody |
| T11 | Provider-side rate limits / billing are the vendor's; our caps bound our side only | S10 §10 | Spend |
| T12 | Attributed spend is PROVISIONAL (est cost of emitting model steps) — re-derive from observed traffic | S10 §4 | Spend |
| T13 | Fuel is denominated in the flat token-rate ESTIMATE — premium rungs can meter above `maxUsdPerRun` before the est-cap trips | S8 residuals | Spend |
| T14 | `lab:run` reads the catalog row per invocation for `clusterHint` — an in-place edit can redirect remaining legs | S8 residuals | Correctness |
| T15 | A worker crash mid-leg leaves the run `running` until the lease expires | S8 residuals | Correctness |
| T16 | The `lab:run` job executes user-authored missions in worker processes — bounded by fuel/leg caps/serving gates | S8 §"noted here" | Spend / isolation |
| T17 | Filed guarantee-product debt that a Lab path can reach: F8, F9, F13, F14, F15, F16, F17, F18 (F20 withdrawn) | ledger | Mixed |

**T5/T6/T8 are called out by the operator and are non-negotiable targets.**
T8 in particular is a *curation* claim the build made and never verified: the
Step 11 spec says so in writing (§11), and this pass owns it.

## 3. The four surfaces (plan) + tenancy/authz

**Spec parsing.** `parseHarnessSpec` and `scanRawValue` against the
adversarial corpus and beyond it: depth/size bombs past the declared limits,
unicode and homoglyph tricks in rules, control-character survival through the
`/edit` sanitizer, hash-mismatch tamper paths, `__proto__`-shaped keys nested
under arrays, and the duplicated `SECRET_PATTERNS` copies (lab-spec vs the
converter script) drifting apart.

**The MCP boundary.** T1–T4, T9, plus: session-id handling, SSE framing
abuse, a server that changes its tool surface mid-session, `tools/list`
returning a declared name with a hostile schema, and the transport's typed
error paths (the Step 11 review already found one that leaked into context —
assume siblings).

**Token custody.** T5–T7, T10, plus: the split repo surface (can any
route-reachable query be made to select an envelope column?), the import
fences (do they hold under dynamic import / re-export chains?), the OAuth
callback's org-bound state (replay, fixation, cookie-swap), grant
re-grant/revoke races, and master-key rotation over grants.

**Spend paths.** T11–T13, T16, plus: per-tool cap arithmetic under resume
and concurrency (two legs racing the same meter), the daily grant-scope
rollup's UTC-day boundary, `attributedEstUsd` under multi-tool steps, and
whether any Lab path can reach serving without the org budget gate.

**Tenancy and authz of every Lab route.** All 19 `/api/lab/*` rows driven
through the existing lenses: the uniform-404 no-existence-oracle probe (both
credential kinds), the org-list absence probe, the admin/member/viewer role
split, and the inventory-driven grant-absence sweep. Plus the completeness
meta-test: the inventory must equal the live route tree, both directions.

## 4. Finding budget and severity rubric — fixed BEFORE the pass

Both are committed here, in phase one, so neither can be renegotiated by
whoever is tired at the end.

**Severity rubric (assign by evidence, not by mood):**

- **CRITICAL** — cross-tenant data access; credential material reaching any
  durable or visible surface; unauthenticated or unauthorized mutation; spend
  with no enforced cap; an `act` executing without its pore firing.
- **HIGH** — a security control that fails OPEN; a guarantee this build
  *claims in writing* that is false on a production path; privilege
  escalation within an org; a cap or gate bypassable with attacker-controlled
  input.
- **MEDIUM** — correctness defect with bounded blast radius; an honesty
  defect (a surface asserting something untrue) without security impact; a
  resource issue bounded by an existing cap.
- **LOW** — hygiene, dead code, stale comments, test-only concerns.

**The anti-negotiation rule.** A finding's severity is set by the rubric from
its failure scenario at filing time. Downgrading requires a WRITTEN
falsification of the failure scenario (why it cannot occur), recorded beside
the finding — never "it's unlikely", "it's a lot of work", or "we're at the
end of the step". Upgrades need no ceremony. If a finding's severity is
disputed and unresolved, it stands at the HIGHER severity.

**Finding budget.** The pass is bounded by *coverage*, not patience:

- Every §2 target attempted (17 rows) — the floor.
- Fan-out ≤ 40 agent-legs across the four passes; verification is 3 skeptics
  per candidate finding (the Step 10/11 precedent).
- **Termination is a dry criterion, not exhaustion**: the independent pass
  ends after **two consecutive rounds that surface no new confirmed
  finding**. If the budget ceiling is reached while rounds are still
  producing findings, the pass reports *"budget-capped, not dry"* — an
  honest, visible outcome, never a silent stop.
- Spend: **$0** for passes 1–3; **≤$1 fuel** for the live leg (§7).

**Expected yield, stated in advance so a thin result is suspicious.** Given
the priors in §5, a pass that returns **zero HIGH-or-above findings** across
four surfaces is more likely to indicate a weak pass than a clean system, and
will be reported as such rather than celebrated.

## 5. Independence — what gets re-examined instead of trusted

The pass must be able to falsify this build's own claims. Two rules make that
real: reviewers are told the DoD claims are *hypotheses*, and the following
prior proofs are explicitly **re-examined, not trusted**.

**The prior, from this build's own history.** Recent reviews already found:

*Three instrumented-but-inert values* — measured, budgeted, displayed, or
asserted while having no effect on behavior:
1. `usage.preamble` — charged against the token budget and shown in the
   catalog DTO while reaching no model context at all (S11 §14.3, 3/3).
2. `version` inside the package content hash — would have made the
   classification gate's second factor decorative (caught mid-build, S11 §12.7).
3. The classification baseline itself — a committed instrument that the
   documented fix-it command silently reset, so the gate did not bind on the
   path authors actually take (S11 §14.2, 2/3).

*Two byte-identical claims that were false or narrower than worded:*
4. "No server-supplied string reaches model context" — true for `toolDefs`,
   FALSE on the failure path, where a JSON-RPC error's server-controlled
   `message` rode a leg note into the checkpoint and the conversation
   (S11 §14.1, 2/3).
5. The proof of that claim compares only `requestPayload.tools` — so even
   where it holds, "the model context is byte-identical" is demonstrated over
   a **subset** of context. The system prompt and message history were never
   in the comparison. **Named here for the first time**; Step 12 widens the
   comparison to the full `requestPayload` and re-runs it.

**Therefore, assume more exist.** These are the classes the pass hunts by
construction: *the instrument that doesn't measure*, and *the proof whose
scope is narrower than its sentence*.

**Prior DoD proofs re-examined rather than trusted** (each is re-derived, and
its claim is compared against what the test actually asserts):

| Claim | Where | How it gets re-examined |
|---|---|---|
| "No server string reaches model context" | S11 add.1 | Widen to the FULL requestPayload (system prompt + messages + tools); re-run hostile-vs-honest; enumerate every string-typed field crossing the boundary |
| "Exfiltration via spec/report/narration fails by test" | S10 DoD | Re-run the corpus against T5–T7 (the encodings it does NOT cover), and re-check the four-surface absence assertion for surfaces added since |
| "Per-tool caps fail closed" | S10 §4 | Concurrency + resume races; the UTC-day boundary; multi-tool attribution |
| "Structurally unreadable through any API response" | S10 §1 | Re-derive the route list (not the committed one) and re-sweep; probe dynamic-import and re-export paths around the fence |
| "The pore provably fires on external actions" | S11 DoD | Re-examine T8 (is the classification itself right?) and whether any path reaches `tool.run` without the gate |
| "Least-privilege defaults" | S11 §6 | Check the *vendor's* real scope semantics, not just internal consistency |
| "The route inventory is complete" | G2.3/G2.4 | Both-directions diff against the live tree, plus the Lab routes added in Steps 9–11 |

**Structural independence.** Lenses run without seeing each other's output;
verification skeptics are prompted to REFUTE and default to refuted; a
finding survives only on a ≥2-of-3 confirm. Where a claim is this build's
own, the reviewing lens is given the claim text and asked to find the case it
excludes — the shape that caught #4 and #5.

## 6. What a finding looks like

Every filed finding carries: severity (rubric §4), surface, the **concrete
failure scenario** (inputs/state → wrong outcome), code evidence at
`file:line`, the verification vote, and an owner. Criticals additionally
carry a reproducing test *before* the fix. Findings are recorded in
`tasks/todo.md` with stable IDs (`L1…Ln`, the Lab series, distinct from the
guarantee product's `F` series) so later steps can reference them.

## 7. The bound live leg + the operator sitting (write once, follow once)

Step 10's DoD item — per-tool caps tripping under a REAL grant — is bound
here (S10 §13). This section is the sitting, written to be followed once.

**Build-phase prerequisite (a spec-level requirement, not a detail):**
`scripts/step10-live-mcp.ts` currently binds an ephemeral port, so its
callback URL is not knowable before the run — which would force the operator
to create the OAuth app *mid-sitting*. The build MUST pin the port
(`POTION_LIVE_PORT`, default **3210**) so the callback URL below is exact and
the app can be created in advance.

### 7.1 Before the sitting — create the read-only GitHub OAuth app

1. Open **https://github.com/settings/developers** → **OAuth Apps** → **New
   OAuth App**.
2. Fill in exactly:
   - **Application name:** `Potion Lab (local live leg)`
   - **Homepage URL:** `http://localhost:3210`
   - **Authorization callback URL:**
     `http://localhost:3210/api/lab/connectors/github/oauth/callback`
3. **Register application**, then **Generate a new client secret**. Copy the
   **Client ID** and the **secret** — the secret is shown once.
4. **Scopes: none.** A GitHub OAuth app requests scopes at authorize time,
   and this leg requests **zero** — the minimum the handshake allows, giving
   public read + your identity. We deliberately do NOT request `repo`
   (GitHub's `repo` scope is read *and write*, so there is no private-repo
   read scope to ask for honestly). Consequence, stated plainly: the leg
   reads public data and your login. That is enough to trip the caps, which
   is what the DoD requires.

### 7.2 The master key and the env block

```bash
openssl rand -hex 32          # → POTION_MASTER_KEY (64 hex chars)
```

```bash
env -u OPENAI_API_KEY -u ANTHROPIC_API_KEY -u GOOGLE_API_KEY -u GEMINI_API_KEY \
  GRANT_RISK_ACCEPTED=2026-08-13 \
  KEY_RISK_ACCEPTED=2026-08-13 \
  POTION_LIVE_PORT=3210 \
  GITHUB_CLIENT_ID=<client id from 7.1> \
  GITHUB_CLIENT_SECRET=<client secret from 7.1> \
  POTION_MASTER_KEY=<64 hex from above> \
  OPENROUTER_API_KEY=<your key> \
  pnpm exec tsx scripts/step10-live-mcp.ts
```

Every gate is fail-closed: a missing or malformed `GRANT_RISK_ACCEPTED`
refuses (exit 2) before anything is created; so does a missing master key,
missing client credentials, or a set peer provider key.

### 7.3 What you will see, in order

1. `── Step 12 live MCP leg ──` with both risk acceptances and the caps
   ($1.00 fuel / 5 tool calls) echoed back.
2. A printed **authorization URL**. Open it in a browser signed in to GitHub
   as yourself. **You approve by hand — Claude never authenticates.**
3. GitHub's consent screen naming the app from 7.1, requesting no scopes.
4. Redirect to `localhost:3210` → `Connected. The filament is healed.`
5. Back in the terminal (press ENTER): `✓ HEALED` with the granted scope set.
6. **A check-in question** — the before-external-action pore firing *before*
   the first real MCP call: `About to run external tool 'github.get_me'…
   Proceed?` Answer `yes`. Exactly one call runs per approval.
7. The run's ledger block: model steps, metered spend vs the $1 cap, and the
   **redaction proof** (`[REDACTED:grant]` present, raw token absent).
8. The **cap proof**: the tool driven past 5 calls, printing `CAP TRIPPED
   (calls)` — the DoD's "per-tool caps trip live".
9. The **revoke** block: `POST /revoke → 200`, `✓ CUT`, and the after-ledger
   line.

### 7.4 After the sitting — revocation and the ledger

- The script revokes the grant in-product and enqueues the best-effort
  provider-side revocation. **Additionally revoke by hand** at
  **https://github.com/settings/applications** → the app → **Revoke access**,
  so the credential is dead on GitHub's side regardless of our call.
- Optionally delete the OAuth app itself (7.1) — nothing else uses it.
- **Two ledger rows** are appended verbatim from the run's output: grant
  landed (time, scopes, granted_by) and grant revoked (time, provider
  response), plus the metered model spend against the $1 cap.
- Only after a ledgered live run may `github` move to the `live-proven` tier
  (S11 §5), and `LIVE_PROVEN_IDS` gains it in the same commit.

**The db is a throwaway.** The leg runs against a fresh temp PGlite dir; the
sealed grant dies with it. The GitHub-side revocation is what matters.

## 8. Package layout / touches

No new package. The pass produces artifacts and fixes, not architecture:

- `apps/server/test/` — extended tenancy/authz sweeps for the Lab rows;
  re-derived inventory completeness.
- `packages/lab-mcp/`, `packages/lab-runtime/` — the T1–T9 corpora as
  committed fixtures (the Step 10 golden-corpus house style), each failing by
  test before its fix.
- `packages/lab-superpowers/` — the T8 classification audit as a recorded
  exhibit (per-tool verdict with the vendor semantics cited), plus any
  reclassifications (each a declared version bump, per the gate).
- `scripts/step10-live-mcp.ts` — the pinned port (§7).
- `artifacts/step-12-findings.md` — the filed findings with severities,
  verification votes, owners, and fix/defer status. Byte-stable, regenerated.
- `tasks/todo.md` — `L*` finding rows + the live-leg ledger rows.
- `docs/LAB-BUILD-STATUS.md` — the ladder row and the exit statement.

## 9. Test plan

Every confirmed finding gets a reproducing test that FAILS before the fix
(the Step 10/11 discipline). Beyond those: the widened context-provenance
comparison (full `requestPayload`); the T5–T7 custody corpora; the T1–T4
MCP-boundary corpora; a concurrency/resume cap race; the re-derived inventory
completeness both directions; and the T8 audit exhibit's completeness
meta-test (every catalog tool has a verdict). Verify unfiltered, as always.

## 10. Exit rule

The step exits when **all four** hold:

1. **Every §2 target attempted** — reproduced (filed) or refuted in writing.
2. **All CRITICAL findings fixed and pinned by tests**, before Gate C. A
   critical may not be deferred, downgraded, or carried into Step 13 —
   Gate C is the self-serve flip, and criticals are exactly what must not
   meet strangers.
3. **Every non-critical finding recorded with an owner** — a named step
   (e.g. "Step 13 — deploy", "Step 16 — instruments") or an explicit
   "accepted residual, here is why". No finding is closed by silence.
4. **The Lab route inventory is complete and classified**, proven by the
   both-directions meta-test against the live route tree.

Plus the bound Step 10 items: the live leg run and ledgered (§7), and the
adversarial lenses re-pointed at the real grant flow.

**What this pass does NOT cover — stated so the exit is not oversold.** This
is an internal adversarial pass by the same author who wrote the code, using
model-driven review and fixtures. It is **not a third-party security audit**,
not a penetration test against deployed infrastructure, and not a
cryptographic review of the envelope construction. It cannot establish the
absence of vulnerabilities; it can only report what it found and what it
attempted. Specifically out of reach here: real adversary behavior over time,
supply-chain compromise of dependencies, infrastructure and network-level
attacks (Step 13's surface), and vendor-side compromise of a connected MCP
server. Before real customer credentials at scale, an external review is the
honest next instrument — recorded as a standing recommendation, not a task
this step can discharge.

## 11. Risks and pushback

- **Pushback: "criticals fixed" must gate Gate C, not Step 12's own close.**
  The plan puts Step 12 before Step 13; the exit rule (§10.2) binds criticals
  to the *flip*, which is where strangers arrive. If a critical is found late,
  the honest outcome is a delayed Gate C, not a downgraded severity.
- **Pushback: the pass grades its own homework.** Mitigated by §5's
  independence rules and by the prior (five instrument/claim defects already
  found in two steps), but not eliminated. §10's non-coverage statement is
  the honest bound; an external review is the real fix and belongs before
  scale, not before Step 13.
- **T8 may be expensive and inconclusive.** Verifying 116 tool
  classifications against vendor semantics is documentation work against
  APIs, some of which we cannot call. The honest output is a per-tool verdict
  with a confidence and a citation — `verified` / `documented` /
  `unverifiable` — and any `unverifiable` **act-leaning** tool is reclassified
  to `act` (fail-closed) rather than left as a `read` we merely hope about.
- **T9 (live-model persuasion) needs live spend to be real.** A mock model
  cannot be persuaded. Proposed: fold a small persuasion probe into the live
  leg's $1 budget — one injected instruction in a real result, asserting the
  pore still fires — and record the rest as a Step 13+ concern. If the
  operator prefers a strictly $0 pass, T9 is recorded as attempted-under-mock
  with its limitation stated, and the live half is deferred with an owner.
- **A dry pass is not a clean system** (§4). Reported as a possible weak
  pass, never as a victory lap.

## 12. Definition of done (restated)

Findings filed with severities under the §4 rubric; all criticals fixed and
pinned by tests before Gate C; non-criticals recorded with owners; the Lab
route inventory complete and classified by both-directions meta-test; every
§2 target attempted with its outcome written; the bound live leg run,
ledgered, and its grant revoked; and the non-coverage statement (§10)
published rather than implied. Verify unfiltered.

## 13. Build deviations — recorded, never silent

1. **The severity of T5/T6 landed at MEDIUM, not CRITICAL.** The rubric reads
   "credential material reaching any durable or visible surface" as CRITICAL,
   and the split-token attack does exactly that. The downgrade is on a written
   falsification, per §4's anti-negotiation rule: the material a hostile
   server can plant this way is **its own bearer**, which it already holds, so
   the harm is pollution of our durable surfaces rather than disclosure to a
   party that lacked it. Recorded with the finding, not applied quietly.

2. **The sentinel bounds the leak; it does not eliminate it.** Up to
   `SPLIT_TOKEN_MIN_MATCH − 1` characters escape before the trip, and shards
   below `SHARD_MIN_MATCH` (5) evade the detector entirely at a cost of one
   metered tool call per four characters. Both limits are asserted by test so
   they are numbers in the record rather than discoveries someone makes later.
   The floor is 5 and not 4 because 4-grams of a random credential collide
   with ordinary prose often enough that a long run would sever itself — an
   honest trade named in the code.

3. **The L2 fix changed check-in semantics product-wide.** Binding the
   approval to a fingerprint was not enough: on resume the model re-proposes a
   *different* call (the conversation now contains the approval), so a
   fingerprint match would essentially never happen and the pore would re-ask
   forever. The resumed leg therefore REPLAYS the approved call from the
   check-in record instead of asking the model to re-propose it. This is a
   behaviour change beyond "fix the defect", taken because the narrow fix
   produced a control no operator would leave switched on. Four tests and one
   golden fixture encoded the old semantics and were updated with the reason
   recorded in each.

4. **`maxCalls` became a spec field.** The pass found the operator's
   authorized "5 tool calls" was not expressible: `capsFor` had no path from
   the spec, so every run used the library default of 20. Adding
   `HarnessSuperpower.maxCalls` is a product change inside an adversarial
   step, taken because the alternative was to keep a cap the operator agreed
   to and the code could not honour.

5. **`scopeLimits` became part of the package format.** T8 found that the
   least-privilege invariant passed for Salesforce only because
   `update_record` declared `api_write`, a scope Salesforce does not have —
   a test satisfied by a fiction. Where a vendor genuinely offers no narrower
   scope, the package must now say so in writing, per tool, and both the
   validator and the mini-eval demand the reason. Silence fails.

6. **Five tools moved `read` → `act`.** Fail-closed under the accepted
   pushback, with a per-tool confidence recorded in the audit exhibit. Two
   packages (dropbox, discord) additionally lost a default scope, because a
   scope that now supports no read tool has no business in the default grant.

7. **The independent pass ran two rounds, not to dryness.** §4 asks for two
   consecutive rounds with no new confirmed finding; round two still produced
   confirmed findings when the budget ceiling arrived. Reported as
   **"budget-capped, not dry"**, exactly as §4 requires. Five verification
   legs stalled and exhausted their retries, leaving two round-1 candidates
   unverified — recorded as unverified, never as absent.

8. **The rehearsal (addition 2) found four defects in the live-leg script
   itself**, three of which would have wasted the operator's sitting outright
   and one of which would have produced a FALSE PASS on the bound Step 10 DoD
   item. They are in the findings artifact as L12/L13. This is the strongest
   argument for the addition: the script's only previously tested path was its
   refusal path.

## 14. Exit statement

- **Every §2 target attempted**, each closing with a typed disposition in
  `artifacts/step-12-targets.json`; the meta-test refuses an untyped close and
  pins the row set so the table cannot shrink.
- **All CRITICAL findings fixed and pinned** (L2, L3, L4) — before Gate C, as
  §10.2 requires. Both HIGHs and all five MEDIUMs are fixed and pinned too.
- **Non-criticals recorded with owners** (L14, L15 → Step 13; T9/T10/T13/T14/
  T17 in the register).
- **The route inventory is complete and classified**, proven both directions
  against the live route tree.
- **The live leg is staged and rehearsed, not run.** It needs the operator's
  hands. Until it runs, three things stay open and are listed as open: the
  bound Step 10 cap-trip under a real grant, T9's behavioural half, and L15.
- **The non-coverage statement (§10) stands published**: this is an internal
  adversarial pass by the same author, not a third-party audit, and an
  external review belongs before customer credentials at scale.
