// Build every workspace package in an order computed from PRODUCTION
// dependencies only.
//
// `pnpm -r build` sorts on dependencies AND devDependencies, and the Lab
// packages devDepend on @potion/server (for their tests) while the server
// depends on them for real — a cycle pnpm cannot order, so in a clean tree
// (the Docker image) lab-dial builds before lab-runtime's dist exists and tsc
// fails on a module that is simply not built yet. The laptop never noticed
// because stale dist outputs were always present. The runtime graph has no
// cycles (verified 2026-08-21: every cycle carries exactly one dev edge), so
// ordering on it alone is both correct and deterministic.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const roots = ['packages', 'apps'];
const pkgs = new Map();
for (const r of roots) {
  if (!existsSync(r)) continue;
  for (const d of readdirSync(r)) {
    const pj = join(r, d, 'package.json');
    if (!existsSync(pj)) continue;
    const j = JSON.parse(readFileSync(pj, 'utf8'));
    pkgs.set(j.name, { dir: join(r, d), deps: Object.keys(j.dependencies ?? {}), hasBuild: Boolean(j.scripts?.build) });
  }
}

const order = [];
const state = new Map(); // visiting | done
function visit(name, chain = []) {
  const s = state.get(name);
  if (s === 'done') return;
  if (s === 'visiting') throw new Error(`runtime dependency cycle: ${[...chain, name].join(' -> ')}`);
  state.set(name, 'visiting');
  for (const d of pkgs.get(name).deps) if (pkgs.has(d)) visit(d, [...chain, name]);
  state.set(name, 'done');
  order.push(name);
}
for (const name of [...pkgs.keys()].sort()) visit(name);

const only = process.argv.slice(2); // optional: restrict to these + their deps
const wanted = only.length ? new Set() : null;
if (wanted) {
  const add = (n) => { if (wanted.has(n)) return; wanted.add(n); for (const d of pkgs.get(n).deps) if (pkgs.has(d)) add(d); };
  only.forEach(add);
}

for (const name of order) {
  const p = pkgs.get(name);
  if (!p.hasBuild || (wanted && !wanted.has(name))) continue;
  console.log(`\n▸ ${name}  (${p.dir})`);
  execSync(`pnpm --filter ${name} run build`, { stdio: 'inherit' });
}
console.log(`\n✓ built ${order.filter((n) => pkgs.get(n).hasBuild && (!wanted || wanted.has(n))).length} packages in runtime-dependency order`);
