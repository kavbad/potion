# Potion Threat Model (M2)

One page. Scope: the Potion platform (TypeScript pnpm monorepo) at M2. Audience: engineers
touching security-relevant surfaces. Companion: [CODE-EXEC.md](./CODE-EXEC.md).

## Assets

| Asset | Why it matters | Where |
|---|---|---|
| Customer API keys (Potion-issued) | Account takeover, spend theft | `apps/server`, `packages/db` (hashed at rest, M2-auth) |
| Provider keys (`OPENROUTER_API_KEY`, …) | Direct provider spend on our dime | `.env` (gitignored), CI secrets; never committed (gitleaks gate) |
| Customer prompts & model outputs | Customer confidential data; injection carriers | Request path, `packages/strategies`, eval artifacts |
| Eval evidence (scores, traces, provenance) | Attacker benefits from forged/corrupted quality claims | `packages/harness` results, `packages/db` |
| Billing/metering state | Revenue integrity | `apps/server` metering + rate limiting (M2-metering) |

## Trust boundaries

1. **Untrusted model output** — every completion is adversary-influenceable text. It is parsed
   (PICK / SCORE / CONFIDENCE / subtask JSON), re-prompted (judge, self-report probe), executed
   (code-exec), and stored (traces).
2. **Untrusted customer prompts** — flow into judge meta-prompts, decompose prompts, and logs.
3. **Untrusted benchmark code** — eval items ship JS `tests` snippets + generated answers that
   we execute (boundary 1's worst case).
4. **Provider API** — outbound spend; keys must not leak through prompts, traces, or logs.

## Current controls (M2)

- **Code-exec sandbox** (`harness/code-exec-sandbox.ts`): worker_threads isolation, 2s wall
  timeout + terminate, 32MB V8 heap cap, stripped worker globals, no string/wasm code
  generation, message-passing results. *Not a container — see gaps.* Details: CODE-EXEC.md.
- **Prompt-injection hardening** (`core/safety.ts`, used by `strategies` + `harness` scorers):
  untrusted text wrapped in `<<<UNTRUSTED_DATA_BEGIN/END>>>` blocks with DATA-not-instructions
  framing; PICK/SCORE/CONFIDENCE parsed as the LAST line-anchored occurrence with bounded
  values and deterministic parse-failure fallbacks (+ trace markers); decompose capped at 8
  subtasks / 4k chars per prompt, kind allowlist against routing-table own keys (no prototype
  keys), unsafe kinds coerced.
- **Supply chain:** Dependabot (weekly, grouped), CI gate `pnpm audit --prod --audit-level=high`
  with an explicit advisory allowlist, CycloneDX SBOM (`scripts/sbom.sh` → `artifacts/`).
- **Secrets hygiene:** gitleaks config + CI step; `.env` gitignored; CI fails on committed secrets.
- **Auth/tenancy/metering** (parallel M2 streams): hashed customer keys, per-tenant isolation,
  rate limits, usage rollups — owned by apps/server + packages/db.

## Honest residual risk (accepted, documented)

- Delimiter framing + strict parsing **cannot** stop a judge model from being *persuaded* by
  injected content into voluntarily emitting an injected PICK/SCORE line. The parser is
  hijack-proof; the model is not. Mitigations today: bounded values, conservative floor on
  parse failure, trace markers for audit. Future: judge ensembles, spot re-scoring, anomaly
  detection on judge/answer disagreement.
- The mock provider (`packages/providers/src/mock`) is a TEST/CI simulation only; its "ground
  truth" corpus is quarantined from customer-facing claims (see eval-corpus.ts header).

## M2 → M3 gap list

| Gap | Owner | Notes |
|---|---|---|
| Container/microVM sandbox (gVisor/Firecracker), seccomp, cgroup CPU/mem, egress-deny | infra (M3) | worker_threads contains crashes/trivial escapes only; kernel-level exploits out of scope today |
| Cloud KMS / secret manager for provider keys | infra (M3) | keys currently in gitignored `.env` + CI secrets; no rotation/HSM |
| WAF / API edge protection | infra (M3) | app-level rate limiting exists (M2-metering); no L7 edge filtering |
| Non-JS code-exec (python) inside the sandboxed runtime | harness+infra | currently rejected with a documented warning |
| Judge-injection active defenses (ensembles, disagreement alarms) | eval (M3+) | residual risk above |
| Security review of dashboard bundle / CSP headers | web (M3) | not assessed in M2 |
