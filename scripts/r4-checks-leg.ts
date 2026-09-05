// exec-pick promotion checks a+b (2026-08-24): the CI-tightening evidence.
//  A. STABILITY — the winning config re-measured on code-gen-hard-v1 with a
//     fresh cache salt: a second fully independent reading.
//  B. GENERALIZATION — same config on code-gen-humaneval-js-v1 (a different
//     instrument of the same skill): does the edge survive an item
//     distribution nobody tuned on?
// Sequential (the PGlite store is single-writer). Canary: publish OFF.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(`${REPO}/.env`)) {
  const fs = await import('node:fs');
  for (const line of fs.readFileSync(`${REPO}/.env`, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^"|"$/g, '');
  }
}
if (!process.env.KEY_RISK_ACCEPTED) throw new Error('live spend: set KEY_RISK_ACCEPTED=<date> (ledger row first)');
const STORE = process.env.OBSERVATORY_DB ?? `${REPO}/.pglite/platform-sweep-step5`;
const ART = process.env.OBSERVATORY_ARTIFACTS ?? `${REPO}/artifacts/observatory`;
process.env.POTION_PRICES_PATH = process.env.POTION_PRICES_PATH ?? `${REPO}/prices.json`;
const CAP = Number(process.env.R4_CAP_USD ?? 3);

const { createDb, migrate } = await import('@potion/db');
const { frontierPlatformSweepHandler } = await import('@potion/workers');
const { strategyHash } = await import('@potion/core');

const WINNER = {
  type: 'ensemble' as const,
  models: ['or-solar-pro4', 'or-gemini-flash'],
  fusion: { method: 'exec-pick' as const, testWriter: { model: 'or-gpt-mini' }, judge: { model: 'or-gpt-mini' } },
};
const MEMBERS = ['or-solar-pro4', 'or-gemini-flash', 'or-gpt-mini'];
const NAMES = new Map<string, string>();
for (const m of MEMBERS) NAMES.set(strategyHash({ type: 'single', model: m } as never), m);
NAMES.set(strategyHash(WINNER as never), 'exec-pick(solar|gemini-flash, w:gpt-mini)');

const handle = await createDb(`pglite://${STORE}`);
await migrate(handle.db);
const ctx = { db: handle.db, dbHandle: handle, pricesPath: process.env.POTION_PRICES_PATH! } as never;

async function leg(label: string, extra: Record<string, unknown>) {
  console.log(`\n=== ${label} ===`);
  const res = await frontierPlatformSweepHandler(
    {
      clusterId: 'code-gen',
      auditionModels: MEMBERS,
      maxAnswerers: MEMBERS.length,
      extraShapes: [WINNER] as never,
      capUsd: CAP,
      publish: false,
      ...extra,
    },
    ctx,
  );
  const sampled = res.sampled ?? [];
  const perCandidate = res.perCandidate;
  const q = new Map(sampled.map((s) => [s.strategyHash, { q: s.meanQuality, n: s.n }]));
  for (const p of perCandidate) if (p.runQuality !== undefined && !q.has(p.strategyHash)) q.set(p.strategyHash, { q: p.runQuality, n: p.runN ?? -1 });
  for (const [h, v] of [...q.entries()].sort((a, b) => b[1].q - a[1].q)) {
    console.log(`  ${(NAMES.get(h) ?? h.slice(0, 10)).padEnd(46)} ${v.q.toFixed(4)}  (n=${v.n})`);
  }
  const spend = Number(res.spendUsd ?? 0);
  console.log(`  spend $${spend.toFixed(4)}`);
  appendFileSync(`${ART}/ledger.jsonl`, `${JSON.stringify({ at: new Date().toISOString(), week: 'r4', lane: label, spendUsd: spend })}\n`);
  writeFileSync(`${ART}/${label}-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(res, null, 1));
  return spend;
}

mkdirSync(ART, { recursive: true });
const a = await leg('r4-check-stability', { cacheSalt: 'r4-stability-1' });
const b = await leg('r4-check-humaneval', { suiteOverride: { kind: 'v2', suiteId: 'code-gen-humaneval-js-v1' } });
console.log(`\ntotal $${(a + b).toFixed(4)}`);
await handle.close?.();
