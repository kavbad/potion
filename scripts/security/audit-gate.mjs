#!/usr/bin/env node
// CI dependency-audit gate (ROADMAP §19, M2-security).
//
// Approach (justification): a ~60-line script over `pnpm audit --prod --json`
// instead of adding audit-ci/better-npm-audit as a dependency — zero new
// packages, transparent filtering, and the allowlist is a plain JSON file with
// per-entry reasons. Fails (exit 1) on any PRODUCTION advisory at or above
// --audit-level (default: high) that is not explicitly allowlisted.
//
// Usage: node scripts/security/audit-gate.mjs [--audit-level=high|critical|moderate|low]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const LEVELS = ['low', 'moderate', 'high', 'critical'];
const levelArg = process.argv.find((a) => a.startsWith('--audit-level='));
const minLevel = levelArg ? levelArg.split('=')[1] : 'high';
if (!LEVELS.includes(minLevel)) {
  console.error(`audit-gate: invalid --audit-level '${minLevel}'`);
  process.exit(2);
}
const minIdx = LEVELS.indexOf(minLevel);

const root = fileURLToPath(new URL('../../', import.meta.url));
const allowlistPath = new URL('./audit-allowlist.json', import.meta.url);
const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8')).allowlist ?? [];
const allowed = new Map(allowlist.map((e) => [`${e.module}:${e.id}`, e]));

const registryArg = process.argv.find((a) => a.startsWith('--registry='));
const auditArgs = ['audit', '--prod', '--json'];
if (registryArg) auditArgs.push(registryArg); // e.g. when the default mirror lacks an audit endpoint

let json;
try {
  // pnpm audit exits non-zero when vulnerabilities exist — capture stdout either way.
  json = execFileSync('pnpm', auditArgs, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (err) {
  if (err.stdout) json = err.stdout;
  else {
    console.error(`audit-gate: pnpm audit failed: ${err.message}`);
    process.exit(2);
  }
}

let report;
try {
  report = JSON.parse(json);
} catch {
  console.error(`audit-gate: could not parse pnpm audit output (registry without audit endpoint?): ${json.slice(0, 200)}`);
  process.exit(2);
}
// Fail CLOSED: an audit that could not run is not a pass.
if (report.error) {
  console.error(`audit-gate: pnpm audit error ${report.error.code ?? ''}: ${report.error.message ?? 'unknown'}`);
  process.exit(2);
}
const advisories = Object.values(report.advisories ?? {});
const blocking = [];
const accepted = [];
for (const a of advisories) {
  const sevIdx = LEVELS.indexOf(a.severity);
  if (sevIdx < minIdx) continue; // below the gate level
  const key = `${a.module_name}:${a.id}`;
  const entry = allowed.get(key);
  if (entry) accepted.push(`ACCEPTED ${a.severity.padEnd(8)} ${a.module_name}@${a.id} — ${entry.reason}`);
  else blocking.push(`BLOCKED  ${a.severity.padEnd(8)} ${a.module_name} (advisory ${a.id}) ${a.url ?? ''} patched: ${a.patched_versions ?? 'none'}`);
}

console.log(`audit-gate: ${advisories.length} production advisories, level >= ${minLevel}: ${accepted.length} accepted, ${blocking.length} blocking`);
for (const line of accepted) console.log(`  ${line}`);
if (blocking.length > 0) {
  for (const line of blocking) console.error(`  ${line}`);
  console.error('audit-gate: FAIL — fix via patch bump or add a justified entry to scripts/security/audit-allowlist.json');
  process.exit(1);
}
console.log('audit-gate: PASS');
