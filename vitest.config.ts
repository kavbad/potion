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
    // Fails the run if the committed prices.json changes during it — the
    // stale-dist scan-writer tripwire (see vitest.prices-guard.ts).
    globalSetup: [fileURLToPath(new URL('./vitest.prices-guard.ts', import.meta.url))],
  },
});
