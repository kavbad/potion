# HARDENING PLAN — from 6.5 to 10

_Written 2026-09-03 against `deploy/2026-08-21-partner-ready` @ f978eb0, from a
measured audit (typecheck PASS, lint **FAIL**, `pnpm -r --no-bail test`
**EXIT=1**, clean `pnpm build` **FAIL**, `ci` workflow **0 runs ever**).
CORRECTION 2026-09-03: the first pass reported "lint PASS" by reading a
wrapper's exit code instead of eslint's. `pnpm lint` exits 1 — it always did.
Read the log, not the status line. Per the STATE.md doctrine this file is HISTORY
the moment it lands: stamp it `SUPERSEDED BY STATE.md` once the phases below
are folded into STATE.md's current truths._

## The one-sentence diagnosis

The code is substantially better than the machinery guarding it. 3,083 tests,
9 TODOs in 121k lines, zero `@ts-ignore`, chaos tests, tenancy sweeps,
injection floors, a prices tripwire born from a real three-time incident — and
**none of it gates anything**, because the CI workflow has never executed once
in 523 commits. Almost every item below is *enforcement of a mechanism that
already exists*, not new invention.

## Scorecard: where the points are

| Dimension | Now | Target | Moved by |
|---|---:|---:|---|
| CI/CD enforcement | 1 | 10 | P0, P1, P5 |
| Test reliability | 3 | 10 | P0 |
| Frontend test coverage | 3 | 10 | P3 |
| Config discipline | 4 | 10 | P2 |
| Maintainability at velocity | 5 | 8–10\* | P1, P4, P6 |
| Operational maturity | 6 | 10 | P5 |
| Security engineering | 7 | 10 | P2 |
| Architecture & modularity | 8 | 10 | P4 |
| Documentation practice | 8 | 10 | P6 |
| Code hygiene | 9 | 10 | P4 |
| Test depth (backend) | 9 | 10 | P1, P3 |
| Type safety | 9 | 10 | P1 |

\* See "The honest ceiling" at the end. One dimension cannot be bought with code.

---

## P0 — Restore the gate (half a day)

Nothing else is worth doing first. Until `pnpm test` is green and CI runs, every
later phase is unverifiable.

### P0.1 — Point CI at the branch that exists

`.github/workflows/ci.yml` triggers on `branches: [master]`. The default branch
is `main`; no `master` ref exists. This is why the workflow has zero runs.

```bash
sed -i '' 's/branches: \[master\]/branches: [main]/g' .github/workflows/ci.yml
```

Same fix in `.github/workflows/deploy.yml` (`if: github.ref == 'refs/heads/master'`
and its `push.branches`), or that job stays inert after P5.

**Done when:** a push to `main` produces a `ci` run in `gh run list --workflow=ci.yml`.

### P0.1b — Fix the build order, or CI's first run is red anyway

**Found 2026-09-03 while executing P0, by building in a clean worktree.**
`pnpm build` FAILS from a genuinely clean checkout and succeeds on a tree that
already has `dist/`. Every local machine has stale `dist`; a CI runner never
does. So P0.1 alone does not produce a green pipeline — it produces a red
build, at the first step, before typecheck/lint/test ever run.

Evidence: in a fresh worktree at f978eb0, `pnpm build` exits 2 with
`packages/lab-dial: TS2307 Cannot find module '@potion/lab-runtime'` — a
package built before its own **declared** `dependencies`. Building
`lab-superpowers → lab-gen → workers` by hand and re-running `pnpm build`
then exits 0.

Root cause: `pnpm -r` topologically orders over the FULL graph, devDependencies
included. Three devDependency edges close all 7 cycles and make a correct order
impossible, so pnpm breaks them arbitrarily:

| edge | closes | used for |
|---|---:|---|
| `lab-runtime --devDep--> server` | 6 cycles | `buildServer` in `synthesis.test.ts`, `walkthrough.test.ts` |
| `lab-runtime --devDep--> lab-dial` | 1 cycle | dynamic import in `walkthrough.test.ts:279` |
| `lab-superpowers --devDep--> lab-runtime` | 1 cycle | `mini-eval.test.ts` |

All three are **test-only imports**. The devDep choice was deliberate and
correct for the runtime graph — `lab-superpowers/src/mini-eval.ts:9` documents
exactly that reasoning — it just does not help pnpm, which does not distinguish.

