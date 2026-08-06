# M1B-RUNBOOK — Live eval runs on your machine (one command, hard-capped)

Why: the build sandbox's network egress blocks OpenAI/Anthropic/Google APIs (403/unreachable)
and OpenRouter serves only DeepSeek-class models from that region. Your machine has no such
restriction. Everything is scripted; every run is budget-capped preflight. Total cap: **$50**.

## 0. Setup (5 min)

```bash
# clone/copy this repo to your machine, then:
cd potion
```

Create `.env` at the repo root:
```
OPENROUTER_API_KEY=sk-or-...your spend-limited key...
OPENAI_API_KEY=sk-... # optional but recommended — needed for Gate-2 embedding rerun (step 3)
```

Requires: Node 20+, pnpm 9 (`npm i -g pnpm@9.15.9`). Zero services needed (embedded PGlite).

```bash
pnpm install && pnpm build
```

## 1. Gate-3 live rerun on v2 suites — cap $25 (~15 min)

```bash
set -a; source .env; set +a
mkdir -p artifacts
pnpm harness -- --suite-v2 code-gen-humaneval-js-v1 --suite-v2 extraction-authored-v1 \
  --provider live --cap 25 \
  --strategy '{"type":"single","model":"or-gpt-mini"}' \
  --strategy '{"type":"single","model":"or-gpt-full"}' \
  --strategy '{"type":"single","model":"or-sonnet"}' \
  --strategy '{"type":"cascade","stages":[{"model":"or-gpt-mini","escalateIf":{"confidenceBelow":0.72}},{"model":"or-sonnet"}],"confidenceMethod":"self-report-calibrated"}' \
  --strategy '{"type":"best-of-n","model":"or-gpt-mini","n":3,"judge":{"model":"or-judge"}}' \
  --strategy '{"type":"draft-verify","draftModel":"or-gpt-mini","verifierModel":"or-sonnet"}' \
  2>&1 | tee artifacts/m1b-gate3-live.log
```
(Exact strategy set may be adjusted by the orchestrator; the cap is enforced regardless.)

## 2. Ten-cluster frontier sweeps — cap $15 (~20 min)

```bash
pnpm tsx scripts/m1b-sweep.ts --cap 15 2>&1 | tee artifacts/m1b-sweep.log
```
(Runs the 3-baseline + 3-composite set on the 8 authored breadth suites.)

## 3. Gate-2 rerun on real embeddings — needs OPENAI_API_KEY (~5 min, <$1)

```bash
POTION_EMBEDDER=openai pnpm --filter @potion/cluster evaluate 2>&1 | tee artifacts/m1b-gate2-live.log
```

## 4. Send results back

```bash
git add artifacts/ tasks/todo.md
git commit -m "m1b: live run artifacts (spend: see ledger)"
```
Then tell the orchestrator "M1b artifacts committed" — it will analyze, reconcile the spend
ledger ($50 hard cap), recompute frontiers from live data, and publish the live-provenance
frontiers for serving.

## Safety rails (already enforced by the code)
- Preflight projection: any run whose projected spend exceeds `--cap` refuses to start (exit 2).
- Spend accounting includes judge scoring cost (fixed post-M1a) — preflight projections, per-result usage, run spend, and $/1K all count llm-judge calls.
- The ledger in `tasks/todo.md` is append-only; paste each run's projected/actual into it.
- If anything behaves unexpectedly: stop, keep the log, and hand it to the orchestrator.
