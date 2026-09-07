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

- **Promotion evidence floor** (P0-4, 2026-09-05): the §15.4 gate had NO
  minimum sample size and the call site guarded only `pairs.length === 0`, so
  a SINGLE paired item promoted — a percentile bootstrap over one delta
  resamples the same value and reports a point as a 95% CI (measured: n=1
  quality path promoted on `ci95 [0.0999…, 0.0999…]`). Fixed:
  `PROMOTION_MIN_PAIRS = 5`, mirroring GUARANTEE_MIN_SAMPLES and
  SUITE_VERIFY_MIN_PAIRS; below it the gate returns a typed
  `refusal: 'insufficient-evidence'` — declining to judge, which is a
  different fact from judging and saying no. The BOOTSTRAP branch had the
  same hole and never went through the gate at all; it now carries the same
  floor, because a first frontier is the one publication nothing downstream
  can correct by comparison. Promotion reasons now record `n`, so a
  zero-width interval can be read in context: legitimate at n=30 from
  identical deltas, meaningless at n=2. Deliberately NOT also a width test —
  the floor subsumes it, and refusing zero-width intervals outright would
  refuse correct verdicts. VERIFIED against live traffic the same day: two
  persisted cycles re-run under the floored gate promoted on `n=30` — the
  zero-width interval came from thirty identical paired deltas, the legitimate
  case the width test would have wrongly refused.
- **Classifier outage is survivable** (P0-1, 2026-09-05): the embed call is the
  hardest dependency on the serve path — every classified request waits on it —
  and it had NO resilience (`resilient()` passed `embed` through untouched) and
  NO try/catch at the call site, with no `setErrorHandler` on the instance. An
  embeddings outage or hang was a bare 500 for EVERY org, including orgs whose
  traffic routes entirely to another provider. Measured: an unsettling embed
  hung the caller indefinitely — it hung its own test suite. Fixed on both
  halves. `embed` now carries a per-attempt deadline, bounded retry (embedding
  is idempotent) and its OWN breaker key `<provider>:embed`, so an embeddings
  outage cannot open the completion breaker for a model that is answering
  fine; the mock-determinism objection did not survive contact — a timeout
  changes WHEN a call gives up, not WHAT a deterministic embedder returns, and
  a test pins that. The call site catches and leaves `ranked` undefined, which
  is the state a cluster HINT already leaves, so the existing branch routes to
  `general` with no new machinery. The receipt says so: `classifier=unavailable`
  on the trace, present ONLY on a degraded answer — a request that legitimately
  matched nothing is a correct classification and carries no label.
- **The assignment cache is bounded** (P0-2, 2026-09-05): it was a plain
  process-lifetime `Map`, never evicted, while a comment in chat.ts called it
  "the assignment LRU" — which is what let it pass review. Each entry holds a
  384-dim embedding plus the ten-cluster ranking, ~3-4KB, one per distinct
  prompt prefix, written from three routes: an OOM with a reassuring name.
  Replaced by the LRU that comment claimed (`apps/server/src/assign-cache.ts`):
  size cap 10k (~35MB) AND a 1h TTL, both env-tunable and neither reachable
  below 1 by typo. TWO bounds because one is not enough — the cap is the memory
  ceiling, the TTL is the correctness one, since a cached ranking is a decision
  made against centroids that move. `get` re-inserts, so it is least-recently
  USED and not a FIFO wearing an LRU's name. Stats (entries/hits/misses/
  evictions/expiries vs cap) on `/healthz`, counted rather than derived: a hit
  rate rebuilt from request logs cannot see an eviction. The chat.ts comment
  now says cache, not LRU.
- **The assignment cache key covers what was embedded** (P0-3, 2026-09-05): it
  hashed `join('\n').slice(0, 512)` while all three call sites embedded the
  join UNTRUNCATED, so two requests sharing a 512-character prefix got the
  FIRST one's classification. Worst on agent traffic, the target workload
  class: in a long session the first user turn carries the task and usually
  exceeds 512 characters, so every later turn silently reused turn one's
  cluster. Fixed by hashing the whole join — the truncation bought nothing,
  since sha256 is fixed-width whatever it is given, so there was never a
  key-size argument. Cost is microseconds of hashing against an embedding call
  that costs milliseconds and money.
