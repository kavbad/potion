// Nightly price-drift watch (agenda item B). $0: one catalog fetch.
//   OBSERVATORY_ARTIFACTS=… npx tsx scripts/price-drift.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchOpenRouterModels } from '@potion/providers';
import { postNoteLine } from '@potion/workers';
// Relative on purpose: the deployed image's dist may predate a new export;
// tsx resolves the source directly and the next image build folds it in.
import { priceDriftReport } from '../packages/workers/src/price-drift.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(`${REPO}/.env`)) {
  for (const line of readFileSync(`${REPO}/.env`, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^"|"$/g, '');
  }
}
const ART = process.env.OBSERVATORY_ARTIFACTS ?? `${REPO}/artifacts/observatory`;
const pricesPath = process.env.POTION_PRICES_PATH ?? `${REPO}/prices.json`;
const roster = JSON.parse(readFileSync(pricesPath, 'utf8'));
const listings = await fetchOpenRouterModels({ apiKey: process.env.OPENROUTER_API_KEY! });
const day = new Date().toISOString().slice(0, 10);
const report = priceDriftReport(roster, listings, Number(process.env.PRICE_DRIFT_THRESHOLD_PCT ?? 10), day);
mkdirSync(`${ART}/price-drift`, { recursive: true });
writeFileSync(`${ART}/price-drift/${day}.md`, report.markdown);
console.log(`price drift ${day}: ${report.checked} checked · ${report.movers.length} mover(s) · ${report.missing.length} missing → ${ART}/price-drift/${day}.md`);
for (const m of report.movers.slice(0, 8)) console.log(`  ${m.alias.padEnd(28)} ${(m.blendedDelta * 100).toFixed(1)}%`);
if (report.missing.length > 0) console.log(`  missing upstream: ${report.missing.join(', ')}`);
if ((report.movers.length > 0 || report.missing.length > 0) && process.env.NOTION_API_KEY && process.env.NOTION_PAGE_ID) {
  const line = `⚠ price drift ${day}: ${report.movers.length} mover(s) ${report.movers.slice(0, 3).map((m) => `${m.alias} ${(m.blendedDelta * 100).toFixed(0)}%`).join(', ')}${report.missing.length > 0 ? ` · missing upstream: ${report.missing.join(', ')}` : ''}`;
  console.log(await postNoteLine({ token: process.env.NOTION_API_KEY, pageId: process.env.NOTION_PAGE_ID }, line));
}
