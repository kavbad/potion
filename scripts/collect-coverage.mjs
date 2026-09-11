// Collect this job's coverage summaries into one deterministic directory.
//
// WHY NOT A GLOB (2026-09-11). The first version of the split-coverage CI
// uploaded `**/coverage/coverage-summary.json` with `!**/node_modules/**`.
// pnpm symlinks every workspace dependency, so the SAME summary is reachable
// at dozens of paths like
//   packages/workers/node_modules/@potion/pareto/node_modules/@potion/core/coverage/…
// and upload-artifact rebases what it keeps against the least common
// ancestor — which strips the `node_modules` segment the ratchet skips on.
// The duplicates then counted as real packages: the union came out at 164,023
// lines against a true 72,800, and the ratchet failed by 28.89pp on a tree
// that had not changed.
//
// So collection is explicit. One summary per workspace package, keyed by the
// package's own path, which also makes the merge idempotent: if two jobs ever
// measure the same package, the second copy replaces the first rather than
// being added to it.
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUT = path.join(ROOT, 'coverage-artifacts');
const SKIP = new Set(['node_modules', 'dist', '.next', '.git', '.claude', 'coverage-artifacts']);

/** Real directories only — a pnpm symlink is not one, which is the whole point. */
const found = [];
const walk = (dir, depth = 0) => {
  if (depth > 4) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, depth + 1);
    else if (e.name === 'coverage-summary.json') found.push(full);
  }
};
walk(ROOT);

if (found.length === 0) {
  console.error('collect-coverage: no coverage-summary.json found. Run the suite with POTION_COVERAGE=1.');
  process.exit(1);
}

for (const f of found) {
  // `packages/db/coverage/coverage-summary.json` -> `packages__db`
  const slug = path.relative(ROOT, path.dirname(path.dirname(f))).split(path.sep).join('__') || 'root';
  mkdirSync(path.join(OUT, slug), { recursive: true });
  copyFileSync(f, path.join(OUT, slug, 'coverage-summary.json'));
}
console.log(`collect-coverage: staged ${found.length} summaries into coverage-artifacts/`);
