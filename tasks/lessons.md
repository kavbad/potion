# tasks/lessons.md — patterns from corrections

Reviewed at session start (CLAUDE.md working conventions). One entry per
correction: what happened, the pattern to apply next time.

## 2026-08-06 — an enforcement cap is itself a behavior change

While fixing the cost estimator (projections must dominate actuals), the fix
enforced `max_tokens=1024` on the openai-shaped transport — correct for the
bound, but I was ready to mark the item done without checking what the new cap
would do to the measurements themselves. Owner caught it: recorded M1b answers
reached 1501 tokens, and analysis showed the >1024 answers were the HIGHEST
quality ones (0.942 vs 0.828 mean), all on agentic-tool-use. A dominating
projection achieved by silently truncating the best answers would have been a
worse defect than the one being fixed — it degrades measured quality exactly
where the product's differentiation story lives.

**Pattern**: when a fix adds an enforcement bound (cap, timeout, limit,
validation), before marking done, check the recorded/production distribution
of the quantity being bounded — specifically the tail ABOVE the new bound and
what that tail correlates with (quality, revenue, latency). If the tail is
real, the bound must be configurable with the dependent calculation bound to
the configured value, not a constant. "The invariant now holds" is not done;
"the invariant holds and nothing it governs silently changed meaning" is done.

## 2026-08-06 — commit hygiene: history starts before the work does

The repo arrived as a zip with no .git; I built a session's worth of changes
on top before version control existed, and reconstructing a reviewable
baseline → fix history required stash/restore gymnastics (possible only
because the zip still existed). **Pattern**: on first contact with any repo
that has no .git, `git init` + baseline commit BEFORE touching anything —
a reviewable diff is part of the deliverable, not an afterthought.

## 2026-08-06 — a judge verdict is a joint property of the whole harness

Calibrating judge-class produced three successive damning verdicts (r=0.05, mAE 0.88;
then r=0.16; then "best judge measured" r=0.54) — and every jump came from fixing the
HARNESS, not the judge: an all-or-nothing rubric mismatched to graded truth, then a
token budget that truncated the judge's reasoning before its verdict line, then a
ceiling-compressed truth distribution that suppressed the correlation itself. At each
step the tempting conclusion was "this judge is untrustworthy"; the true conclusion
twice was "the harness starved or miswired the judge," and once "the corpus can't ask
the question."

**Pattern**: before concluding a MODEL is bad, vary the harness and probe raw outputs —
one direct call showing the actual response text beats ten aggregate scores. A measured
verdict is a joint property of (model × rubric × budget × parser × corpus
distribution); a calibration record that doesn't pin all five is not reproducible
evidence. Check score DISTRIBUTIONS (not just means/correlations) before finalizing:
ceiling/floor compression silently caps any correlation, and rank (Spearman) vs linear
(Pearson) agreement separates "monotone scale distortion, recoverable" from "cannot
rank, real." Expect run-to-run variance from live judges — attach CIs before letting a
verdict carry contractual weight.

## Customer-derived artifacts always ship with status + evidence attached

**What happened (2026-08-06):** Planning the G1.5 rubric review surface, the owner set
the rule: pending and rejected rubrics must be unmistakably labeled as not in force —
draft text shown WITH its status and calibration verdict so an uncalibrated draft is
never mistaken for the operative contract — and rejected artifacts stay visible with
their failure reason ("failed calibration at r=0.6 and was not deployed") rather than
being hidden.

**Why:** Visible rigor IS the product. A quality guarantee sells trust; showing the
drafts, the failures, and the evidence trail builds it, while hiding failures reads as
having something to hide. Also prevents the concrete hazard of a customer treating a
draft as the operative contract.

**How to apply:** Any surface that shows something derived from customer data (rubrics,
derived suites, calibrations, frontiers, verdicts) must pair the artifact with (1) its
lifecycle status, unmistakably distinguishing in-force from not-in-force, and (2) the
evidence for/against it (calibration verdict, provenance, failure reason). Never delete
or hide a rejected/failed artifact from its review surface; record WHY in a
first-class field (status_reason), not a log line.

## API-key rotation is the owner's call — don't keep reminding

**What happened (2026-08-07):** After several sessions ending with "remember to
rotate the keys," the owner ruled: both keys are spend-capped, rotation timing is
their decision — note it once and stop reminding.

