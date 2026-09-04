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
    testTimeout: 120_000,
    hookTimeout: 60_000,
    globalSetup: [fileURLToPath(new URL('../../vitest.prices-guard.ts', import.meta.url))],
  },
});
