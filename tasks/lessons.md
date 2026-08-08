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