**Why:** Repeated safety reminders the owner has already priced in are noise, not
diligence. The keys' blast radius is bounded by their spend caps; the owner owns
the rotation schedule.

**How to apply:** Security-hygiene reminders get stated ONCE when the exposure is
created, then recorded (lessons/todo) and dropped from session-end summaries.
Applies generally: after the owner acknowledges a standing risk and takes
ownership of it, repeating the warning each session is a correction-worthy habit,
not thoroughness.

## Enforcement tests that EXECUTE handlers need side-effect isolation

**What happened (2026-08-08, G2.3):** The exhaustive route-inventory test probes
every admin route with a serve+admin key — and the probes EXECUTE. The research-scan
probe ran against the default price registry and MERGED its mock fixture models into
the repo's prices.json (a dirty working-tree file one `git add -A` away from being
committed), which then poisoned research.test.ts (fixtures "already known" → zero
cycles fanned out → 120s hang).

**Why:** A 2xx from an authorization probe is still a real handler run. Any test that
sweeps mutating routes inherits the union of ALL their side effects — including
writes to repo files behind env-var defaults (POTION_PRICES_PATH).

**How to apply:** Route-sweeping tests point every file-backed dependency at a
throwaway copy (tmp prices.json, tmp suites dir) BEFORE buildServer, same as
research.test.ts. And check `git status` for unexpected repo-file mutations after
adding any test that executes handlers broadly.

## Multi-edit python scripts must write after EVERY logical edit

**What happened (2026-08-08, twice this run):** A scripted edit block computed a
replacement, asserted the anchor, but never called write() for one of its files —
the later call-site edit landed against the unchanged function (esbuild strips types,
so the extra argument was silently ignored at runtime) and produced a
confusing-at-a-distance failure.

**How to apply:** One file per scripted edit block, ending in an explicit write + a
grep-back verification of the NEW text. When a test fails in a way that contradicts
an edit "already made," first verify the edit is actually in the file.

## An exhaustive sweep needs a control arm, not just a target arm

**What happened (2026-08-08, G2.4):** The tenancy sweep compared "org B hits org
A's real id" against "org B hits an unknown id" and asserted both 404. It passed
everywhere — until a third arm (a MALFORMED id) was added, which immediately
found three routes returning 500 with a raw SQL string in the body. The
two-arm version had missed them because both of its arms happened to be
well-formed uuids.

**Why:** A property test is only as strong as the input classes it varies. The
security property is "no observable difference across resource states"; the
input space includes malformed, well-formed-but-absent, foreign, and owned —
omitting one hides a whole failure class.

**How to apply:** When asserting an indistinguishability property, enumerate the
input classes explicitly and probe each. For id params: owned, foreign,
absent-but-well-formed, malformed. A refusal that crashes is both an
availability bug and an oracle.

## "Already handled" in one route is not "handled"

**What happened (2026-08-08, G2.4):** rubrics.ts had carried an inline uuid-shape
guard since G1.5. Three sibling routes taking the same uuid params (share
revoke, alert delete, incident resolve) never got one and crashed on malformed
input. The pattern existed; it just hadn't been made shared.

**How to apply:** When a route needs a guard, ask which OTHER routes take the
same shape of input, and promote the guard to a shared helper in the same
change. An inline fix at one call site is how a defect class survives.

## A test fixture's convenient default can be the thing hiding the bug

**What happened (2026-08-08, G2.4 carryover):** every pre-G2.4 isolation suite
set `ORG_A = DEFAULT_ORG_ID` because the demo org exists for free (migration
0003 seeds it, the dev-auth bypass resolves to it, pre-auth logs attribute to
it). That convenience is exactly what hid tenancy defect D1 for the entire life
of the suite: a bearer-only resolver that fell back to the demo org LOOKS
correct when the org under test IS the demo org. Making the subject a distinct
org broke 20 tests in one class — six suites had been calling admin routes
unauthenticated, riding the bypass onto the org they had seeded. They were
asserting tenant-scoped behavior while authenticating as nobody.

**Why:** a fixture value that the system treats specially cannot be used as the
subject of a test about that system's handling of ordinary values. The
specialness is a second, invisible reason for the assertion to pass.

