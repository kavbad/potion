// The coverage ratchet report (Observatory rung 5). Pure logic lives in
// @potion/workers observatory-ratchet.ts; this writes the monthly artifact.
//
//   npx tsx scripts/observatory-ratchet.ts
//   OBSERVATORY_ARTIFACTS=… POTION_PRICES_PATH=… RATCHET_NOW=… npx tsx scripts/observatory-ratchet.ts
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { measuredRoster, ratchetReport, type RatchetLedgerRow, type RatchetRun } from '@potion/workers';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function writeRatchet(art: string, pricesPath: string, now: Date): string {
  const runsDir = join(art, 'runs');
  const runs: RatchetRun[] = existsSync(runsDir)
    ? readdirSync(runsDir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(runsDir, f), 'utf8')) as RatchetRun)
    : [];
  const ledgerPath = join(art, 'ledger.jsonl');
  const ledger: RatchetLedgerRow[] = existsSync(ledgerPath)
    ? readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as RatchetLedgerRow)
    : [];
  const report = ratchetReport(runs, ledger, measuredRoster(pricesPath), now);
  mkdirSync(art, { recursive: true });
  const out = join(art, `ratchet-${now.toISOString().slice(0, 7)}.md`);
  writeFileSync(out, report);
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const art = process.env.OBSERVATORY_ARTIFACTS ?? `${REPO}/artifacts/observatory`;
  const prices = process.env.POTION_PRICES_PATH ?? `${REPO}/prices.json`;
  const now = process.env.RATCHET_NOW ? new Date(process.env.RATCHET_NOW) : new Date();
  const out = writeRatchet(art, prices, now);
  console.log(`ratchet: ${out}`);
  console.log(readFileSync(out, 'utf8').split('\n').slice(6, 12).join('\n'));
}