- **A cycle's promotions are corrected for the family** (P1-1, 2026-09-05):
  every candidate in a cycle is tested against the SAME incumbent at a 95%
  bound, with no family-wise correction anywhere. Measured over 400 seeded
  cycles of 20 pure-noise candidates (true delta 0, equal cost, so only the
  quality path is open): per test 2.60% — the nominal one-sided 2.5%, so the
  interval itself was never broken — but **41.5% of cycles false-promoted**,
  0.52 false promotions per cycle. Fixed with Bonferroni: `alpha = 0.05 / m`
  where m is the number of candidates the cycle will actually gate-test
  (`promotionFamilySize` — a hash off the frontier or the incumbent itself is
  skipped and is not a test). Measured after: per test 0.45%, **FWER 8.7%**.
  `comparisons` is a REQUIRED argument to `evaluatePromotion`, not an optional
  threshold: a gate that does not know its family size is the defect, so
  dropping the wire is a compile error. A corrected alpha also asks for a
  percentile the resample set must contain — at m=20 the 0.125th, which 1000
  resamples put at index 1.25 — so resamples are floored at `10 / (alpha/2)`;
  at m=1 that floor is 400, below the SPEC's 1000, so **every verdict recorded
  before the correction reproduces bit-for-bit**. Reasons name the real level
  ("CI99.75% (Bonferroni over 20 comparisons)"), never "CI95".
- **HONEST RESIDUAL on P1-1**: 8.7% is not 5%. Bonferroni's guarantee assumes
  an exact per-test bound; the percentile bootstrap is anti-conservative in
  the far tail at n=30 over a distribution that is 80% ties, and the gap is
  flat from 4k to 16k resamples — it is not a resample-count problem. Closing
  it needs more heldout items per pair or a BCa interval. Asserted in the
  test, not papered over.
- **The cost path is a test now, not a coin flip** (found while proving P1-1,
  FIXED 2026-09-05): `costCutPct >= 20% && ciLower >= 0` had two defects, both
  simulated before either was fixed.
  **(1) The bound was a floor artifact.** A percentile bootstrap resamples only
  outcomes the sample contains, so a sample with no losing item has every
  resample mean >= 0 and a lower bound pinned at exactly 0 — at every alpha,
  which is why the P1-1 correction moved it only 16.5% -> 14.5%.
  **(2) No power at any sample size.** A one-sided bound on a candidate whose
  true delta is 0 sits below zero however much evidence there is, so `>= 0`
  was passed only by luck: a candidate that truly held quality promoted in
  60.5% of cycles at n=30, 5.0% at n=300, 8.0% at n=1000 — flat noise.
  Fixed with a downside-honest bound (one pseudo-observation at minus the
  magnitude the sample itself showed, weight 1/(n+1), so it vanishes as
  evidence accumulates exactly as the rule of three does; an ALL-TIES sample
  shows no scale, so it falls back to the worst drop the quality scale allows)
  plus an explicit non-inferiority margin `DEFAULT_COST_QUALITY_MARGIN` =
  0.015, dialable at `POTION_RESEARCH_COST_QUALITY_MARGIN`. Measured, same
  simulation, 20-candidate cycles:

  | | before | after |
  |---|---|---|
  | truly 5pts WORSE, n=30 | 14.5% | **0.0%** |
  | 97% ties / 3% catastrophic, n=30 | **100%** | **0.0%** |
  | all ties, n=30 | 100% | 0.0% |
  | truly HOLDS quality, n=30 | 60.5% | 1.0% |
  | truly HOLDS quality, n=300 | 5.0% | **56.7%** |
  | truly HOLDS quality, n=1000 | 8.0% | **100%** |

  Power now RISES with evidence — under the old rule it fell.
- **TWO CONSEQUENCES of the cost-path fix, both deliberate.** First, **the cost
  path cannot fire on a 30-item heldout set**, which is the truth about 30
  items and not a regression; it needs roughly 300 paired items for a coin's
  chance and ~1,000-2,000 to be reliable at m=20. Cost-path promotions are the
  concrete thing a bigger extraction suite would buy. Second, **a promotion may
  knowingly accept a regression up to the margin** (a measured 1pt dip at a 50%
  cost cut now promotes) — that is what a non-inferiority margin means, the
  reason text says "quality held to within 1.5pts" and never "quality held",
  and the evidence needed scales as 1/margin^2 (0.5pt would want ~18,000
  items). Watch for a ratchet: each promotion moves the incumbent.
- **CORRECTED by the cost-path fix**: the P0-4 argument that an all-ties sample
  above the pair floor is a legitimate cost promotion. The interval-width half
  of that argument holds; the conclusion did not. A candidate that ties 97% of
  the time and fails catastrophically 3% of the time shows all ties in 40% of
  30-item samples, and the old rule promoted it in 100% of cycles. The review
  was closer to right than it was given credit for.
