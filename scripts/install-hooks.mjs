// Points git at the COMMITTED .githooks/ directory, so the pre-push check
// travels with the repo instead of living in each clone's .git/hooks (which
// nothing can review and every fresh clone loses).
//
// Runs from package.json `prepare`, i.e. on every `pnpm install`. Exits 0
// quietly outside a git checkout (CI tarballs, published packages) — the one
// case where silence is right, because there is no hook path to set.
import { execFileSync } from 'node:child_process';
try {
  execFileSync('git', ['rev-parse', '--git-dir'], { stdio: 'ignore' });
} catch {
  process.exit(0); // not a git checkout — nothing to configure
}
try {
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' });
} catch (e) {
  // Loud, but not fatal: a missing hook must never block an install.
  console.warn(`[potion] could not set core.hooksPath: ${e.message}`);
}
