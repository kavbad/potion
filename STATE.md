# STATE — the one file that is always current

**Read this before trusting any other prose in the repo.** Roadmaps, audits,
code comments and research notes are HISTORY the moment they land; when this
file and another document disagree, this file wins, and the other document
should gain a `SUPERSEDED BY STATE.md` stamp when touched. (Rule adopted
2026-08-25 after an external review found stale prose functioning as
executable misinformation for coding agents.)

_Last updated: 2026-09-01 (core-API review ladder: ALL P0s closed — one
resolver, lower-bound law, serve-time router stamping, prod research live,
shadow judge + shadow evidence on the router artifact)._

## What Potion is (current thesis)

A continuously self-optimizing inference layer that turns quality, cost and
latency requirements into the cheapest **measured** execution plan — with a
receipt on every answer and gates that can refuse. Positioning sentence:
*others predict which model should work; Potion measures what actually
clears your bar.*

## Current truths

- **Serving**: live at withpotion.com (Hetzner + Render PG17). Routing is
  request-classified, **workload-level** optimized (per-cluster frontiers +
  policy). Per-invocation conditional routing is a NAMED FUTURE direction,
  not current behavior — copy must not claim per-request difficulty routing.
- **Model field** (migration 0058): `potion-auto` routes; a known model name
  pins; an unknown name 400s; `route_all_models` is the explicit org-level
  migration escape hatch.
- **Payments**: Stripe rails implemented (Checkout setup mode with currency
  + client_reference_id; off-session charges name their payment_method;
  signed webhooks; idempotent per-period charges) but **NOT yet proven with
  a live key** — the release-blocking test is: real card → Checkout → close
  browser → off-session charge → webhook → invoice marked paid. Charging is
  OFF until the operator pastes keys and that test passes. The old
  `billing/backend.ts` stub is legacy.
- **Pricing model (DECIDED 2026-08-25, operator)**: pricing v2 —
  **at-cost pass-through + 25% share of verified savings**, computed from
  the serve-time counterfactual the rollup now persists (migration 0059).
  Save nothing → Potion earns nothing above cost. Implemented end to end
  (invoice, HTML render, billing page, landing); charging itself remains
  OFF until the Stripe sitting. marginPct machinery retained at 0.
- **Core-API review ladder (external review 2026-08-31, verified
  claim-by-claim by fan-out agents — none refuted): ALL P0s CLOSED by
  2026-09-01.** The measured floor is the written floor end-to-end (0.5
  clamp dead on propose AND apply, 49f675f+f5b100c). ONE RESOLVER: the
  serve chain lives in @potion/pareto (`servingDecisionFor`) and the
  compiler, the learning period and the serve path share it — the learning
  bypass with the INVERTED infeasible fallback is dead (cae78d4). Floors
  are PROMISES: every feasibility site gates on the Jeffreys lower bound;
  rankings stay mean-based (3949947). Receipts name the version that
  SERVED: request_logs.router_version stamped at serve time on exact
  content match, `;router=vN` on the trace, reconstruction demoted to
  backfill (3709743). Prod research measures the REAL world
  (POTION_RESEARCH_PROVIDER=live in prod compose, 06f5395). The shadow
  plane is closed into evidence: candidates are judge-scored IN-PROCESS by
  the serve judge — one scale with quality_samples, no text on the queue,
  Jaccard scorer and queue leg retired (5b42bba) — and the router artifact
  carries "on your traffic" evidence per assignment: Jeffreys intervals,
  measured-vs-measured costs, and a lower-bound-gated challenger
  `qualifies` flag; read-only, never mints a version (3528019). Landing
  bullet corrected ("combinations nobody else has" / "measured on release"
  gone); README names the Chat-Completions surface and the /responses
  AI-SDK trap. Still open from the review, operator-call tier: savings
  "verified" wording + hero "half"/"49%" + redaction copy; then the P1
  ladder (see ROADMAP.md §G).
- **Capability mixing: CLOSED** (five pre-registered negatives, ≈$13; public
  note at /research/the-mixing-verdict). No further mixture legs; the weekly
  saturation alarm owns the reopening condition. verify-pick and
  majority-by-execution remain in the toolbox as serve-time confidence
  instruments, not routing shapes.
