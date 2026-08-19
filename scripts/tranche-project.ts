// What does measuring the tranche cost? ($0 — zero provider calls)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadPrices } from '@potion/providers';
import { projectRunCostUsd, loadSuiteV2, loadSuiteFile, resolveSuite } from '@potion/harness';
import { PLATFORM_SUITE_BY_CLUSTER } from '@potion/workers';
import type { PriceTable, StrategyConfig } from '@potion/core';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const merged = JSON.parse(readFileSync(`${REPO}/.tranche/prices.json`, 'utf8')) as PriceTable;
const { table: base } = loadPrices(`${REPO}/prices.json`);
const added = merged.entries.filter((e) => !base.entries.some((b) => b.model === e.model));
// Only the NEW models cost money — the 8 already measured cache-hit.
const strategies: StrategyConfig[] = added.map((e) => ({ type: 'single', model: e.alias }));
console.log(`new models to measure : ${strategies.length}`);
let total = 0;
const rows: Array<[string, number, number]> = [];
for (const [clusterId, spec] of Object.entries(PLATFORM_SUITE_BY_CLUSTER)) {
  const items = spec.kind === 'v2' ? loadSuiteV2(spec.suiteId).items : loadSuiteFile(resolveSuite(spec.suiteId).path, spec.suiteId);
  const projected = projectRunCostUsd(strategies, items, merged, 1600, 768);
  rows.push([clusterId, items.length, projected]);
  total += projected;
}
rows.sort((a, b) => b[2] - a[2]);
console.log('\ncluster                items   projected (CEILING)');
for (const [c, n, p] of rows) console.log(`  ${c.padEnd(22)} ${String(n).padStart(3)}   $${p.toFixed(4)}`);
console.log(`\nPROJECTED CEILING: $${total.toFixed(2)}`);
console.log(`Step-5/S6 actual ran 0.04–0.39x of ceiling → expect roughly $${(total*0.05).toFixed(0)}–$${(total*0.25).toFixed(0)} actual.`);
