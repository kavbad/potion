# Potion Lab — Build Plan

This plan covers one thing: building the Potion Lab product on Potion, end to end. No go-to-market, no partner motions — those belong to the operator, outside this document. **Start condition is operator-declared**: when this plan begins is the operator's standing call; nothing in the plan changes either way.

Everything through Step 12 runs locally, the same way the entire guarantee product was built — the first step that requires a provisioned server is Step 13a (deploy). Step 13 was split into **13a — Deploy the stack** and **13b — Gate C flip**; they execute at different points in the ladder (see the note above Step 13a).

## Binding protocol for every session

- Work only the step named by the operator. Never start the next step unprompted.
- **Every step runs in two phases.** Phase one, spec: read the plan, the roadmap, the status ledger, and the relevant code; write the implementation spec — schemas, package layout, test plan, risks, what could go wrong — to `docs/specs/step-NN-<slug>.md`; stop with exactly: **"Step N spec ready for review. Let me know when I should build."** Phase two, build: only after operator approval, execute against the approved spec; any deviation is recorded in the spec file, never made silently.
- A step is complete only when its definition of done is **proven** — walkthrough-style where applicable, never asserted.
- On completion: update `docs/LAB-BUILD-STATUS.md` (date, commit, what was proven, residual risks), then end with exactly: **"Step N — [name] — complete. Let me know when I should proceed to Step N+1 — [name]."**
- If blocked or falsified: record it, report honestly, stop. Improvising forward is never correct.
- Legs that can exceed the tool wall-clock run detached or leg-per-invocation with resume.
- The additive contract, the four sanctioned core touchpoints, standing decisions, and agent instructions in `docs/LAB-ROADMAP.md` bind every step. Lab code lives in new packages; new routes enter the route inventory classified, org-scoped, mock/live separated; all spend through the metered chokepoints.

## The ladder

**Step 1 — File and consolidate [docs only].**
Work: file this plan at `docs/LAB-BUILD-PLAN.md`; create `docs/LAB-BUILD-STATUS.md`; fold the three verification carry-forwards into `LAB-ROADMAP.md` (L1 single-strategy-tools partition; Gate C flips only with explicit `POTION_SELF_SERVE=1`; platform-scope live sweep as named rule-2 work).
Done when: docs committed; zero code touched.

**Step 2 — Harness spec.**
Work: the harness file format as implemented types + validators, not just an RFC — slots for brain policy, mission (task-shaped with done-definition, or standing), superpowers, memory, rules, fuel, check-ins; versioning; content-hash over canonicalized spec (same discipline as certification hashes); JSON Schema + TS types; fixture corpus of valid, invalid, and adversarial specs (oversized, malformed, injection-shaped).
Done when: spec package passes exhaustive validation tests and every adversarial fixture is rejected with a typed reason.

**Step 3 — Runtime core.**
Work: the loop executor — step machine with per-step checkpoints; run records with per-step cost attribution; serving consumed strictly as a client (touchpoint 1, no new provider-call paths); hard-stop and kill honored mid-run; OTel GenAI span emission per the verified ingest shape; timeouts and leg-per-invocation resumability. Pause-for-human as a first-class run state: a check-in question suspends the run, persists the checkpoint, and resumes on the operator's reply — without this, the check-ins slot is decorative. The harness memory store: per-harness, org-scoped, deletion-cascade compliant, never readable across harnesses. Respect the driver-semantics lesson: any test double for the queue or clock gets its production divergence documented.
Done when: a harness runs headless from a file, every model call writes its own metered row, a mid-run budget hard-stop provably kills it, and a walkthrough leg shows checkpoints survive the kill.

**Step 4 — Run records and deterministic replay.**
Work: run-record schema designed for two consumers — the future bench (fork-from-step) and step-level eval items; deterministic mock-provider mode for harness runs under the existing mock/live separation invariants; conversion of run records into eval items via the existing step-synthesis path.
Done when: a recorded run replays deterministically in mock, and its steps land as eval items without converter changes.

**Step 5 — Platform live sweep (rule-2 core work).**
Work: platform-scope live-sweep job (the org-scoped sweep generalized), run locally under an operator-set cap with rotated keys; lift platform frontiers beyond the 2/10 SIMULATED seed; provenance on every point; SIMULATED evidence remains excluded from anything autopilot-facing per dial honesty.
Done when: platform frontiers cover the cluster taxonomy on live evidence under cap, ledgered and reconciled.

**Step 6 — Intent → spec generation.**
Work: the mission interview (plain-language goal, done-definition or standing declaration, accounts, worth-per-run); autopilot slot-filling from platform frontiers with per-choice provenance; generated spec is a first-class harness file, hash and all.
Done when: a plain-language mission produces a valid, runnable spec where every autopilot choice traces to a frontier point.

**Step 7 — The dial.**
Work: compound policy (quality floor + latency bound + minimized cost) read per slot and per harness (touchpoint 2); the single-strategy partition enforced by construction — tool-bearing slots draw only single-model frontier points, tool-free slots keep the full composite frontier, and serving's 400 is unreachable from Lab paths; felt samples — eval runs at dial points yielding projected cost, latency, and a sample output on the user's own task.
Done when: a dial move produces measured, demonstrable differences, and no Lab-generated config can request tools on a composite strategy.

**Step 8 — The novice loop, ugly.**
Work: chat-to-harness wired end to end against the runtime — plain UI permitted at this step; trial mission with live narration rendered from run records; cost ticker from per-step attribution; the check-in surface — a suspended harness's question reaches the user and their reply resumes the run; memory viewable and editable in plain language; run report v1 (what happened, what it cost, where it struggled, exactly one suggested upgrade).
Done when: a novice-shaped session goes intent → running harness → report with zero documentation, timed under ten minutes.

