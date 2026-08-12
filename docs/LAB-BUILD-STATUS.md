# Lab build — status ledger

One row per completed step of [LAB-BUILD-PLAN.md](LAB-BUILD-PLAN.md). A step
appears here only when its definition of done is **proven** — walkthrough-
style where applicable, never asserted. Residual risks are recorded, not
smoothed over. The binding protocol (spec phase → operator approval → build
phase) lives in the plan; this file is the record of what actually happened.

| Step | Name | Date | Commit | Status |
|---|---|---|---|---|
| 1 | File and consolidate | 2026-08-11 | `3829cf9` | **complete** |
| 2 | Harness spec | 2026-08-11 | `4862b78` | **complete** |
| 3 | Runtime core | 2026-08-12 | `fe5dd27` | **complete** |
| 4 | Run records and deterministic replay | — | — | not started |
| 5 | Platform live sweep (rule-2 core work) | — | — | not started |
| 6 | Intent → spec generation | — | — | not started |
| 7 | The dial | — | — | not started |
| 8 | The novice loop, ugly | — | — | not started |
| 9 | The derived form [design gate] | — | — | not started |
| 10 | MCP client and token custody | — | — | not started |
| 11 | Superpower packaging and catalog | — | — | not started |
| 12 | Adversarial pass on the Lab surface | — | — | not started |
| 13 | Deploy and the Gate C flip | — | — | not started |
| 14 | Deployment surfaces for harnesses | — | — | not started |
| 15 | North-star run | — | — | not started |
| 16 | Pro instruments | — | — | not started |
| 17 | The command layer | — | — | not started |

---

## Step 1 — File and consolidate (2026-08-11)

**Done when:** docs committed; zero code touched. **Both hold.**

What was done:

