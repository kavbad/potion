// S6 LEG 0 — what does widening actually cost? ($0, no provider calls)
//
// The discipline every live campaign in this repo has followed: know the
// number before spending it. Step 5's projections ran 3–7x above actuals, so
// this is a CEILING, not a forecast — which is the right direction for a
// number an operator approves a budget against.
//
// Calls nothing. Loads the live registry, builds the exact candidate set the
// platform sweep would build, loads each cluster's committed suite, and runs
// the same projectRunCostUsd the preflight uses to refuse.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildRegistry, classMembers } from '@potion/researcher';
import { loadPrices, ENV_VAR_BY_PROVIDER } from '@potion/providers';
import { projectRunCostUsd } from '@potion/harness';
import { strategyHash, type ProviderId, type StrategyConfig } from '@potion/core';
import {
  PLATFORM_SUITE_BY_CLUSTER,
  PLATFORM_SWEEP_CASCADE_CONFIDENCE_BELOW,
  PLATFORM_SWEEP_MAX_ANSWERERS,
} from '@potion/workers';
import { loadSuiteV2, loadSuiteFile, resolveSuite } from '@potion/harness';

const REPO = fileURLToPath(new URL('..', import.meta.url));
for (const line of readFileSync(`${REPO}/.env`, 'utf8').split('\n')) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, '');
}
for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY']) delete process.env[k];

const { table: prices } = loadPrices(`${REPO}/prices.json`);
const reachable = (p: string): boolean =>
  p !== 'mock' && process.env[ENV_VAR_BY_PROVIDER[p as Exclude<ProviderId, 'mock'>]] !== undefined;
const registry = buildRegistry(prices).filter((e) => reachable(e.provider));

const answerPool = [
  ...classMembers(registry, 'cheap'),
  ...classMembers(registry, 'mid'),
  ...classMembers(registry, 'strong'),
];
const answerers = answerPool.slice(0, PLATFORM_SWEEP_MAX_ANSWERERS);
const cheap = classMembers(registry, 'cheap')[0]!;
const strong = classMembers(registry, 'strong')[0]!;

const singles: StrategyConfig[] = answerers.map((e) => ({ type: 'single', model: e.alias }));
const cascade: StrategyConfig = {
  type: 'cascade',
  stages: [
    { model: cheap.alias, escalateIf: { confidenceBelow: PLATFORM_SWEEP_CASCADE_CONFIDENCE_BELOW } },
    { model: strong.alias },
  ],
  confidenceMethod: 'self-report-calibrated',
};
const byHash = new Map<string, StrategyConfig>();
for (const cfg of [...singles, cascade]) byHash.set(strategyHash(cfg), cfg);
const strategies = [...byHash.values()];

console.log('── S6 leg 0: projection only, ZERO provider calls ──────────────');
console.log(`reachable answerers : ${answerers.length}  (${answerers.map((e) => e.alias).join(', ')})`);
console.log(`dropped by ceiling  : ${answerPool.length - answerers.length}`);
console.log(`strategies per leg  : ${strategies.length} (${singles.length} singles + 1 cascade)`);
console.log(`  BEFORE S6         : 4 (3 singles + 1 cascade)\n`);

let total = 0;
const rows: Array<[string, number, number]> = [];
for (const [clusterId, spec] of Object.entries(PLATFORM_SUITE_BY_CLUSTER)) {
  const items =
    spec.kind === 'v2'
      ? loadSuiteV2(spec.suiteId).items
      : loadSuiteFile(resolveSuite(spec.suiteId).path, spec.suiteId);
  const projected = projectRunCostUsd(strategies, items, prices, 1600, 768);
  rows.push([clusterId, items.length, projected]);
  total += projected;
}
rows.sort((a, b) => b[2] - a[2]);
console.log('cluster                items   projected (CEILING)');
for (const [c, n, p] of rows) {
  console.log(`  ${c.padEnd(22)} ${String(n).padStart(3)}   $${p.toFixed(4)}`);
}
console.log(`\nPROJECTED TOTAL (ceiling): $${total.toFixed(4)}`);
console.log(`Step 5 actual/projected ratio was ~0.15–0.25, so expect roughly ` +
  `$${(total * 0.15).toFixed(2)}–$${(total * 0.25).toFixed(2)} actual.`);