CORRECTION (applied 2026-09-03): the table above lists back-edges from ONE DFS
traversal, which is not the same as a minimum cut. The true minimum cut is
**five** edges: `lab-dial→server`, `lab-gen→server`, `lab-runtime→server`,
`lab-runtime→workers`, `lab-runtime→lab-dial`. All five are test-only, and
every symbol the affected tests need was ALREADY on its package's public
index — so all five moves were mechanical, no API surface widened.

Options, cheapest first:

1. **Move the cross-package integration tests into `tests/*`** (where
   `tests/chaos` already lives, and for the same stated reason: it "imports all
   of them as built workspace deps" precisely to avoid this). Zero production
   code changes; the cycles disappear.
2. Inject `buildServer` through a fixture parameter instead of importing it,
   so the dependency inverts.
3. Keep the cycles and build explicitly in dependency order via a script. Works,
   but encodes the problem rather than removing it.

Option 1 is recommended: it uses a pattern the repo already established and
already justified in writing.

**Done when:** `rm -rf packages/*/dist apps/*/dist && pnpm build` exits 0, and
that command is what verifies it — not a build on a warm tree.

### P0.2 — Give the test suite a timeout that matches its tests

All 6 failures are timeouts, zero assertion failures. `testTimeout` and
`hookTimeout` are set **nowhere** in the repo, so the suite runs on vitest's 5s
default while individual tests legitimately take 15–50s (PGlite boot, embedding,
clustering). Under parallel load, borderline tests cross the line
non-deterministically.

Exactly two config files need it — and note `apps/dashboard/vitest.config.ts`
**shadows** the root config (the same gotcha already documented there for the
prices guard), so it needs its own copy:

- `vitest.config.ts` → `test: { testTimeout: 120_000, hookTimeout: 60_000, … }`
- `apps/dashboard/vitest.config.ts` → same two keys alongside the existing
  `globalSetup`

Then fix the three `apps/server` suites that fail in `beforeAll` rather than in
a test — `test/lab-attachments.test.ts` (`Cannot read properties of undefined
(reading 'close')` at line 29 is a *consequence* of the hook timing out, not a
separate bug), `test/learning-apply-floor.test.ts`, `test/task-shape.test.ts`.

**Done when:** `pnpm -r test` exits 0 three consecutive times, including once
while the machine is under load.

**RESULT (2026-09-04).** The global fix works for what it covers: two full
runs on a clean worktree at normal load, **0 vitest timeouts** each, against
6 before. But it is PARTIAL, and the limit is worth knowing:

**288 tests across 103 files set their own timeout as the third argument to
`it()`** — 138 at `60_000`, 65 at `120_000`, 48 at `90_000`, 18 at `30_000`,
3 at `20_000`. A global `testTimeout` cannot raise those. A third run, while
another agent session had the machine at load average ~18, took 48 minutes
and produced 4 timeouts — every one of them in a test with its own `60_000`.

Those explicit budgets were written to escape vitest's 5s default. Now that a
120s global exists, most of them are LOWER than it: they have quietly
inverted from raising the ceiling to lowering it. **Delete the redundant
ones** (anything at or below the global) and let them inherit; keep only the
budgets that genuinely need MORE than the global, and comment why.

Until then, the suite is reliable on a quiet machine and still flaky on a
loaded one — which on a dedicated CI runner is fine, and on this machine,
with several agent sessions sharing it, is not.

### P0.4 — `pnpm lint` is red, and two thirds of the noise is phantom

`pnpm lint` exits 1: **147 problems, 36 errors, 111 warnings**. Two separate
things are wrong.

**(a) eslint is scanning `.claude/worktrees/`.** Four stale worktree copies of
this repo live there, so the same handful of problems is counted five times.
`eslint.config.mjs` ignores `dist`, `node_modules`, `coverage`, `.next` and
`drizzle` — add `'**/.claude/**'`. This alone takes 36 errors to **8**.

**(b) The 8 real errors are real.** Unused imports (`strategyHash`,
`listApiKeys`) in `apps/server/src/routes/dashboard.ts`; an unused, never-
reassigned `cookie` in `apps/server/test/invites.test.ts`; a no-op expression
in `packages/workers/src/frontier-notes/daily.ts:85`
(`no-unused-expressions` — worth reading, a no-op expression is often a
dropped call); and three in `scripts/`. All are `--fix`-able or one-line.

The 111 warnings are dominated by `consistent-type-imports` on `import()` type
annotations. Warnings do not fail the build; decide once whether to fix or
downgrade the rule, rather than leaving 111 permanent yellow.

**Done when:** `pnpm lint` exits 0.

### P0.5 — The exfiltration-cap test is flaky, and it guards a security control

`packages/lab-runtime/src/exfiltration-corpus.test.ts` → *Fixture 06 —
oversized-result → per-call truncation, cumulative cap trips typed* fails
intermittently on `expect(refusals.length).toBeGreaterThan(0)`. Measured
2026-09-03 in a clean worktree: **2 passes in 5 observations**, back to back,
same tree, same commit. Not a timeout — the test carries its own explicit
`90_000` budget — and not caused by the P0.2 change.

Why it is not a routine flake: the assertion is that a **cumulative byte cap
fires and records a typed refusal**. That cap is what stops a hostile connector
draining data. `mcp-tools.ts` re-reads the durable record before every call
(`listLabSteps` → `checkToolCaps`), so the 5th call only sees the first four if
their checkpoints have landed. Tool calls dispatch **sequentially**
(`for (const call of result.toolCalls)`, no `Promise.all`), so this is not the
obvious concurrency bug — which makes it more interesting, not less: a
sequential path should be deterministic.

Either the test races the checkpoint write, or the cap does. The first is a
test bug. The second means the cap can silently fail to fire in production.
**Find out which before trusting the suite green.** Until then, a green run is
partly luck.

### P0.6 — `lab-runtime` still does not typecheck its tests

Every other lab package runs `tsc -p tsconfig.json --noEmit && tsc -p
tsconfig.test.json`. `@potion/lab-runtime` runs only the first half — its
6,900 lines of tests have never been typechecked.

This is not theoretical. Moving two of its tests into `tests/integration`
(which does typecheck) immediately surfaced a real error: a `Usage` fixture in
`walkthrough.test.ts` missing the required `latencyMs`. It had been sitting
there, invisible, for as long as the file existed.

The 2026-09-03 commits "TYPECHECK THE TESTS — the hole that let a broken
fixture serve 503s" and "WORKERS AND HARNESS JOIN THE CHECK" were closing
exactly this gap package by package. `lab-runtime` is the one still outside it.

**Do:** add `tsconfig.test.json` to `packages/lab-runtime`, extend its
`typecheck` script, fix what falls out. Then audit every package for the same
half-script — the pattern is easy to miss precisely because the first half
passes.

**Done when:** no package's `typecheck` script omits its test project.

### P0.7 — A security drift-guard that has never guarded anything

`apps/server/test/tenancy-report.test.ts` reads
`artifacts/tenancy-classification.md` and asserts it matches the route and
mock-eligibility inventories, so that "a fixture change without a
regeneration fails here rather than shipping a stale security answer."

That file is **gitignored** (`.gitignore` → `/artifacts/*`). The test's own
failure message even says so. `readFileSync` runs unconditionally, so on a
clean checkout the test throws ENOENT — it has only ever passed on machines
that happened to hold a local copy. In CI it would have failed outright, and
for the whole time CI was dark it guarded nothing.

Fixed here by un-ignoring the artifact and committing it, following the
precedent already in `.gitignore` (the m1b live-eval evidence and
`g28-parameters.md` are un-ignored the same way, each with its reason
written next to it). The generated file is deterministic — regenerating in a
fresh worktree reproduced the existing copy byte for byte.

**The alternative would have been worse.** Making the test skip when the file
is absent turns it green while guarding nothing — the exact CI-theatre
failure this whole phase exists to prevent.

**This is a policy call and it is reversible:** it commits a 34 KB generated
file. If you would rather not, the honest substitute is to generate the
artifact as a CI step and diff it, not to let the test skip.

### P0.8 — The register that guards the adversarial pass lived on one laptop

`scripts/step12-targets.test.ts` opens with: "the register is a **committed
artifact** and this test is the thing that will not let it shrink … a row
cannot close by silence, by prose, or by deletion."

`artifacts/step-12-targets.json` was gitignored. **Nothing generates it** —
the test is its only reference. It is a hand-authored 14 KB security register
that existed on exactly one machine, no clone had it, and the test written to
stop rows from disappearing threw ENOENT on every clean checkout. One `rm`
from gone, with the guard against that outcome unable to run.

Committed here, same as P0.7.

### P0.9 — A ratchet that could not see where the code went

`scripts/test-typecheck-coverage.test.ts` counts `as never` / `as unknown as`
in test files and holds the total at a budget that "may fall, never rise".
Good design — and it caught something real, in the most useful possible way.

Its scan roots were `[packages, apps]`. Moving five test files into `tests/`
dropped the count 223 → 219, and the assertion demanded the budget be lowered
"to lock the gain in". There was no gain: the four casts still exist, in a
directory the ratchet cannot see. Recording 219 would have written down an
improvement that did not happen AND blinded the ratchet to `tests/`
permanently.

Fixed by adding `tests` to both root lists (the escape-hatch scan and the
which-packages-typecheck-their-tests scan). Count returns to 223, budget
unchanged, and `tests/chaos` + `tests/integration` now answer to the same
discipline as everything else.

Worth noting for its own sake: this is the honest-numbers failure mode the
repo already has a name for. The ratchet asked to be told a comfortable
number. The right answer was to widen its eyes, not lower its bar.

### P0.3 — Record the green baseline

Commit the passing run's summary into `STATE.md` current truths: 3,083 tests,
24 packages, wall time. Without a recorded baseline nobody can tell later
whether a slowdown or a skip is new.

---

## P1 — Make the gate binding (week 1)

A gate that can be walked around is a suggestion.

### P1.1 — Branch protection on `main`

Require the `verify` job to pass before merge. This is what converts 3,083
tests from private knowledge into an enforced contract, and it is what makes
the three open dependabot PRs (one open 24 days) mergeable with confidence
instead of on faith.

### P1.2 — Bring the SDKs inside the fence

`pnpm-workspace.yaml` lists `packages/*`, `apps/*`, `tests/*` — **not `sdks/*`**.
The TypeScript and Python SDKs (1,477 lines, the customer-facing surface) are
outside `pnpm -r test` entirely. `sdks/python/tests/test_client.py` exists and
has never been run by any repo-level command.

- Add `sdks/*` to `pnpm-workspace.yaml` so `sdks/typescript` joins typecheck/test.
- Add a `pytest` step to `ci.yml` for `sdks/python` (it already declares
  `dev = ["pytest>=8"]` in `pyproject.toml`).
- Add both to the `verify` script.

### P1.3 — Local pre-push hook

There are no git hooks and no husky/lefthook. A pre-push running `pnpm typecheck
&& pnpm lint` (fast; not the full suite) catches the cheap failures before they
cost a CI cycle, and keeps `main` green between pushes.

### P1.4 — Measure coverage at all

No coverage tooling is configured anywhere. A 10/10 coverage claim is not
assertible without a number. Add `@vitest/coverage-v8`, publish the report as a
CI artifact, and set a **ratchet, not a target**: coverage may not decrease.
Ratchets are enforceable; aspirational thresholds are ignored.

### P1.5 — Turn the branch situation off

Work is happening on `deploy/2026-08-21-partner-ready`, 6 commits ahead of
`main`. Merge it, then adopt short-lived branches → PR → `main`. A protected
`main` that the work never touches protects nothing.

---

## P2 — Close the security and config gaps (week 2)

### P2.1 — Make the dangerous combination fatal, not advisory

`devAuthBypassEnabled()` in `apps/server/src/auth.ts:145` checks the explicit
`POTION_DEV_AUTH` flag *before* the `NODE_ENV !== 'production'` fallback, so
`POTION_DEV_AUTH=1` disables authentication in production. `boot-report.ts`
already detects this exact state and already prints
`AUTH BYPASS IS ON IN PRODUCTION — every dashboard route is effectively public.`

The mechanism exists. The missing piece is that nothing refuses:

- Add a `fatal?: string` field alongside `warn` in `GateReport`.
- Mark `devAuth && isProd` fatal; likewise `magicLink && selfServe` on a
  reachable deployment.
- At boot, a fatal row **exits non-zero** rather than logging. A server that
  cannot be secure should not accept the port.
- Assert both refusals in `boot-report`'s existing pure-function tests.

This is the 2026-08-27 incident class exactly — a gate that reported its state
but did not act on it.

### P2.2 — One validated config module

`process.env` is read directly in **176 files** (68 in `apps/server`). The repo
uses zod in 103 places but not for its own environment. Misconfiguration
currently surfaces as a runtime error deep in a request path.

- `packages/core/src/env.ts`: one zod schema, parsed once, exported typed.
- Fail fast at boot on missing/invalid, feeding the P2.1 fatal path.
- Migrate call sites package by package; add an eslint `no-restricted-globals`
  / `no-process-env` rule scoped to `packages/**` and `apps/*/src/**` once a
  package is migrated, so the count can only go down.
- Explicitly keep the empty-vs-unset distinction `sourceOf()` already draws —
  that distinction is the incident's whole lesson and must survive the refactor.

### P2.3 — Get an actual dependency audit

`pnpm audit` could not reach the registry (socket timeout, 3 retries) when run
locally, so **the vulnerability count is currently unknown**. `ci.yml` already
declares an audit gate and an SBOM step; once CI runs (P0.1) this resolves
itself. Verify the first run's output rather than assuming clean.

---

## P3 — Test what is untested (weeks 3–5)

### P3.1 — Promote the walkthrough to CI

`apps/dashboard/scripts/walkthrough.ts` (1,487 lines) already boots the API on
fresh PGlite plus a production dashboard build and drives login → provider key →
workload → policy → chat → receipt → budget hard stop → audit trail. It is a
serious e2e that **nothing runs automatically**.

Wire it as a separate CI job (not inside `pnpm -r test` — it needs its own
timeout budget and shouldn't gate unit feedback). This single step covers most
of the dashboard's untested 23,474 lines without writing a new test.

### P3.2 — Component tests where the walkthrough can't reach

The dashboard is 27,174 lines against 1,115 lines of tests (14 files, mostly
pure formatters and chart math). After P3.1, target the state-dependent
components the walkthrough only sees in one state — `lab-actions.tsx` (1,457),
`lab-console.tsx` (1,065), `loop-status.tsx` (whose no-traffic-branch-only
render was already a real bug, per STATE.md).

Prior finding to honor: *reviews must render pages in real states in a browser;
source review finds dead pages, only looking finds bad ones.* Pair each new
component test with a rendered check, not just assertions.

### P3.3 — Close the named per-package gaps

Same-name test pairing is near 1:1 in `core`, `pareto`, `strategies`,
`observability`. The measurable holes: `packages/pareto/src/serving.ts` (569
lines, has `serving-degeneracy.test.ts` but no `serving.test.ts`),
`packages/strategies/src/exec-sandbox.ts`, `execute.ts`, `resolve.ts`,
`helpers.ts`. Use the P1.4 coverage report to rank the rest by lines-at-risk
rather than by guess.

---

## P4 — Structure and speed (weeks 4–6)

### P4.0 — The cycles are not cosmetic (see P0.1b)

The original audit called the 7 devDependency cycles "benign" because none
touch the production graph. That was wrong in one specific way, found by
building clean: they break `pnpm -r`'s build ordering. If P0.1b took option 1,
this is already done and this section is a no-op; if it took option 3, the
cycles are still there and still owed.

### P4.1 — Split `handlers.ts`

6,454 lines, 61 exports — alerts, budgets, rubrics, clustering, sweeps, lab
runs, grants, retention. Three times the next-largest file, and the outlier
rather than the pattern (639 source files are ≤300 lines; only 10 exceed 1,000).

The seams are already visible in the file's own ordering. Split into
`handlers/{alerts,budgets,rubrics,clustering,sweeps,lab-runs,grants,retention}.ts`
with `handlers/index.ts` preserving the current export surface, so no consumer
changes in the same commit. Its existing tests (`worker.test.ts`,
`suite-verify.test.ts`, `lab-run.test.ts`, `research.test.ts`) are the safety
net — do this **after** P0.2, never before.

### P4.2 — Make the suite fast enough to run

`apps/server` and `packages/workers` each take ~322s wall with ~2,347s
cumulative test time; `traces.test.ts` alone is 310s, `learning-period.test.ts`
183s. Full run ≈9 minutes. A 9-minute loop gets skipped, and a skipped suite is
a dead suite regardless of its quality.

- Profile PGlite setup: share one instance per file where isolation permits
  instead of per test.
- Split the slowest files so vitest can parallelize within a package.
- Add a `test:fast` script excluding the known-slow integration files, for the
  inner loop; CI keeps running everything.
- Target: full suite under 5 minutes in CI, `test:fast` under 60s locally.

### P4.3 — The last hygiene points

9 TODO/FIXME, 5 `eslint-disable`, 10 `as any`, 1 `@ts-expect-error`. Small
enough to resolve or convert to tracked issues in one pass. Then add
`@typescript-eslint/no-explicit-any` back as `warn` (currently `off` repo-wide
per the SPEC-interfaces note) scoped to everything but the queue handler
signatures that justified the exemption.

---

## P5 — Deploy and operations (weeks 6–7)

### P5.1 — Finish the CD path

`deploy.yml` is an explicit, honest placeholder — registry push and deploy both
commented out, gated on a `REGISTRY` secret — while withpotion.com serves real
traffic from a hand-run `scripts/deploy-prod.sh`.

That script is genuinely hardened (dry-run default, `--go` required, `.env*`
exclusion, one-service-at-a-time, pipefail, committed-tree gate incl. untracked
files, `--rollback`), and **every guard traces to a real incident**. Do not
replace it. Make CD *call* it:

- Configure the `REGISTRY` secret; uncomment the push.
- Deploy job invokes the existing script's `--go` path on a green `main` only.
- Keep the manual path working — the script stays the source of truth for the
  procedure, CI stays the source of truth for *when it may run*.

### P5.2 — Widen the uptime probe

`uptime.yml` is the one workflow that has always worked (126 runs, 2 failures).
It checks `/readyz` and `/home`. Add a synthetic that exercises the actual
product promise — a `/v1/chat/completions` call asserting an
`x-frontier-trace` header comes back — so a routing regression is caught by the
same mechanism that already catches a hard outage.

---

## P6 — Keep it from decaying (ongoing)

### P6.1 — Enforce the STATE.md doctrine mechanically

The doctrine is right and already saved you once. It is also already slipping:
`STATE.md` is stamped `_Last updated: 2026-09-01_` but was committed
2026-09-03. Add a CI check that fails when `STATE.md` is modified without its
`Last updated` line changing. The file whose job is being current should be the
one file that cannot silently go stale.

### P6.2 — Fix the drift that exists today

- `apps/server/src/routes/auth.ts` header: "there is NO live email in this
  build" — `email.ts` ships a working Resend transport. Stale in a
  security-relevant comment.
- `tests/chaos/README.md`: "CI runs it as part of the standard test step" —
  true only after P0.1. Correct it or make it true first.

### P6.3 — Prune the doc surface

299 markdown files, many superseded by design. Sweep for `SUPERSEDED BY
STATE.md` stamps on everything the P0–P5 work invalidates. Documentation volume
is a liability when the reader can't tell which file is live.

---

## Sequencing

```
P0 ──► P1 ──► P2 ──┐
        │          ├──► P5 ──► P6 (ongoing)
        └──► P3 ───┤
        └──► P4 ───┘
```

P0 is a hard prerequisite for everything: no phase below it is verifiable
without a green, enforced suite. P3 and P4 are independent of each other and can
interleave. P4.1 (the handlers split) must not start before P0.2, or a
timeout-flaky suite will be your only refactor safety net.

Realistic calendar at current velocity: **P0 in a day, P1–P2 inside two weeks,
9/10 across the board by roughly week 7.**

---

## The honest ceiling

Eleven of the twelve dimensions are reachable with the work above. One is not.

**Maintainability at current velocity** is scored 5 because of 523 commits in
29 days by a single author with no second reviewer and no automated gate. P0–P1
fix the gate half — that alone moves it to 8, and it is the half that code can
fix. The remaining two points are bus factor, and no plan written in this
repository can buy them. They require either a second person with commit rights
and context, or an explicit decision to accept a ceiling of 8 and compensate
with the strongest possible automation.

That is a staffing choice, not an engineering one, and it should be made
deliberately rather than absorbed. Everything else on this list is yours to
take.
