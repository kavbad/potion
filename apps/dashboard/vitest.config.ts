// Vitest config: mirror the Next.js '@/' path alias (tsconfig paths) so
// component tests can import components that use the alias. Pure-lib tests
// use relative imports and are unaffected.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(ROOT) },
  },
  esbuild: {
    // React 19 automatic JSX runtime (the dashboard never imports React).
    jsx: 'automatic',
  },
  test: {
    // This config SHADOWS the root one, so anything the root `test` block
    // carries must ride along explicitly — the same trap the prices guard
    // hit. Both the tripwire and the timeouts are copies, not inheritance.
    //
    // scripts/vitest-config-shadow.test.ts is what notices when one goes
    // missing, and it is how the CI cap below was caught — the root gained it
    // and this copy did not.
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // Mirrors the root's CI worker cap, conditional included: the guard
    // compares KEYS, and a copy that is unconditional here while the root is
    // conditional would diverge in the direction nobody looks (local runs).
    ...(process.env.CI ? { maxWorkers: 2, minWorkers: 1 } : {}),
    globalSetup: [fileURLToPath(new URL('../../vitest.prices-guard.ts', import.meta.url))],
  },
});
