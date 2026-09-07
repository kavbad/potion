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

### P0.6 — `lab-runtime` still does not typecheck its tests — CLOSED BY ANOTHER SESSION

**SUPERSEDED 2026-09-04.** Commit `2b7c508` ("LAB-RUNTIME CLOSES IT — every
package now typechecks its tests") fixed this independently while this plan was
being written: `lab-runtime` now runs `tsc -p tsconfig.test.json` and the
PENDING debt list is empty. `641de8c` then took the escape-hatch count from 223
to 4, uncovering three more instances of the cascade shape bug that started that
sweep. Both landed on `deploy/2026-08-21-partner-ready`, not `main`.

Two sessions found the same defect from opposite directions within hours. That
is the argument for P1.1 and P1.3 stated as evidence rather than opinion: with
several agents committing to one repo, the only trustworthy signal comes from a
gate that runs on a clean checkout in a quiet environment. Kept below for the
record of how it was found.



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

**CORRECTION 2026-09-05 — this no longer reproduces, and the entry is kept
anyway.** The 223 → 219 below happened on the ORIGINAL base (pre-641de8c),
where the budget was 223 and the scan was TEXT. Two things then changed
upstream: 641de8c took the real count to 4, and ac02170 replaced the text scan
with an AST count of `ts.AsExpression` nodes — the text version read prose
("the private hop w-as never fetched" matched) and missed a bare `as unknown`.
Checked on the current tip: all five relocated files carry ZERO hatches under
both metrics, so moving them now shifts the count by nothing and the "lower the
budget" message will not appear.

The entry stays because the FINDING is not the number. A scan root that omits a
directory holding tests is silent — see P0.16, where a planted cast in
`tests/chaos` passes the guard with `'tests'` dropped. That is the durable
result; 223 → 219 was merely how I happened to trip over it.

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

### P0.10 — The secrets gate had never run either

The `ci` workflow's FIRST EVER execution (PR #8, 2026-09-04) failed at the
gitleaks step, before build/typecheck/lint/test started:

    🛑 GITHUB_TOKEN is now required to scan pull requests.

`gitleaks-action@v2` refuses `pull_request` events without that token and exits
**before scanning**. So this was not a finding — it was the scan not happening.
The step passed `GITLEAKS_CONFIG` and two flags and no token.

**Nothing in this repository has ever been scanned for secrets.** The gate was
configured, read correctly, and never executed — the sixth member of the family
this phase keeps finding. Fixed by adding
`GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}` to the step's env.

Two things follow, and neither is answered yet:

1. **The dependency-vulnerability count and the secret count are both still
   unknown.** `pnpm audit` could not reach the registry locally, and gitleaks
   has never run. The first honest answer to either arrives with the next run —
   treat a clean result as news, not as confirmation.
2. **Moving five test files may have invalidated path-based allowlists** in
   `.gitleaks.toml`. One of them (`exfiltration-corpus`, now
   `tests/integration/`) carries a GitHub-token-shaped canary string as fixture
   data BY DESIGN. If gitleaks flags it, the fix is the allowlist path, not the
   fixture — and the fact that a canary is what surfaced it is the gate working.

### P0.11 — The most fragile step runs first and blinds everything behind it

`ci.yml` orders the job: install → **gitleaks** → build → typecheck → lint →
test → dependency audit → SBOM. A failure at gitleaks skips all seven steps
behind it.

That is backwards for a regression gate. The secrets scan turned out to be the
most config-fragile step in the file — three independent defects, each found
only by running it (wrong branch trigger, missing `GITHUB_TOKEN`, missing
`pull-requests: read`) — while build/typecheck/lint/test are the cheapest and
highest-signal checks and depend on nothing but the repo. For three
consecutive runs, a broken scanner meant no test signal at all.

**Do:** move the secrets scan after `pnpm test`, or keep it early with
`continue-on-error: true` and make it a separate required check. Either way a
broken scanner costs you the scan, not the pipeline. Same argument for the
dependency audit and SBOM, which sit behind everything and have therefore also
never executed.

The general rule worth adopting: **order CI steps by (signal ÷ fragility),
highest first.** A gate you cannot see past is a gate that teaches people to
ignore it.

### P0.12 — RLIMIT_NPROC=64 is safe only where the sandbox owns its UID

**CORRECTED 2026-09-04.** First diagnosis (git identity) was WRONG and the fix
based on it did not work. The error: I read `repo/src/lib.js` being present as
proof the sandbox ran and aborted later. That file is pre-seeded straight into
the database by `upsertLabRunFile` — its presence says nothing about the
sandbox. The abort could be anywhere, including line one.

**Actual cause, from the sandbox's own comment** (`deploy/sandbox/sandbox_server.py`):

    if sys.platform != "darwin":
        limits.append((resource.RLIMIT_NPROC, RLIMIT_NPROC))   # 64

    # macOS dev refuses some ... and NPROC is skipped there outright — Darwin
    # counts it PER USER, so a dev machine's hundreds of processes make bash
    # unable to fork at all (X7 found this via the shell).

**Linux counts RLIMIT_NPROC per real UID as well.** The carve-out assumed Linux
was safe because in the PROD CONTAINER the sandbox runs as a dedicated user
owning few processes. On a CI runner the same UID owns the entire box, so a
64-process ceiling is already near-exhausted: `git` cannot fork, `set -e`
aborts, and the shell's output file is never written.

The same discovery was made once, for macOS, and generalised as "not-darwin is
fine" when the real condition is **"the sandbox has its own UID."**

**DIAGNOSED AND FIXED 2026-09-04, on the third cycle. The evidence:**

    "stderr": "__potion_main__.sh: fork: retry: Resource temporarily unavailable"
    "exitCode": 254
    "filesWritten": []

`EAGAIN` from `fork` — RLIMIT_NPROC, exactly as hypothesis 2 said. The CAUSE
was right; both fixes were wrong about the CONDITION under which the ceiling is
safe:

| attempt | condition used | why it failed |
| --- | --- | --- |
| original | `sys.platform != "darwin"` | a proxy — true in the container, false on a runner where one uid owns the box |
| fix 1 | headroom over a boot-time `/proc` count | the count drifts far past 64 while a parallel suite spawns workers; measured at boot, exhausted by exec time |
| fix 2 | `POTION_SANDBOX_DEDICATED_UID=1`, declared in the Dockerfile | the invariant is a property of the DEPLOYMENT, not something the process can measure |

RLIMIT_NPROC is counted per real UID host-wide, so "this exec cannot fork-bomb"
holds only where the sandbox owns its uid. `deploy/sandbox/Dockerfile` creates
the `sandbox` user; it now declares the invariant on the line above `USER
sandbox`, where it becomes true. Absent the declaration the server skips NPROC
rather than applying a ceiling it cannot justify — RLIMIT_AS, RLIMIT_CPU and
the parent's wall-clock kill still hold. Prod behaviour is unchanged.

**THE ACTUAL LESSON, and it cost three CI cycles (~75 minutes):**

The test discarded its own evidence — `stdio: 'ignore'` on the sandbox, and no
assertion on the shell's exit code — so the only signal reaching CI was "a file
is missing", a symptom every line of the script can produce. I identified that
gap BEFORE the first hypothesis and guessed anyway, twice. Both guesses were
argued from which file survived, and that file is pre-seeded straight into the
database: it never touches the sandbox and carries no information at all.

**Rule:** when a failure reproduces only where you cannot look, spend cycle one
making it speak. A test that cannot say why it failed will absorb hypotheses
indefinitely, and each one feels reasonable in isolation.

The diagnostics (a604846, 3bde286) are the durable part of this item and stay
in the test: sandbox stderr captured, every tool step's exit code and output
printed, step kinds listed, landed files named.

---

_Superseded record of the two wrong diagnoses, kept because the reasoning is
the point:_

1. Host git identity — fixed, X7 still failed.
2. `RLIMIT_NPROC` counted per-uid — fixed (below), X7 still failed.

Both were argued from the same thin evidence — WHICH FILE SURVIVED — and that
evidence cannot distinguish between failures, because the surviving file is
pre-seeded straight into the database and never touches the sandbox. Every step
of the script is compatible with the symptom.

**The actual defect is diagnosability, and it was visible before either guess.**
The test spawns the sandbox with `stdio: 'ignore'` (its stderr discarded) and
never asserts on the shell's own exit code or output, so the only thing reaching
CI was "a file is missing". Fixed in a604846: sandbox stderr captured and
printed in the assertion, the recorded `run_shell` step (exit code, stdout,
stderr) printed with it. The next run names its own cause.

**Lesson, at a cost of ~50 minutes of CI:** when a failure reproduces only in an
environment you cannot enter, spend the first cycle making it speak, not on the
most plausible hypothesis. A test that cannot say why it failed will absorb
hypotheses indefinitely.

The NPROC change below stands on its own merits — a per-uid ceiling is not what
"this exec cannot fork-bomb" means — but it is NOT established as X7's cause,
and this correction supersedes the claim that it was.

**Applied 2026-09-04 — option 1 (correct in itself; not the X7 fix).** The limit is now HEADROOM over what the uid
already runs, measured once at boot from `/proc`:

    _NPROC_BASE = <processes owned by this uid>
    RLIMIT_NPROC = _NPROC_BASE + 64

"This snippet cannot fork-bomb" is a statement about what an exec may ADD, and
that is true whether or not the uid is dedicated. In the prod container
`_NPROC_BASE` is a handful, so the effective ceiling stays ~64 and prod
behaviour is unchanged. Where the count is unknowable (macOS, no `/proc`) the
limit is skipped — the same outcome Darwin had, now reached by the real
condition rather than a platform name, so the `!= "darwin"` special case is
gone.

Note on verification: macOS takes the skip path, so this fix could not be
exercised on the machine that wrote it. Local checks proved only that nothing
broke. Linux CI is the test.

Original guidance, kept because the reasoning is the point:

**Do NOT simply raise or drop the limit** — NPROC is fork-bomb defence, and
weakening a security control to make CI green is the trade this whole phase
exists to refuse. The options, in order of preference:

1. Gate on the actual condition: apply NPROC only when the sandbox owns its
   UID (dedicated user, or a container where it is PID/user-isolated).
   Detectable at startup; matches the real invariant instead of a proxy for it.
2. Run the sandbox as a dedicated UID wherever it runs, CI included — making
   the prod assumption true everywhere rather than conditional.
3. Skip X7 where the invariant does not hold, and say so loudly. Weakest: a
   sandbox test that skips on the only foreign environment available is close
   to no test.

**Also fix the diagnosability, which is why this took two wrong guesses:** the
test spawns the sandbox with `stdio: 'ignore'`, so its stderr is discarded, and
the shell's own stderr is never asserted on. A sandbox integration test that
cannot say WHY the sandbox failed is a test you can only debug by hypothesis.
Surface the tool output in the failure message.

### Superseded first diagnosis — a sealed shell that leaned on the host's name

The gate's first run to clear gitleaks/build/typecheck/lint failed one test out
of 3,083: `lab-run.test.ts > X7 — the sealed shell (REAL sandbox integration)`.

    expected [ 'repo/src/lib.js' ] to include 'out/report/result.txt'

The pre-seeded tree survived; the shell's own output never appeared. Under
`set -e` that puts the abort between them, on:

    git init -q workrepo && cd workrepo && git commit -q --allow-empty -m offline

`sandbox_server.py` sets `HOME` to the workdir, so no user gitconfig applies in
any environment. But git's FALLBACK synthesises `user@hostname` — which
resolves on a developer Mac and fails on a runner whose hostname carries no
domain (`unable to auto-detect email address`). **The test passed for everyone
who ever ran it and could not pass on CI.**

Fixed by passing identity explicitly. A test of a *sealed* shell must not
depend on ambient anything.

**Why this one matters most.** Four full clean-tree runs here did not catch it,
because this machine has a resolvable hostname. Every other defect in this
phase was local state in the REPO — stale `dist`, an untracked artifact, a warm
tree — and a clean checkout was enough to find them. This one was local state
in the MACHINE, and only a genuinely foreign environment could surface it.
That is the argument for CI that no plan document can make on its own.

**Generalise it:** grep the suite for other ambient dependencies — `git`
identity, `$HOME`, hostname, timezone, locale, network reachability, installed
binaries. Anything a test reads that the repo does not provide is a test that
passes for you and fails for a stranger.

### P0.13 — `main` is red on its own ratchet, and nobody knows

**Not this branch's regression. Verified on an untouched `origin/main`
worktree, 2026-09-04.**

    New `as never` / `as unknown as` in test files: 10 vs a budget of 4.
    Worst offenders: frontier-notes/agenda.test.ts (4),
    frontier-notes/own-spend.test.ts (2), db/research.test.ts (1),
    db/tenancy.test.ts (1), alerts-dispatch.test.ts (1)

The sequence:

1. `641de8c` swept escape hatches **223 → 4** and set the budget at 4, with a
   commit message cataloguing the real shape bugs the casts had been hiding —
   three more instances of the cascade defect, phantom drizzle columns, a
   `Usage` blob read back as undefined.
2. `b79a995` and `6ba2042` landed **after** it and added six new casts.
3. Nothing noticed, because the gate that runs the ratchet has never run.

**The guard built to prevent this exact regression regressed within hours of
being built.** That is not a criticism of the guard — it is a good guard, and
it is the only thing in this repo that caught a change of mine (P0.9). It is
the whole argument for P0 in one artifact: a check nothing executes is a check
that decays silently, and the better the check, the more expensive the false
confidence it buys.

**How to clear it — the ratchet's own message is right:** *fix the type, do not
raise the number.* Raising the budget to 10 records the regression as the new
normal and spends the sweep's entire value. Six casts across two files is an
afternoon.

**Left deliberately unfixed by this branch.** It is another session's code, the
correct fix is theirs to make, and silently absorbing someone else's red is how
a gate becomes decorative. The first CI run on `main` will say so plainly.

### P0.14 — 14 high-severity production advisories, shipping live

The supply-chain gate ran for the first time on 2026-09-04 and answered a
question this repo has never been able to answer:

    audit-gate: 14 production advisories, level >= high: 0 accepted, 11 blocking

| package | advisories | fix |
| --- | ---: | --- |
| `fast-uri` | 8 (4 GHSAs × 2 version ranges) | bump → >=3.1.6 / >=4.1.3 |
| `nanoid` | 1 | bump → >=3.3.18 |
| `xlsx` | 2 | **`patched: <0.0.0` — no patched version exists** |

Nine are ordinary version bumps and should go in immediately.

`xlsx` is the one that needs a decision rather than a command: prototype
pollution (GHSA-4r6h-8v6p-xvw6) and ReDoS (GHSA-5pgg-2g8v-p4x9), with no fix
published to npm — the unmaintained SheetJS-on-npm situation. The options are
migrating to the vendor's own distribution, replacing the library, or accepting
it with a written justification in `scripts/security/audit-allowlist.json`
(currently empty, which is why all 11 block). Accepting is legitimate ONLY if
the parsing path never sees untrusted spreadsheets — that is a question about
where xlsx is called, not about the advisory.

**This is production.** withpotion.com serves live traffic, the gate designed to
catch exactly this was written into `ci.yml`, and it had never executed once.
The same run produced the repository's first SBOM.

**Nine bumped 2026-09-04** via `pnpm.overrides`, the pattern already used for
postcss/sharp/glob. Gate went **14 advisories → 5, 11 blocking → 2**. Clean
build and typecheck pass.

**RESOLVED 2026-09-05 — option 1, the vendor's own distribution.**

    "xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"
    audit-gate: 5 advisories, 2 blocking -> 3 advisories, 0 blocking. PASS.

`patched: <0.0.0` was never a data error. SheetJS stopped publishing to npm at
0.18.5 and moved to its own CDN, so the npm package is frozen ON the vulnerable
code by the vendor's choice, and no fixed version will ever appear there. 0.20.3
is the CDN's current release (probed — 0.20.4+ do not exist) and postdates both
fixes.

Verified rather than assumed, because a version jump is not a config change:
the exact APIs the workbench uses were exercised against 0.20.3 — `XLSX.read`
with `{type:'array', sheetRows}` and `utils.sheet_to_json` with
`{header:1, raw:false, defval:''}`. `sheetRows` still caps the PARSE, row shape
unchanged. Clean build/typecheck/lint all green; dashboard 122 tests; xlsx
present in the built bundle.

**Caveat on the record:** this is a production dependency from a non-npm host.
It is the vendor's official channel and the lockfile pins the exact URL, but it
carries no npm registry provenance, and the advisory database no longer matches
the package by name+version — so the gate going quiet is NOT itself proof of
patching. The proof is that 0.20.3 postdates both fixes. If a CDN dependency in
production is unwanted, option 2 (replace the parser — this is only a capped
preview grid) stays open.

_Original triage, kept because it is why the allowlist was refused:_

**`xlsx` triaged — and it is NOT the trusted-input case.**

`apps/dashboard/components/lab-workbench.tsx:66` does:

    fetch(`/api/lab/runs/${runId}/files/${name}`) → arrayBuffer → XLSX.read(buf)

That is a **lab run workspace file, parsed client-side in the viewer's
browser**. Those files are written by agent-authored code running in the
sandbox, and that agent consumes web tools and MCP connectors. The path
therefore exists: hostile content → agent → `.xlsx` → SheetJS prototype
pollution (GHSA-4r6h-8v6p-xvw6) or ReDoS (GHSA-5pgg-2g8v-p4x9) in an
operator's tab.

**Allowlisting would contradict this repo's own posture.** `mini-eval.test.ts`
asserts *"INJECTION FLOOR: a hostile server moves nothing past the Rules"* and
passes. Accepting a prototype-pollution parser fed by agent output is the same
class of risk that test exists to refuse — and the advisory has no patch, so
the allowlist entry would be permanent.

Options, best first:

1. **SheetJS's own distribution.** The npm `xlsx` package is stale by the
   vendor's choice; they publish fixed builds from their CDN. This is the
   documented upgrade path and the smallest change.
2. **Replace the parser** for what this actually is — a capped PREVIEW grid
   (`sheetRows: GRID_ROW_CAP + 1`, first 100-odd rows). A preview does not
   need a full workbook engine.
3. **Contain the parse**: run it in a Web Worker so pollution cannot reach the
   app's realm. Mitigates, does not remove.
4. Allowlist with a written justification — only if 1-3 are all refused, and
   the justification must argue why agent-written workbooks are trusted.

### P0.15 — CI tests the MERGE, not your branch — and an ungated main is a treadmill

Two things learned the hard way on 2026-09-04/05, both worth writing down.

**1. A `pull_request` run evaluates head MERGED WITH base.** So a green local
branch says nothing about CI while base is moving. `main` advanced 18 commits
during this work, then 13 more, and each time CI was judging commits against a
`main` that had never been built here. It produced a failure I initially
misread as my own stale artifact — regenerating locally gave NO diff, which was
the tell that the assumption was wrong.

**Corollary:** a conflicting PR gets NO run at all. GitHub cannot construct the
merge ref, so it silently skips the workflow — no run, no error, no annotation.
"CI is slow" and "CI will never start" look identical. Check `mergeable` before
concluding anything about a missing run.

**2. An ungated `main` accumulates faster than a PR can absorb.** Regressions
had to be cleared inside this PR twice:

| wave | what had gone red on `main` |
| --- | --- |
| first | ratchet 10 vs 4 · lint (`agenda.ts`, `daily.ts`) · classification hash · 14 advisories |
| second | ratchet 8 vs 4 again · tenancy artifact (7 new routes, unclassified) |

None were malicious or careless — they are the ordinary output of fast work
with no gate in front of it. The arithmetic is what matters: while `main` is
ungated, every hour adds defects that the next PR must clear as a merge
prerequisite, and a long-running branch pays that bill repeatedly.

**This inverts the moment the gate lands.** The cost moves from "a reviewer
spends an afternoon archaeologising" to "the author sees a red check in five
minutes". That is the entire return on P0 — not the fixes, the relocation of
when defects are found.

**Practical consequence for this PR:** it will need one final rebase
immediately before merge, and `main` should be gated (P1.1 branch protection)
in the same sitting. Landing the gate without protecting the branch leaves the
treadmill running.

### P0.16 — Assert it, do not ask for it

`TEST_ROOTS` is a hand-written list and every check in
`scripts/test-typecheck-coverage.test.ts` walks it. Twice a directory has sat
outside it while holding real tests: `scripts/` (fixed in 8a8f996, "the guard
could not see its own directory") and `tests/`, which this branch fills with
the five relocated integration tests.

The failure mode is the dangerous kind — **a missing root is not an error, it
is a smaller number.** No warning, no non-zero exit: an unwatched directory
reporting success.

**What I did first, and why it was wrong.** I asked the session I believed
owned the file to keep `'tests'` in the list. Two mistakes in one move:

1. The attribution was wrong (`ac02170`/`8a8f996` belong to a different
   session), so the request went to someone who had never opened the file
   while the actual owner kept editing it.
2. More fundamentally — **a request that must be remembered, in a repo where
   several sessions edit the same file, is not a guard. It is a hope with a
   deadline.** A search turned up THREE sessions that have described editing
   this one file.

Fixed by assertion (138a93d): `pnpm-workspace.yaml` already declares every root
that can hold a package, so any of them containing a `*.test.ts` must appear in
`TEST_ROOTS`. Proven by reintroducing the bug the way 058132b does — drop
`'tests'` and it fails by name; restore it and 7/7 pass.

**The general rule, and it is the same one P0 is about:** when the correct
behaviour depends on someone remembering something, encode it. Coordination by
message does not survive a rebase, a handoff, or three concurrent sessions.
Coordination by assertion does — and it tells whoever trips it exactly what
they broke, which no amount of asking can.

### P0.17 — The secrets gate scans a commit RANGE, and 35 findings sit behind it

Run 33937430520 was the first with **Test green** — every gate passed except
gitleaks, which failed like this:

    fatal: ambiguous argument '61ddb8ec…^..d884f85…': unknown revision
    failed to scan Git repository error="stderr is not empty"
    scanned ~0 bytes (0)

Not a leak — a scan that could not run and correctly refused to claim success.
`gitleaks-action` derives a COMMIT RANGE from the PR; a force-push destroys the
recorded base, so the range stops resolving. This branch is rebased constantly
(main moves roughly hourly), so that is not an edge case here, it is the norm.
Fourth distinct config defect in this one step: branch, token, permission,
range.

**And the range mode is why nobody has ever seen what a real scan finds.**
Measured locally with the repo's own config, gitleaks 8.24.3:

    607 commits scanned · leaks found: 35        (full history)
    working tree only    · leaks found: 35        (same set — they are LIVE files)

Triage, by file rather than by value:

| where | count | reading |
| --- | ---: | --- |
| `.test.ts` / `fixtures/` | **33** | redaction, token-sealing and grant-absence tests. This repo asserts "EVERY inventoried route answers without token material" — those tests need token-SHAPED strings by construction. Near-certainly canaries. |
| `docs/research/classifier-separation-…md:58` | 1 | prose; matched `generic-api-key` on the word "key". Reads as a false positive. |
| `scripts/step10-live-mcp.ts:64` | 1 | `REHEARSAL_TOKEN = …`. Name says rehearsal, but it is the one that deserves eyes. |

No obvious live credential. But `.gitleaks.toml`'s own allowlist comment says
*"CI scans git history (tracked content only), so these paths can never hide a
COMMITTED secret"* — a premise that was never true, because the action scans a
range and the workflow never ran.

**RESOLVED 2026-09-05 — option 3, triage then harden.**

All 35 triaged individually, none a live credential (table above). Allowlisted
in `.gitleaks.toml` by pattern with the reasons written down, and the residual
risk stated IN THE FILE rather than buried: a real credential pasted into a
`*.test.ts` or a `fixtures/` directory will not be caught by this gate. That is
accepted deliberately, because 35 permanent findings makes a gate nobody reads.

The scan then replaced gitleaks-action with the gitleaks BINARY over full
history at checkout depth 0 — deterministic, immune to force-push, needing no
token and no PR metadata, which is what `.gitleaks.toml`'s header always
claimed the CI step did ("runs `gitleaks git` (history)"). The binary is
CHECKSUM-VERIFIED before it executes: the tool that vouches for the repo's
secrets does not get to arrive unchecked. `permissions` drops to
`contents: read`, since `pull-requests: read` existed only for the action.

Verified: 608 commits of history and the working tree both report no leaks.

**Two things worth keeping from this one:**

1. A scanner that fails on git plumbing tells you nothing about secrets in
   either direction. Four consecutive failures here were all configuration,
   and a fifth would have looked identical to a real finding.
2. `.gitleaks.toml` documented a behaviour ("CI scans git history") that was
   never true of the workflow as written. The config was honest about intent
   and wrong about fact, and nothing could tell the difference until the gate
   ran. That is the same shape as everything else in this phase.

_Original framing, kept because the reasoning is why option 3 was chosen:_

**The decision, and it is not mine to make unilaterally.** Three states:

1. **Today:** the scan is broken, so it passes or fails on git plumbing rather
   than on secrets. Green by accident is the worst of the three.
2. **Make it robust** (scan the working tree, immune to force-push): correct,
   and immediately **red with 35 findings**.
3. **Triage first, then make it robust:** allowlist the canaries with reasons,
   put eyes on the two non-test hits, then switch the scan mode. Slower, and
   the only sequence that ends with a gate that means something.

Recommend 3. Weakening a secrets gate to get a green tick is the exact trade
this whole phase exists to refuse, and turning it red with 35 unreviewed
findings just teaches people to ignore it.

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

### P2.1 — Make the dangerous combination fatal, not advisory — **DONE 2026-09-05**

> Built alongside the review's P1-2 (the bypass also *defaulted* open on an
> unset NODE_ENV). `GateReport.fatal` exists, `devAuth && isProd` and
> `magicLink && selfServe && isProd` set it, `logBootGates` throws
> `BootRefusedError`, and `index.ts` prints the gate and exits 1. Asserted in
> `boot-report.test.ts`, and each half mutation-checked. The boot report also
> now calls the REAL `devAuthBypassEnabled` instead of re-implementing it, so
> the log and the server cannot disagree.

**What follows is the finding as written on 2026-09-02, kept for the record.
It is FIXED — read the note above before acting on any of it.**

`devAuthBypassEnabled()` in `apps/server/src/auth.ts` checked the explicit
`POTION_DEV_AUTH` flag *before* an `NODE_ENV !== 'production'` fallback, so
`POTION_DEV_AUTH=1` disabled authentication in production. `boot-report.ts`
already detected this exact state and already printed
`AUTH BYPASS IS ON IN PRODUCTION — every dashboard route is effectively public.`

The mechanism existed. The missing piece was that nothing refused:

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
