# Potion — Claude Code project context

Potion is an OpenAI-API-compatible inference router: it clusters incoming
prompts into workloads, benchmarks models AND model compositions (single,
cascade, best-of-n, draft-verify) per cluster, computes the quality/cost
Pareto frontier, and routes each request per the org's policy. pnpm monorepo;
Fastify server (`apps/server`), Next dashboard (`apps/dashboard`), packages
for providers/strategies/harness/cluster/pareto/db/workers/etc.

## State as of 2026-08-06 (audited)

- 546 tests green across 14 packages + chaos suite + python SDK.
- M1b live eval complete (Gate-3 + 8-suite sweep, OpenRouter, $3.88 spent).
  Ledger + full execution report: `tasks/todo.md`. Artifacts: `artifacts/`.
- Four defects were found and fixed during M1b (all with regression tests):
  `--provider` CLI flag, env-var API-key fallback in the provider factory,
  code-exec markdown-fence stripping (sonnet scored 0.000 without it —
  pre-fix code-exec numbers for fence-emitting models are INVALID, treat as
  unmeasured), and `--resume` passthrough in `scripts/m1b-sweep.ts`.
- Honest-stub convention: unbuilt paths throw loudly or self-label
  (Stripe backend, SMTP, cloud-KMS, python scorer). Preserve this. Never
  add a silent fallback or a mock that impersonates live output.

## Known defects / debt (verified in audit)

1. `apps/server` (~8.9K LOC) has ZERO tests. Every M1b bug lived in
   unexercised paths; assume more of the same class here.
2. Cost estimator undercounts actuals ~2.3× (sweep: projected $1.44,
   actual $3.37; per-suite actuals consistently exceed "worst-case"
   projections). Preflight refusal must dominate actuals or it is theater.
3. Eval suites are n=12–14 per cluster — frontier is directional, not
   statistical.
4. 8 pre-existing lint errors (unused imports, not ours) block `pnpm verify`.
5. Rate limiting + assignment cache are per-replica in-memory (Redis store
   is a designed seam, `apps/server/src/middleware/ratelimit.ts`).
6. Gate-2 live embeddings path never run (needs OPENAI_API_KEY).

## Roadmap (owner-ordered: product truth first, Stripe LAST)

- **Phase 1 — make the core claim true:** (1) fix cost estimator so
  projections dominate actuals; (2) scale suites to 50–100+ items/cluster
  + run Gate-2 live; (3) wire continuous re-eval loop (researcher pkg);
  (4) automated model catalog + price ingestion (replace hand-kept
  `prices.json`).
- **Phase 2 — survive real traffic:** (5) server test suite; (6) Redis
  rate limiting + shared caches; (7) cloud-KMS custody; (8) HA verification
  + CI gating (fix the 8 lint errors, `pnpm verify` gates merges).
- **Phase 3 — front door:** (9) SMTP magic links; (10) landing + API docs
  portal + public model/pricing page; (11) publish SDKs (npm/PyPI);
  (12) signup abuse controls; (13) legal review (operator-side).
- **Phase 4 — money:** (14) Stripe + prepaid credit ledger + fraud
  screening. Deliberately last.

## Working conventions (owner's rules)

- Plan mode for any non-trivial task; write the plan to `tasks/todo.md`
  with checkable items and check in before implementing.
- After any correction, add the pattern to `tasks/lessons.md`; review it
  at session start.
- Never mark done without proving it works: run tests, show output, diff
  behavior. Would a staff engineer approve it?
- Simplicity first, root causes only, minimal blast radius. If a fix feels
  hacky, implement the elegant version instead. Don't over-engineer
  simple fixes.
- Fix bugs autonomously from logs/failing tests; don't ask for
  hand-holding.
- Keep the spend ledger in `tasks/todo.md` current for ANY live API run:
  projected vs actual vs cumulative, before and after.

## Commands

- `pnpm install` · `pnpm build` · `pnpm test` (per-package:
  `pnpm --filter @potion/<pkg> test`) · `pnpm verify` (currently fails on
  pre-existing lint) · server: `pnpm --filter @potion/server dev`
  (PGlite + demo seed when DATABASE_URL unset; demo key in
  `apps/server/src/seed.ts`) · evals: `pnpm harness -- --suite-v2 <id>
  --provider <mock|live> --cap <usd> --resume` · sweep:
  `pnpm tsx scripts/m1b-sweep.ts --cap <usd> --resume`
- Live runs read `OPENROUTER_API_KEY` (etc.) from env/`.env`; persistent
  results: `DATABASE_URL=pglite://<abs-path>` + `--resume`.
