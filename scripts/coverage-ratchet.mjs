// COVERAGE RATCHET (P1.4). Aggregates every package's coverage-summary.json
// into one number and compares it to coverage-baseline.json.
//
// TWO-SIDED, deliberately, like the escape-hatch ratchet in
// test-typecheck-coverage.test.ts. A number policed only against FALLING
// drifts upward unrecorded, and then nobody knows what the floor is. A rise
// must be locked in; a drop must be explained.
//
// It reports LINES, and the tolerance exists because total lines move with
// every commit: a 0.5pp band absorbs ordinary churn without absorbing a real
// regression.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BASELINE = path.join(ROOT, 'coverage-baseline.json');
const TOLERANCE = 0.5;

const summaries = [];
// `coverage-artifacts` is skipped when walking the repo so a local run that
// has both the originals and a staged copy counts each package ONCE.
const skip = new Set(['node_modules', 'dist', '.next', '.git', '.claude', 'coverage-artifacts']);
const walk = (dir, depth = 0) => {
  if (depth > 4) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (skip.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, depth + 1);
    else if (e.name === 'coverage-summary.json') summaries.push(full);
  }
};
// THE STAGED SET WINS WHEN IT EXISTS (2026-09-11). CI runs the suite in two
// jobs, so neither can see the whole tree; each stages its summaries with
// scripts/collect-coverage.mjs and the `coverage` job downloads both into
// coverage-artifacts/ before judging. Locally, with no staging directory,
// this walks the repo exactly as it always did.
const STAGED = path.join(ROOT, 'coverage-artifacts');
if (existsSync(STAGED)) {
  walk(STAGED);
  console.log(`coverage-ratchet: reading the staged union in coverage-artifacts/ (${summaries.length} summaries)`);
} else {
  walk(ROOT);
}

if (summaries.length === 0) {
  console.error('coverage-ratchet: no coverage-summary.json found. Run with POTION_COVERAGE=1.');
  process.exit(1);
}

let covered = 0, total = 0;
for (const f of summaries) {
  const t = JSON.parse(readFileSync(f, 'utf8')).total?.lines;
  if (!t) continue;
  covered += t.covered; total += t.total;
}
const pct = total === 0 ? 0 : (covered / total) * 100;
const rounded = Number(pct.toFixed(2));

if (process.argv.includes('--write')) {
  writeFileSync(BASELINE, JSON.stringify({ lines: rounded, covered, total }, null, 2) + '\n');
  console.log(`coverage-ratchet: baseline written — ${rounded}% (${covered}/${total} lines, ${summaries.length} packages)`);
  process.exit(0);
}
if (!existsSync(BASELINE)) {
  console.error('coverage-ratchet: no coverage-baseline.json. Create it with --write.');
  process.exit(1);
}
const base = JSON.parse(readFileSync(BASELINE, 'utf8')).lines;
console.log(`coverage-ratchet: ${rounded}% lines (${covered}/${total}) across ${summaries.length} packages; baseline ${base}%`);

if (rounded < base - TOLERANCE) {
  console.error(
    `coverage-ratchet: FAIL — coverage fell ${(base - rounded).toFixed(2)}pp below the baseline.\n` +
    `\n` +
    `  FIRST, CHECK THE DENOMINATOR — it is usually the denominator.\n` +
    `    ${summaries.length} packages, ${total} lines. If either looks wrong, the tree being\n` +
    `    measured is wrong and the coverage is fine. Twice on 2026-09-11 this\n` +
    `    "drop" was a measurement artifact: once when @potion/workers moved to\n` +
    `    its own CI job and its tree went missing (63,663 lines, -1.10pp), once\n` +
    `    when a repo-root aggregate double-counted every file (164,088 lines,\n` +
    `    -28.90pp). A real regression moves the covered count, not the total.\n` +
    `\n` +
    `  THEN, if the tree is right: tests were removed, or code landed with none.\n` +
    `    Add tests.\n` +
    `\n` +
    `  LOWERING THE BASELINE IS ALMOST NEVER THE ANSWER, and it is the only\n` +
    `    action here that cannot be undone by review — the floor is gone and\n` +
    `    nobody can tell it ever moved. It is correct in exactly one case:\n` +
    `    covered code was deliberately DELETED. If that is genuinely what\n` +
    `    happened, lower it in the same commit as the deletion, so the diff\n` +
    `    carries its own reason.`);
  process.exit(1);
}
if (rounded > base + TOLERANCE) {
  console.error(
    `coverage-ratchet: FAIL — coverage ROSE ${(rounded - base).toFixed(2)}pp above the baseline.\n` +
    `\n` +
    `  CHECK THE DENOMINATOR FIRST here too: ${summaries.length} packages, ${total} lines.\n` +
    `    A rise can be a measurement artifact as easily as a fall — a summary\n` +
    `    counted twice raises the number without anyone writing a test.\n` +
    `\n` +
    `  If the tree is right, this is good news and locking it in is the whole\n` +
    `    point: pnpm coverage:baseline, committed with the work that earned it.\n` +
    `    A number policed only downward drifts back up unrecorded, and then\n` +
    `    nobody knows what the floor actually is.`);
  process.exit(1);
}
console.log('coverage-ratchet: ok');