- **The dev-auth bypass fails CLOSED** (P1-2, 2026-09-05): `devAuthBypassEnabled`
  resolved an unset `POTION_DEV_AUTH` as `NODE_ENV !== 'production'`, and the
  bypass resolves an UNAUTHENTICATED `/api/*` request to the default org with
  role **admin**. An unset NODE_ENV is not 'production' — and neither is
  'Production', 'prod', or 'production ' — so every one of those opened it. The
  dashboard's whole security posture rested on one string being present and
  spelled right, in a repo whose only production incident (2026-08-27) was a
  variable that WAS present and empty. Now an allow-list: on only for
  `development`/`test`, so anything unrecognized — including nothing — is
  treated as production. Empty/whitespace `POTION_DEV_AUTH` is UNSET (falls to
  the default), not a deliberate off. Local dev names itself:
  `apps/server` `dev` script sets `NODE_ENV=development`.
  Not exploitable on the live box as it stands — the Dockerfile and
  `deploy/docker-compose.prod.yml` both set `NODE_ENV=production` — which is
  the point: this was the only thing standing between a missed env var and
  anonymous admin.
- **A fatal boot gate REFUSES the port** (HARDENING-PLAN P2.1, built with P1-2,
  2026-09-05): `GateReport.fatal` joins `warn`; `POTION_DEV_AUTH=1` with
  `NODE_ENV=production`, and magic-links-in-response with self-serve signup in
  production, are fatal; `logBootGates` throws `BootRefusedError` and
  `index.ts` prints the gate plus its remedy and exits 1. The 2026-08-27 class
  was a gate that reported its state and did nothing about it — a warning in a
  deploy log is only read by someone already looking. The report also now calls
  the real `devAuthBypassEnabled` rather than a second copy of the rule, so the
  boot log and the running server cannot disagree about whether authentication
  is on.
- **The worker can run off the server** (P1-3, 2026-09-05): `buildServer`
  called `runWorker` unconditionally — every server was also a worker and
  there was no way to build one that was not. Node runs ONE event loop:
  measured here, loop lag maxed at **2ms idle and 1188ms during a single
  in-process job**, freezing every in-flight request including streaming
  ones; the two halves also shared a heap, a memory limit and a fate.
  `POTION_WORKER=off` now builds a server that enqueues and never consumes,
  and `apps/server/dist/worker.js` is a standalone consumer. ONE handler
  wiring (`worker-runtime.ts` `startPotionWorker`) used by both processes — a
  worker resolving its own prices path or embedder is the prices.json
  contamination class again. `app.potionWorker` exposes the handle (or null)
  so a deployment can assert what a process is doing rather than assume it.
  **The default is unchanged**: unset or EMPTY `POTION_WORKER` = in-process,
  which is right on one box; an unrecognized value keeps work HAPPENING and
  the boot report names it (the other default would let a typo silently stop
  every cycle, sweep and alert). Deploy: `deploy/docker-compose.prod.yml`
  gains a `worker` service behind `profiles: ["split"]`, so without
  `--profile split` the deployment is byte-identical. Runbook §10.
- **TWO refusals guard the split, and ONE gap remains.** `POTION_WORKER=off`
  on the memory driver refuses to boot, and a standalone worker on the memory
  driver refuses to start — a process-local queue nobody can reach swallows
  every job silently, forever. **NOT detected**: `POTION_WORKER=off` with
  Redis present and no worker actually started; jobs accumulate in Redis and
  the boot gate cannot tell "a worker is coming" from "nobody is consuming".
  Check `docker compose ps worker` after flipping the dial. An automatic
  liveness proof is not built.
- **Also found by P1-3**: the standalone worker booted, printed "consuming 24
  job kinds", and EXITED — a worker has no listening socket, so the only thing
  holding its event loop open was the queue driver's own connection. Now an
  explicit non-unref'd keep-alive, cleared on shutdown. And
  `resolveQueueKind()` is exported from `@potion/queue` so the driver
  precedence has one implementation rather than a second copy in the boot
  report — the same lesson as P1-2's duplicated auth rule.
