// Root vitest config: vitest defaults, plus the prices.json write tripwire.
// Exists so vitest's upward config search stops at the repo boundary and
// never picks up unrelated vite/vitest configs from ancestor directories.
// Every package without its own config (apps/server included) runs under
// this one, so the guard covers them all; apps/dashboard carries the same
// globalSetup in its own config.
import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // COVERAGE (P1.4). Opt-in via POTION_COVERAGE=1 so a normal `pnpm test`
    // keeps its current ergonomics; CI turns it on for the one suite run it
    // already does. Measured overhead is ~11% (packages/db 45s -> 50s), which
    // is far cheaper than a second full run.
    //
    // v8 provider, json-summary per package; scripts/coverage-ratchet.mjs
    // aggregates them into one number and compares it to coverage-baseline.json.
    coverage: {
      enabled: process.env.POTION_COVERAGE === '1',
      provider: 'v8',
      reporter: ['json-summary', 'text-summary'],
      reportsDirectory: './coverage',
    },
    // The SAME phantom multiplier the eslint config carries an ignore for
    // (P0.4): .claude/worktrees holds stale checkouts of this repo, and any
    // tool that walks the tree finds each test once per worktree. `vitest run
    // scripts` collected 4 real files and 12 copies, which then ENOENT on
    // artifacts those worktrees do not have — a local-only failure, since
    // .claude/ is in .git/info/exclude and CI never sees it, but the primary
    // checkout is exactly where a person runs `pnpm test` before pushing.
    //
    // Spread `configDefaults.exclude` rather than passing --exclude: the flag
    // REPLACES the default array and would pull node_modules back in.
    exclude: [...configDefaults.exclude, '**/.claude/**'],
    // TIMEOUTS (2026-09-03). The suite ran on vitest's 5s/10s defaults while
    // real tests take 15-50s — PGlite boot, embedding, clustering. Under the
    // parallel load of `pnpm -r test` the borderline ones crossed the line and
    // the run failed with SIX timeouts and ZERO assertion failures, on a
    // machine where every one of those tests passes when run alone. A suite
    // whose red means "the laptop was busy" teaches you to re-run instead of
    // read, so the budget is set from what the tests actually cost.
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // CONCURRENCY ON CI (2026-09-08). Every test file gets its own worker and
    // most of them boot PGlite — a WASM Postgres — so the default "as many
    // workers as cores, times four packages at once" oversubscribes a 2-vCPU
    // runner. The failure does not arrive as an out-of-memory: it lands on
    // whichever test forks a subprocess at the wrong moment. The X7 sandbox
    // test's shell died with
    //   __potion_main__.sh: fork: retry: Resource temporarily unavailable
    // exit 254, timedOut false, nothing written — and the assertion it failed
    // was about a missing output file, three layers from the cause.
    ...(process.env.CI ? { maxWorkers: 2, minWorkers: 1 } : {}),
    // Fails the run if the committed prices.json changes during it — the
    // stale-dist scan-writer tripwire (see vitest.prices-guard.ts).
    globalSetup: [fileURLToPath(new URL('./vitest.prices-guard.ts', import.meta.url))],
  },
});