- **Journey-grain**: measured on our synthetic corpus — routed ≈ best
  monolith end-to-end at 3.2× cheaper; beats the premium default at 7.1×.
  Partner traffic adjudicates for real.
- **Instruments**: code-gen-hard-v2 / classification-hard-v2 serve the map;
  champions ace them (crowns are ≥-bounds; the frontier prices the gap).
  Judge calibration answered on every deterministic cluster (judges FAIL
  reference-free rule-application; anchored extraction r=1.000 twice).
- **Email**: LIVE via Resend (sign-in links, alerts). Any comment saying
  otherwise is stale.
- **Frontier Notes**: publish weekly, autonomously, under the fail-closed
  redaction gate. The operator's formal yes/no on autonomy is still pending;
  current default is publish.
- **Potion Lab**: UNPAUSED (2026-08-26, operator order; external review integrated). Direction v2: graduated autonomy purchased with evidence — risk-aware graduation (4 tiers incl. never-graduates), no scalar trust score (permission ledger), tighten-automatic/loosen-by-proposal, sampled audit never graduates away, OpenClaw as first external runtime target. THE FULL SPINE SHIPPED (L-G1 evaluator · L-G2 evidence · L-G3 permission ledger · L-G4 OpenClaw adapter): external runtimes govern through 4 bearer-key /v1 gate routes (external sessions are lab_runs — one machinery); @potion/lab-openclaw plugin maps before_tool_call→pore (never offers allow-always; unreachable → fail closed to supervision). Next: first live OpenClaw instance under the gate (operator sitting or partner), sampled-audit review UX, spec-slot risk tiers.

## Current blockers (all operator-side)

Stripe keys + live charge test · legal skim (terms/privacy + structural-
findings clause) · the partner name.

## Current work queue (mine, in order)