- **The environment is inventoried, and the inventory is a guard** (P2,
  2026-09-06): the review said "82 env flags in code, 28 in .env.example".
  Measured properly the gap was worse — **100 distinct variables read in
  shipped source against 29 documented**, and among the 71 undocumented were
  `STRIPE_SECRET_KEY` (whether real money can move), `REDIS_URL` (whether the
  rate limiter spans replicas — the F18 class), and `POTION_DEV_AUTH` (whether
  /api/* requires authentication at all). `.env.example` now declares 96, and
  `scripts/env-inventory.test.ts` fails when a flag is read in shipped source
  and is neither declared there nor listed INTERNAL with a reason. The reverse
  too: it fails when `.env.example` names something nothing consumes.
- **The first version of that scan was wrong in BOTH directions** — worth
  keeping because it is the guard-writing failure mode. Grepping
  `process.env.X` reported 136 read / 29 documented AND claimed
  `RESEND_API_KEY`, `PG_POOL_MAX` and every `POTION_BREAKER_*` knob were read
  nowhere. They are: this repo deliberately reads env through an injected
  `env: NodeJS.ProcessEnv` parameter wherever a value must be testable
  (pool.ts, factory.ts, auth.ts, oidc.ts, boot-report.ts). A scan that cannot
  see how the code actually reads env is a guard that lies confidently.
- **The dead-knob rule nearly deleted a LIVE knob.** `POTION_ROOT_SITE` is
  read by no TypeScript anywhere, so "documented but unread" flagged it and I
  removed it — it is required by `deploy/Caddyfile` for the bare-domain vhost
  and by compose with `:?`, so the next deploy would have failed at startup.
  The rule now CHECKS the deployment files (Caddyfile, compose, Dockerfile)
  rather than carrying an exemption list, so a knob that stops being consumed
  there stops being allowed here.
- **Two flags existed only as prose.** `POTION_BREAKER` (the circuit breaker's
  off switch) was described in a paragraph and never declared, so no inventory
  of that file could see it. Its parser sibling: accepting `# NAME=` as a
  declaration made a wrapped sentence beginning `NODE_ENV=production ...`
  register NODE_ENV as documented. Declarations are uncommented lines now.
- **P1-2 left the type-escape ratchet broken and this checkpoint found it**:
  `logBootGates` took a whole `FastifyBaseLogger`, so a test asserting the
  boot refusal had to cast its fake with `as unknown as` — a fixture checked
  against nothing. Fixed by narrowing the parameter to the three levels the
  function actually uses (`BootGateLog`). The lesson is the running one: the
  budget is never the thing to raise, and `pnpm vitest run scripts/` is part
  of a checkpoint, not an afterthought.
- **jeffreysCi assumes independence and cannot tell when it is wrong** (P2,
  2026-09-06): its own docstring had named this as an unbuilt follow-up since
  2026-08-25. Measured (3000 seeded trials, true p = 0.90, nominal 95%):

  | evidence | coverage | lower-bound overclaim | width |
  |---|---|---|---|
  | 60 independent items | 95.1% | 1.0% | 0.148 |
  | 6 items seen 10 times | 90.8% | 2.8% | 0.148 |
  | 4 groups x 25 | 83.2% | 8.4% | 0.115 |
  | 2 groups x 50 | 72.5% | **14.7%** | 0.113 |

  **The width is the tell**: identical for 60 independent items and for 6 seen
  ten times, because nothing in the input says which it is. The lower bound is
  what every floor, graduation and qualification decision reads.
  Fixed with `clusteredQualityCi` — a CLUSTER bootstrap (resample groups, not
  observations), seeded from the evidence via `seedFromString` so it stays
  re-derivable with no stored seed, unioned with Jeffreys so an all-ones
  sample still never reports certainty, and returning `jeffreysCi` unchanged
  when every group is a singleton.
- **THE FIRST VERSION OF THAT TEST PROVED NOTHING.** It asserted coverage
  (91.5% -> 95.7%, true), and a mutant that resampled OBSERVATIONS instead of
  groups — the naive bootstrap, which models no clustering at all — PASSED it:
  the union with Jeffreys widens the interval either way, and at n=60 that
  alone recovers the coverage. The property that actually separates them is
  width RESPONDING to group size at fixed n. Measured at n=60, group size 1 to
  20: `jeffreysCi` 0.1492 -> 0.1445 (flat), naive bootstrap 0.1607 -> 0.1554
  (flat), cluster bootstrap 0.1492 -> 0.1810. The naive mutant now dies by
  name. Coverage is still asserted, but as a consequence, not as the proof.
- **Wired where the metadata exists, and NOT where it does not.**
  `lab-runtime/graduation.ts` has `situation` fingerprints and now groups by
  them on both paths — earning (the repeat cap already refused to let volume
  buy trust; this refuses to let it buy CONFIDENCE) and drift, where a wider
  interval can only make revoking a human's grant more reluctant.
  `pareto/outcome-evidence.ts` and `pareto/shadow-evidence.ts` have NO
  grouping key at all — `OutcomeRowLike` carries requestId, cluster, strategy
  and no customer or session id — so they keep `jeffreysCi` and the limit is
  named in the docstring rather than papered over with a fabricated grouping.
- **HONEST LIMIT, asserted**: a cluster bootstrap over 2 groups has three
  distinct resamples in the world. Coverage 72% -> 76%. That is two units of
  evidence, not an estimator defect; the remedy is REPORTING the group count,
  which nothing does yet.
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
