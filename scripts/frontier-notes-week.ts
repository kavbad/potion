// Frontier Notes — publish (or re-publish) one week's issue from its run
// record. Used standalone for the first issue and for re-runs; the weekly
// Observatory script calls the same step at the end of its run.
//
//   OBSERVATORY_DB=/research/store-copy OBSERVATORY_ARTIFACTS=/research/artifacts \
//   WEEK=2026-W34 npx tsx scripts/frontier-notes-week.ts
//
// Reads: ${ART}/runs/${WEEK}.json and the research store (a COPY when run
// outside the weekly script). Writes: ${ART}/notes/${WEEK}.{json,md}.
// Writer: OPENROUTER_API_KEY + FRONTIER_NOTES_WRITER (default or-sonnet);
// unset the key for the deterministic writer. FRONTIER_NOTES_GATE=1 holds.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, migrate } from '@potion/db';
import { createProviders, loadPrices } from '@potion/providers';
import { runFrontierNotes, type ObservatoryRun } from '@potion/workers';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ART = process.env.OBSERVATORY_ARTIFACTS ?? `${REPO}/artifacts/observatory`;
const DB = process.env.OBSERVATORY_DB;
const WEEK = process.env.WEEK;
if (!DB || !WEEK) throw new Error('set OBSERVATORY_DB (a copy of the research store) and WEEK');
process.env.POTION_PRICES_PATH = process.env.POTION_PRICES_PATH ?? `${REPO}/prices.json`;

const runPath = `${ART}/runs/${WEEK}.json`;
if (!existsSync(runPath)) throw new Error(`no run record at ${runPath}`);
const run = JSON.parse(readFileSync(runPath, 'utf8')) as ObservatoryRun;

const { table: prices } = loadPrices(process.env.POTION_PRICES_PATH!);
const handle = await createDb(`pglite://${DB}`);
await migrate(handle.db);

const key = process.env.OPENROUTER_API_KEY;
const writer = key
  ? { provider: createProviders({ prices, apiKeys: { openrouter: key }, timeoutMs: 120_000 }).openrouter, model: process.env.FRONTIER_NOTES_WRITER ?? 'or-sonnet' }
  : undefined;

const potion = process.env.POTION_SELF_KEY ? { url: process.env.POTION_API_URL ?? 'https://api.withpotion.com', apiKey: process.env.POTION_SELF_KEY, policy: process.env.FRONTIER_NOTES_POLICY ?? 'frontier-notes-writer', cluster: process.env.FRONTIER_NOTES_CLUSTER ?? 'creative' } : undefined;
const { issue, files, digest } = await runFrontierNotes({
  run,
  ...(potion ? { potion } : {}),
  db: handle.db as never,
  pricesVersion: process.env.PRICES_VERSION ?? prices.version,
  notesDir: `${ART}/notes`,
  now: new Date(),
  writer,
  byline: process.env.FRONTIER_NOTES_BYLINE,
  gate: process.env.FRONTIER_NOTES_GATE === '1',
  extraNeverName: (process.env.FRONTIER_NOTES_NEVER_NAME ?? '').split(',').map((s) => s.trim()).filter(Boolean),
});
await handle.close();
console.log(digest);
console.log(`${files.json}\n${files.md}`);
if (issue.status === 'held') process.exitCode = 2;