- Plan filed **verbatim** at `docs/LAB-BUILD-PLAN.md` (diff-verified against
  the operator's source file).
- This ledger created.
- The three verification carry-forwards folded into `docs/LAB-ROADMAP.md`:
  1. **L1 single-strategy-tools partition** (A2) — new bullet in L1: tool-
     bearing slots draw only single-model frontier points; serving's 400 on
     composite-plus-tools is its documented contract and unreachable from
     Lab-generated configs.
  2. **Gate C flips only with explicit `POTION_SELF_SERVE=1`** (A5) — Gate C
     definition amended; unset means ON under the dev-auth bypass, so only
     the explicit value counts as the decision.
  3. **Platform-scope live sweep named as rule-2 work** (A1) — recorded in a
     new "Verification outcome" section, cross-referenced to build-plan
     Step 5; honest autopilot cold start is blocked on it.
- CLAUDE.md roadmap index now points at the build plan and this ledger.

Deviation from the plan's binding protocol, operator-authorized: the spec
phase was skipped for this step only, per the operator's instruction
("docs-only, so skip the spec phase for this step only").

Residual risks: none — no code was touched, so nothing can have regressed.
Step commit: `3829cf9`; this hash was stamped by the follow-up ledger commit
(the hash cannot be known before the commit exists).

Proof: `git show --stat 3829cf9` lists only `docs/LAB-BUILD-PLAN.md`,
`docs/LAB-BUILD-STATUS.md`, `docs/LAB-ROADMAP.md`, and `CLAUDE.md`.

---

## Step 2 — Harness spec (2026-08-11)

**Done when:** "spec package passes exhaustive validation tests and every
adversarial fixture is rejected with a typed reason." **Proven** — the corpus
run is this step's walkthrough-equivalent:

- `@potion/lab-spec` (new package; deps `@potion/core` + zod, dev-only ajv;
  no runtime, routes, db, or spend): types, strict zod schemas, content hash
  (`sha256(canonicalJson)` minus the embedded `hash` field — F7 discipline),
  `parseHarnessSpec`/`parseHarnessSpecText` collecting ALL issues with 12
  typed reason codes, published JSON Schema (draft 2020-12).
- **25-fixture corpus** (5 valid / 9 invalid / 11 adversarial), every fixture
  asserted fails-for-the-RIGHT-reason. Completeness meta-tests in every
  direction: every file classified, every classification has a file, every
  one of the 12 issue codes produced by ≥1 fixture, every parse↔ajv
  divergence carries a stated layer reason. Sample proof lines:
  `adversarial/proto-key.json → parse=dangerous-key, ajv=invalid`,
  `adversarial/hash-tampered.json → parse=hash-mismatch, ajv=valid (layer:
  hash truth is not expressible as shape)`,
  `valid/injection-prose.json → parse=valid, ajv=valid` (the boundary pin:
  scary prose is data, the parser is the attack surface).
- Package suite 40/40; each test file also green in isolation (standing
  rule); full `pnpm verify` green end-to-end (exit 0; 1,494 tests
  repo-wide).

**Deviations** (recorded in `docs/specs/step-02-harness-spec.md`): (1)
`LabPolicySchema` is a PROVEN strict subset of core `PolicySchema`, not a
reuse — core's objects strip unknown keys and carry serving-side
shadow/guarantee config a harness runtime would not honor; the subset
relationship is enforced by test, so "one dial vocabulary" is a fact, not a
comment. (2) The ajv agreement is scoped per-fixture with explicit layer
reasons instead of "identical classification" — JSON Schema cannot express
size/secret/control-char/relational/hash checks, and the meta-test makes any
unexplained divergence a build failure.

**Residual risks:** one workers test failed in the FIRST full-verify run and
did not reproduce in two subsequent full runs (workers 121/121 both times,
final verify exit 0). Its identity was lost because that verify's output went
through a grep filter — a process error, recorded: verify output is retained
unfiltered from now on. Plausible cause is CPU contention (two concurrent
vitest invocations ran alongside that verify; the same session earlier saw a
900s test under the same contention). If it recurs with a name, it gets
filed properly. Also standing: the secret-material patterns are deliberately
DUPLICATED from the G2.8 scrubber (scripts are not importable) — Step 10's
custody tests re-verify both copies.

Proof: `git show --stat 4862b78` — the step touches only
`packages/lab-spec/**`, `docs/specs/step-02-harness-spec.md`, this ledger,
and lockfile/workspace wiring. Zero changes to guarantee-product code.

---

## Step 3 — Runtime core (2026-08-12)

**Done when** (plan): a harness runs headless from a file, every model call
writes its own metered row, a mid-run budget hard-stop provably kills it, and
a walkthrough leg shows checkpoints survive the kill. **All proven**, plus the
three review additions, walkthrough-style against the REAL serving route
(`buildServer` on an ephemeral port — actual metering, budget gate, rate
limiter; no in-process shortcut exists in the test file).

What landed:

- **`@potion/lab-runtime`**: ServingClient (the ONE outbound module,
  touchpoint 1; `potion-auto` label; budget/rate-limit 429 taxonomy), the leg
  executor (leg-per-invocation, checkpoint-per-step, fenced writes,
  awaiting-human first-class with consume-on-use answer semantics), the
  secret gate on every checkpoint, llm.call span emission per the A3 shape,
  CLI (run/resume/answer/kill/show).
- **Migration 0035 + `@potion/db` repos** (operator ruling: schema-additive
  core under rule 2): `lab_runs` (state machine, cursor, fence, lease),
  `lab_run_steps` (verbatim step records), `lab_harness_memory`
  ((org, harness)-scoped). `deleteOrgCascade` extended and the F5
  schema-derived meta-test green in the same commit.

Proof lines (all green; every new test also green in isolation):

- db store: 9/9 — one CAS winner, expired-lease reclaim with the ZOMBIE'S
  LATE WRITE FENCED OUT, ordered appends, unfenced operator kill fencing the
  running invocation, terminal-refuses-with-fork-remedy, spec-drift refusal,
  awaiting-human answer lifecycle, cross-org invisibility of runs/steps/
  memory, cascade erasure with counts.
- runtime: 10/10 — tool execution with memory projection, suspend BEFORE the
  external tool runs → answer → resume completes with exactly one send,
  fuel kill mid-run with surviving checkpoint, secret-in-checkpoint typed
  failure (model step kept, leaky tool step refused), structural
  no-provider-imports test.
- walkthrough legs vs the real route: headless completion with the METERING
  JOIN (every model step's completionId ↔ exactly one request_logs row, our
  org) + spans ingested idempotently; org-budget 429 → killed-budget,
  terminal, resume refused; fuel hard stop mid-run through the real route
  with checkpoint surviving; spec-drift refusal end to end.
- Full `pnpm verify` exit 0 (unfiltered log retained): 1,513 tests repo-wide;
  guarantee-product dashboard walkthrough 18/18 untouched. The Step-2 workers
  flake did NOT recur across this step's four full verify runs.

**Findings, recorded not smoothed** (details in the spec file's deviations):

1. **Some mock-stack serving calls meter `usage.costUsd = 0`** (measured: a
   fallback-path call landed cost 0; a code-gen call landed $0.00009). An
   org-budget MID-RUN kill keyed to metered mock spend is therefore
   nondeterministic by construction — leg 2 proves the org 429 first-touch
   and the mid-run kill at the fuel layer (token-derived, deterministic).
   Deployment checklist item: re-prove the org-layer mid-run kill on live
   pricing.
2. **The budget gate cache is module-scoped**: a second `buildServer` in the
   same process shares it. F18 observed from inside a test — an in-process
   "new session" is not a new session. The cross-session resume story in the
   walkthrough uses the same db with a fresh client instead.
3. `brain.policy` does not yet drive serving selection (Step 6/7); recorded
   so the slot is not read as live.

Residual risks: checkpoint payload growth is O(context²) per run (accepted
v1, bounded by fuel; Step 4 revisits); cron check-ins are inert until L4
triggers exist; the CLI is programmatic-first and its argv surface is
untested beyond types (exercised properly in Step 8's novice loop).

Proof: `git show --stat fe5dd27` — guarantee-product sources untouched
except `packages/db` schema-additive files and the cascade extension the
ruling authorized.
