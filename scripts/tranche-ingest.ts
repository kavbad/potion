// Ingest ONLY the selected tranche into the registry seed ($0).
//
// Not the whole catalogue: 349 models would make the registry look broad
// while the measured set stayed at 8, and breadth you cannot route to is the
// claim this product exists to refuse. The tranche is the set we are about to
// MEASURE, so every entry it adds becomes routable.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fetchOpenRouterModels, loadPrices } from '@potion/providers';

const REPO = fileURLToPath(new URL('..', import.meta.url));
for (const line of readFileSync(`${REPO}/.env`, 'utf8').split('\n')) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, '');
}
const wanted = new Set(readFileSync('/tmp/tranche-ids.txt', 'utf8').split('\n').map((s) => s.trim()).filter(Boolean));
const pricesPath = `${REPO}/prices.json`;
const { table } = loadPrices(pricesPath);
const known = new Set(table.entries.map((e) => e.model));
const listings = (await fetchOpenRouterModels({ apiKey: process.env.OPENROUTER_API_KEY! }))
  .filter((l) => wanted.has(l.id) && !known.has(l.id));

const aliasOf = (id: string): string => {
  const base = `or-${(id.split('/')[1] ?? id).replace(/[^a-z0-9.-]+/gi, '-')}`.toLowerCase();
  let alias = base, n = 2;
  const taken = new Set(table.entries.map((e) => e.alias));
  while (taken.has(alias)) alias = `${base}-${n++}`;
  return alias;
};
const added = listings.map((l) => ({
  alias: aliasOf(l.id), provider: 'openrouter' as const, model: l.id,
  inputPer1M: l.promptPerToken! * 1e6, outputPer1M: l.completionPerToken! * 1e6,
}));
const merged = {
  ...table,
  version: `${table.version}+tranche-${new Date().toISOString().slice(0, 10)}`,
  updatedAt: new Date().toISOString().slice(0, 10),
  entries: [...table.entries, ...added],
};
writeFileSync(`${REPO}/.tranche/prices.json`, `${JSON.stringify(merged, null, 2)}\n`);
console.log(`tranche resolved : ${added.length}/${wanted.size} requested`);
console.log(`registry         : ${table.entries.length} -> ${merged.entries.length}`);
console.log(`written          : .tranche/prices.json (NOT the committed seed yet)`);
