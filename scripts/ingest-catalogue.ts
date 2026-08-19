// Ingest the OpenRouter catalogue into the model registry ($0).
//
// The registry has carried 8 routable answerers — three vendors' flagships
// plus DeepSeek — while OpenRouter serves ~390 priced models from 57 vendors.
// That is not a measurement gap, it is a VISIBILITY gap: Potion could not
// consider what it had never heard of.
//
// CATALOGUE ≠ FRONTIER, and this changes only the first. Ingesting makes a
// model reachable and inspectable; it does NOT make it routable, because only
// measured points are ever auto-selected. Nothing about serving changes today.
//
// Writes the SEED (prices.json) deliberately, which is different from the
// thing S5 forbade: a scan must not writeFileSync at runtime, because that
// dies on redeploy. A reviewed, committed seed update is how the catalogue
// reaches a fresh database at all.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fetchOpenRouterModels, diffModelListings, loadPrices } from '@potion/providers';
import { buildRegistry, classifyModel } from '@potion/researcher';

const REPO = fileURLToPath(new URL('..', import.meta.url));
for (const line of readFileSync(`${REPO}/.env`, 'utf8').split('\n')) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, '');
}
const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) throw new Error('OPENROUTER_API_KEY absent from .env');

const pricesPath = `${REPO}/prices.json`;
const { table } = loadPrices(pricesPath);
console.log(`registry before : ${table.entries.length} entries`);

const listings = await fetchOpenRouterModels({ apiKey });
console.log(`openrouter says : ${listings.length} models`);

const diff = diffModelListings(listings, table);
console.log(`  new           : ${diff.added.length}`);
console.log(`  already known : ${diff.alreadyKnown.length}`);
console.log(`  no pricing    : ${diff.skippedNoPricing.length} (skipped — an unpriced model cannot be costed)`);

const merged = {
  ...table,
  version: `${table.version}+catalogue-${new Date().toISOString().slice(0, 10)}`,
  updatedAt: new Date().toISOString().slice(0, 10),
  entries: [...table.entries, ...diff.added],
};
writeFileSync(pricesPath, `${JSON.stringify(merged, null, 2)}\n`);
console.log(`registry after  : ${merged.entries.length} entries`);

// What this does to the CANDIDATE POOL a future sweep would draw from.
const reg = buildRegistry(merged).filter((e) => e.provider === 'openrouter');
const byCls: Record<string, typeof reg> = {};
for (const e of reg) (byCls[e.cls] ??= []).push(e);
console.log('\nreachable pool by class (what a live sweep could now consider):');
for (const [cls, list] of Object.entries(byCls)) {
  list.sort((a, b) => a.inputPer1M - b.inputPer1M);
  console.log(`  ${cls.padEnd(7)} ${String(list.length).padStart(3)}   cheapest: ${list[0]!.alias} ($${list[0]!.inputPer1M})`);
}
void classifyModel;