**Step 9 — The derived form [design gate].**
Work: the living visual — core, membrane, filaments, luminosity — computed from real configuration and telemetry; continuous zoom (living form → labeled anatomy); tap-to-edit plain-language panels; live re-render on config change. Produce the pixel-to-parameter audit: every visual property maps to a named real parameter, or it doesn't ship.
Done when: the audit is complete, no template UI remains, and the operator's taste review passes — operator sign-off is part of this exit, not a courtesy.

**Step 10 — MCP client and token custody.**
Work: MCP client in the runtime, hosted/remote connectors only; OAuth flows; credentials in the platform secret store, never in specs, run records, or reports — proven by test; scopes; per-tool spend caps extending Fuel through the metered chokepoints.
Done when: adversarial attempts to exfiltrate tokens via spec, report, or narration fail in tests, and per-tool caps trip live under a small operator-ledgered budget.

**Step 11 — Superpower packaging and catalog.**
Work: the package format — connector + usage instructions + failure handling + mini-eval as one slottable unit; ~25 curated superpowers with safe defaults; injection posture enforced — tool results are untrusted input, external actions permission-gated by default, relaxed only by explicit Rules.
Done when: 25 superpowers pass their mini-evals, an injection test corpus fails to move any harness past its Rules, and permission prompts provably fire on external actions.

**Step 12 — Adversarial pass on the Lab surface.**
Work: swarm-style pass — spec parsing, the MCP boundary, token custody, spend paths, tenancy and authz of every new Lab route against the inventory lenses. Budget for findings; the pass is judged by what it catches.
Done when: findings are filed with severities, all criticals fixed and pinned by tests, and the Lab's route inventory is complete and classified.

**Step 13 was split (2026-08-15, operator) into 13a and 13b.** The deploy half (13a) is a hard prerequisite of Steps 14 and 15 — a standing harness on a schedule (14) and a real non-engineer reaching a URL (15) both need a running server — so it moves up. The Gate C half (13b) opens the doors to paying strangers, and nothing before Step 15 requires a stranger's payment, so it moves down to just before Step 17. **Execution order: 13a → 14 → 15 → 16 → 13b → 17.** The entries below sit in execution order so top-to-bottom reads as the sequence.

**Step 13a — Deploy the stack.**
Work: production deployment on real infrastructure — provisioned Postgres (pgvector, ≥PG15), a host/compute layer, the container/TLS layer, real Redis for the queue, secrets, migrations applied on the F12 ledger; the seven unexecuted container/TLS rehearsal items (`docs/REHEARSAL-COVERAGE.md`) run for real on the host; the org-budget mid-run kill (the named Step 3 item) re-proven on live pricing under an operator spend cap; a deployment status doc. Auth stays on (`NODE_ENV=production`, dev-auth bypass off); `POTION_SELF_SERVE` stays unset. No payments, no self-serve, no abuse controls — those are 13b.
Done when: the operator can reach the Lab at a real URL over TLS, `/readyz` is green on the domain, and a harness runs end to end through the deployed path (operator-onboarded org, not localhost).

**Step 14 — Deployment surfaces for harnesses.**
Work: harness identity; endpoint and cron triggers, then Slack and email; standing harnesses heartbeat-shaped (bounded scheduled runs) before always-on; per-harness P&L via the one invoice-dimension touchpoint, parallel rollup, `usage_daily` row identity untouched.
Done when: a harness runs on a schedule with its own budget and its own ledger, visible in the product.

**Step 15 — North-star run.**
Work: recruit a real non-engineer; observe and record them assembling an OpenClaw-class standing harness — hosted, permissioned, metered — without touching a terminal. Every failure becomes a work item; the step repeats until they succeed.
Done when: the recording exists and the person succeeded unassisted.

**Step 16 — Pro instruments.**
Work: the bench — replay any run, inspect the exact per-step context the model saw, fork from any step and re-run; the proving ground — promote any run to a golden pair, derived suites, replay-on-change with confidence intervals, champion/challenger as a Lab-side pattern over existing suite and verdict machinery (touchpoint 3); close zoom — full slot panels, two-way spec sync, bring-your-own-editor.
Done when: a change to a harness is proven better or worse before it lands, on the product's own instruments.

**Step 13b — Gate C flip.** *(Executes here — after Step 16, before Step 17.)*
Work: the Gate C prerequisites carried verbatim from the original Step 13, none dropped in the split — **payments and credits for fuel**; **abuse controls**; **guided onboarding** (the self-serve counterpart to operator onboarding); then the deliberate flip — **explicit `POTION_SELF_SERVE=1`, never an inherited default** (the standing decision in `docs/LAB-ROADMAP.md`); and the **novice loop measured on strangers**. Rides the deployed stack from 13a; the standing decision that Gate C flips only on an explicit flag is unchanged.
Done when: strangers can sign up, fund fuel, and the novice loop holds on people who've never seen the product — under ten minutes, no documentation.

**Step 17 — The command layer.**
Work: org-wide harness catalog; policies and budgets inherited from org configuration; pre-approved superpower library; audit trails; internal certification — the guarantee machinery pointed inward, with the promotion path from personal harness to department-blessed tool.
Done when: the promotion path is proven walkthrough-style on a multi-org fixture, certification badges agree across every surface, and org deletion provably cascades through every Lab table.

## The standard

This plan builds the category's instrument, so its own discipline is the first proof of the product. Done means proven. Honest falsification outranks flattering progress. Nothing buys an exception to the additive contract, key hygiene, or the standing decisions.