Redesign track COMPLETE (2026-08-25): brief v4 built S1–S4 — receipt
primitives + printed first-run, Receipts ledger with live tail, Today's
pulse + bar proposal, Evidence rail, docs overhaul, Savings with the kept
counterfactual, the Monday Brief (in-product; emailed edition deferred,
rides the same composition), final nav (Today · Receipts · Evidence ·
Savings · Try · Settings · Docs). Next: instrument enlargement
(extraction, rewrite-edit) · then per the roadmap ledger in
`tasks/todo.md` (the ledger is append-only history; this file is the
summary). **Core-API ladder next (G1, sequence adopted from the 2026-08-31
review — protect it):** Outcome API SHIPPED (10d7876, SPEC §16 — the
application is now the measurement instrument; evidence on the router
artifact as "your app's verdicts") · full-request eval capture SHIPPED
(the sampler keeps the whole served conversation, redacted + parts
stripped; derived items carry it; over-cap excluded, never truncated;
tool/attachment samples excluded from suites with a named count) ·
challenger promotion SHIPPED (shadow-qualified challenger measured beside
serving on the org's own suite; retention-lower-bound gate mints the
proposal; apply mints the ORG frontier — the first customer-specific
serving frontier — and selection's lower-bound law still decides) ·
randomized incumbent holdout SHIPPED (0086: consent-gated ≤5% slice,
labeled everywhere it lands; Savings' "Verified savings" block = the only
"verified" in the product, lower-bound billable). G1 COMPLETE, and the INVOICE BASIS IS SWAPPED (0086 follow-through): the
savings share bills 25% of the holdout-verified LOWER bound only — the
estimated counterfactual is labeled "projected, not billed" context; no
live baseline → pure at-cost. The review ladder's engineering is DONE;
charging turns on at the Stripe sitting and the first invoice is honest. G2 rung 1 SHIPPED: org workload discovery (0087 —
consented samples clustered within each serving cluster; observed-only
snapshot with medoid exemplars + cohesion on the router page; refreshed
after each learning period). G2 rung 2 SHIPPED: per-workload
measurement (0088 — each discovered workload's own suite measures the
serving pick vs the incumbent on THAT work; eval rows at the workload-id
coordinate, org-scoped). G2 rung 3 SHIPPED: workload adoption (0090 —
adopt/retire routes turn a MEASURED workload into routing: adopt mints the
workload-grain ORG frontier from its own measurement rows by the
challenger-apply rule, and the serve path sub-assigns matching requests
within the parent by the request's own classification vector against
adopted centroids at the discovery-stored threshold; trace carries
`;parent=`, hint path never sub-assigns, guard-blocked/empty workload
frontiers fail OPEN to the parent; discovery snapshots preserve adopted
rows and skip their territory; adopted assignments ride the router
artifact + serve-time stamping; sampling stays parent-grain). **G2 rung 4 COMPLETE — ROUTER GENERATIONS (0092/0093,
c96e979 + c8d6ed4 + aff0bac): stage → canary → promote-on-evidence →
rollback.** A
generation = the whole routing surface captured as frontier ids, with a
lifecycle (candidate → serving → superseded | rolled-back). Serving needs no
new concept — getServingFrontier already honours a pin — so promote writes
the pin set atomically and rollback writes the previous one's; a generation
stores the WHOLE surface (never a diff) so "put it back" needs no replay,
and promoting RELEASES clusters it does not name. Capture uses a new
`ignorePins` option (serving never passes it): reading through the pins
would make each generation capture its predecessor, so promotion could never
advance — caught by its own e2e. CANARY (0093): a per-request
`overrideFrontierId` lets a slice resolve each cluster to the candidate's
frontier, decided once per request before any cluster resolves; candidates
only, one at a time, rate capped 0.5 in the repo AND re-clamped on the serve
path; labeled `;canary=<id>` + request_logs.generation_id, both cleared on a
holdout row. EVIDENCE GATE: the canary's rows vs the promoted routing's over
the same window (holdouts excluded from BOTH sides), refusing promotion only
when the intervals do not overlap — thin or merely unflattering evidence
never blocks, because a gate that fires on noise teaches an operator to
override reflexively. The override is recorded on the generation with what
the evidence said. G2 is now closed. **GAP PASS
2026-09-02** (six gaps, ranked by what most raises the odds): (1) the
Outcome API was UNDOCUMENTED — the deepest instrument, invisible to every
customer; /docs gains an Outcomes section, llms.txt indexes it, and a
dashboard invitation appears on proven routed traffic with no verdicts
(also fixed: five docs sections existed but were missing from the nav).
(2) RouterArc rendered ONLY in the no-traffic branch, so the loop went
dark exactly when it started running — components/loop-status.tsx now
reports live state per mechanism, and the arc's stale copy (bar proposals
only; "Savings totals what you kept") was corrected to name challenger
promotion, adoption, and estimate-vs-measured. (3) `evidence_ready`
alert event: challengers and measured workloads were landing silently.
(4) scripts/deploy-prod.sh — every rule that bit us made executable
(.env* exclusion, one service at a time, pipefail, committed-tree gate
incl. UNTRACKED files, dry-run default, --rollback). (5) boot gate report
(apps/server/src/boot-report.ts) — the 2026-08-27 scaffolded-empty
SELF_SERVE class, closed: every security/billing gate logs resolved state
+ whether it came from an explicit value, unset, or EMPTY. (6) HA
remaining work VERIFIED bounded, not built: checkBudgetHardStop reads
shared DB state and caches only the answer, so N replicas cost one TTL of
staleness, never an N× cap; the real multiplier (F18) is fixed, and a
prod box without REDIS_URL now warns at boot. Next: generations
(shadow/canary/promote/rollback); Stripe is engineering-complete and
waits only on the operator's account. Eval-quality queue (second
external review, adopted 2026-08-25):
boundary-honest intervals DONE (generalized-Jeffreys [lo,hi] pair on every
aggregate + frontier evidence; qualityCi95 kept as the conservative
half-width; 42/42 now reports a ≥-bound, not ±0.000) · locked
confirmation-suite mechanism DONE (manifest `locked` flag, fail-closed in
loadSuiteV2, `--confirmation`/suitePurpose unlock; first locked suites get
authored at instrument enlargement by splitting new items dev/holdout) ·
journey completion as a first-class instrument DONE (one journey = one
EvalItem: `journeySteps` chain with {{prev}} templating, same strategy every
step, only the FINAL artifact scored — `field-contains` dotted-path scorer
promoted from the experiment; suite journey-e2e-v1, 9 journeys, cluster
'journey', deterministic ends only; preflight prices every step) · NEXT:
targeted messy-corpus seed (real scanned PDFs, noisy audio).

## North star

First design partner on real traffic; everything Phase C fires from that.
