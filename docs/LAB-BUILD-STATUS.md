# Lab build — status ledger

One row per completed step of [LAB-BUILD-PLAN.md](LAB-BUILD-PLAN.md). A step
appears here only when its definition of done is **proven** — walkthrough-
style where applicable, never asserted. Residual risks are recorded, not
smoothed over. The binding protocol (spec phase → operator approval → build
phase) lives in the plan; this file is the record of what actually happened.

| Step | Name | Date | Commit | Status |
|---|---|---|---|---|
| 1 | File and consolidate | 2026-08-11 | (stamped below) | **complete** |
| 2 | Harness spec | — | — | not started |
| 3 | Runtime core | — | — | not started |
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
The commit hash for this step is stamped in the row above by the follow-up
ledger commit (the hash cannot be known before the commit exists).

Proof: `git show --stat <commit>` lists only `docs/LAB-BUILD-PLAN.md`,
`docs/LAB-BUILD-STATUS.md`, `docs/LAB-ROADMAP.md`, and `CLAUDE.md`.