**How to apply:** when a test needs an instance of X, ask whether the instance
you reached for is special to the code under test (a default, a fallback
target, a seeded row, a bypass destination). If it is, construct a plain one.
Then encode the rule as a meta-test over the test tree — a convention honoured
by one file is a convention a new file will not know about. Scope the meta-test
narrowly enough that its exemption map stays smaller than the fix.

## An optional field erases a distinction every audit surface needs

**What happened (2026-08-08, G2.6):** the obvious way to add a latency bound to
a quality-floor policy was an optional `p95Ms` on `min_cost`. It was rejected
for a reason that only shows up downstream: `policy.type` is what lands in
`request_logs.policy_type`, the `policy=` field of `x-frontier-trace`, and
`incidents.detail`. With an optional field, a bounded policy and an unbounded
one are the same string in every one of those places — so "was this request
subject to a latency SLO?" becomes unanswerable from the audit trail, and the
requirement that the bound's consequence be visible fails at the first surface
where it matters.

**Why:** a type discriminator is not just a compile-time convenience; in a
system that logs the discriminator, it is the only thing that survives into the
record. Optionality inside a variant is invisible to everything downstream that
stores the variant's NAME.

**How to apply:** before adding an optional field to an existing variant, ask
what gets persisted about that variant. If the answer is "its type tag", and
the new field changes the meaning of the behavior, it needs its own tag. The
extra union member also buys compiler-enforced exhaustiveness — the TS errors
at each switch become the worklist of surfaces that must be updated.

## Metering at handler completion is an attribution leak, not a caveat

**What happened (2026-08-09, G2.8):** `request_logs` — the single rollup every
spend surface reads (budgets, hard stops, forecasts, invoices) — is written when
a job handler COMPLETES. Across the capstone's live legs, **$1.5594 of $2.5881
(60%) never reached it**; one killed leg leaked 99.1% of its own spend. Three
non-hypothetical triggers now exist: a provider error (G1.7), and two operator
timeouts (G2.8 legs 3 and 4).

**Why:** the success path was treated as the metering path. Any non-completion —
provider error, timeout, SIGTERM, deploy, OOM — spends real money with no
attribution. The failure mode compounds: a job that dies repeatedly spends on
every attempt while the org's hard-stop cap never trips, because the cap is
computed from the rows the dead job never wrote.

**How to apply:** meter side effects AS THEY OCCUR, not when the work finishes.
If an operation spends money, writes must be incremental (or journalled) so the
ledger is correct at every instant; completion then RECONCILES rather than being
the sole write. And when a long operation is interrupted, do not assume "no
completion" means "no spend" — reconcile against the provider's own figure.

## A long live leg must be detached, not just chunked

**What happened (2026-08-09, G2.8):** the M1b ledger established chunked
`--resume` for cost control. G2.8 assumed leg granularity was enough; it was not
— one leg (23 items × 3 class reps, sonnet judging) exceeds a ten-minute
foreground invocation, and two legs were killed mid-flight, each leaking
unmetered spend. Background execution was available and unused.

**How to apply:** before starting a live leg, estimate its wall-clock, not just
its cost. If it can exceed the invocation limit, run it detached or sub-chunk at
item level. An interrupted paid operation is worse than a slow one.

## A point estimate near a hard threshold is not a verdict

**What happened (2026-08-09, G2.8):** a live judge calibration read pearson
0.605 / spearman 0.811 against a 0.8 trust bar. The obvious reading — "fails on
Pearson, clears on Spearman, so gate on Spearman" — was written down as the
recommendation. The bootstrap intervals said otherwise: Pearson [0.5239,
0.7964] genuinely fails (the whole interval is below the bar), while Spearman
[0.6975, 0.8932] **straddles** it. Switching the gate would have converted a
defensible rejection into an undefensible acceptance, on the run that stood to
benefit.

**Why:** thresholds are compared against estimates, and estimates have width. A
point 0.011 above a bar, with a half-width of 0.098, carries no information
about which side it is on.

**How to apply:** when a decision turns on crossing a fixed threshold, compute
the interval and gate on it — clears only when the whole interval clears, fails
when the whole interval fails, and report a third INDETERMINATE state when it
straddles. Be most suspicious when the convenient conclusion is the one the
point estimate supports.
