// Vitest config: mirror the Next.js '@/' path alias (tsconfig paths) so
// component tests can import components that use the alias. Pure-lib tests
// use relative imports and are unaffected.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

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
    // This config SHADOWS the root one, so anything the root `test` block
    // carries must ride along explicitly — the same trap the prices guard
    // hit. Both the tripwire and the timeouts are copies, not inheritance.
    testTimeout: 120_000,
    hookTimeout: 60_000,
    globalSetup: [fileURLToPath(new URL('../../vitest.prices-guard.ts', import.meta.url))],
  },
});
