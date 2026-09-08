// Root vitest config: vitest defaults, plus the prices.json write tripwire.
// Exists so vitest's upward config search stops at the repo boundary and
// never picks up unrelated vite/vitest configs from ancestor directories.
// Every package without its own config (apps/server included) runs under
// this one, so the guard covers them all; apps/dashboard carries the same
// globalSetup in its own config.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // TIMEOUTS (2026-09-03). The suite ran on vitest's 5s/10s defaults while
    // real tests take 15-50s — PGlite boot, embedding, clustering. Under the
    // parallel load of `pnpm -r test` the borderline ones crossed the line and
    // the run failed with SIX timeouts and ZERO assertion failures, on a
    // machine where every one of those tests passes when run alone. A suite
    // whose red means "the laptop was busy" teaches you to re-run instead of
    // read, so the budget is set from what the tests actually cost.
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // Fails the run if the committed prices.json changes during it — the
    // stale-dist scan-writer tripwire (see vitest.prices-guard.ts).
    globalSetup: [fileURLToPath(new URL('./vitest.prices-guard.ts', import.meta.url))],
  },
});
