// Mixing close, leg 2/2 — verify-pick on extraction (2026-08-25). THE LAST
// MIXTURE LEG (operator direction). The field-writer derives required
// fields from the request; the deterministic coverage check catches the
// omission class reference-free judges are measured blind to (G8).
// Publishes nothing.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(`${REPO}/.env`)) {
  const fs = await import('node:fs');
  for (const line of fs.readFileSync(`${REPO}/.env`, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^"|"$/g, '');
  }
}
if (!process.env.KEY_RISK_ACCEPTED) throw new Error('live spend: set KEY_RISK_ACCEPTED=<date> (ledger row first)');
process.env.POTION_EVAL_PROVIDER = 'live';
process.env.POTION_PROVIDER_TIMEOUT_MS = process.env.POTION_PROVIDER_TIMEOUT_MS ?? '180000';
const STORE = process.env.OBSERVATORY_DB ?? `${REPO}/.pglite/platform-sweep-step5`;
const ART = process.env.OBSERVATORY_ARTIFACTS ?? `${REPO}/artifacts/observatory`;
process.env.POTION_PRICES_PATH = process.env.POTION_PRICES_PATH ?? `${REPO}/prices.json`;
const CAP = Number(process.env.LEG_CAP_USD ?? 15);

const { createDb, migrate } = await import('@potion/db');
const { frontierPlatformSweepHandler } = await import('@potion/workers');
const { strategyHash } = await import('@potion/core');
const require2 = createRequire(pathToFileURL(`${REPO}/node_modules/@potion/db/package.json`).href);
const { sql } = require2('drizzle-orm') as typeof import('drizzle-orm');

const SOLAR = 'or-solar-pro4';
const FLASH = 'or-gemini-flash';
const MINI = 'or-gpt-mini';
const F37 = 'or-gemini-3.7-flash';
const JUDGE = { model: 'or-gpt-full' };
const SHAPES = [
  { type: 'ensemble' as const, models: [SOLAR, FLASH], fusion: { method: 'verify-pick' as const, testWriters: [{ model: F37 }, { model: MINI }], judge: JUDGE } },
  { type: 'ensemble' as const, models: [SOLAR, MINI], fusion: { method: 'verify-pick' as const, testWriters: [{ model: F37 }, { model: FLASH }], judge: JUDGE } },
  { type: 'ensemble' as const, models: [SOLAR, FLASH], fusion: { method: 'verify-pick' as const, testWriter: { model: F37 }, judge: JUDGE } },
];
const MEMBERS = [SOLAR, FLASH, MINI];
const NAMES = new Map<string, string>();
for (const m of MEMBERS) NAMES.set(strategyHash({ type: 'single', model: m } as never), m);
NAMES.set(strategyHash(SHAPES[0] as never), 'A vp2(solar|flash, w:3.7f+mini)  ');
NAMES.set(strategyHash(SHAPES[1] as never), 'B vp2(solar|mini,  w:3.7f+flash) ');
NAMES.set(strategyHash(SHAPES[2] as never), 'C vp1(solar|flash, w:3.7f)       ');

const handle = await createDb(`pglite://${STORE}`);
await migrate(handle.db);
const ctx = { db: handle.db, dbHandle: handle, pricesPath: process.env.POTION_PRICES_PATH! } as never;
mkdirSync(ART, { recursive: true });

const legStart = new Date();
let total = 0;
const readings = new Map<string, Array<{ q: number; n: number; cost?: number; p95?: number }>>();

for (const [i, salt] of (['vp-a', 'vp-b'] as const).entries()) {
  const label = `t1-verifypick-run${i + 1}`;
  console.log(`\n=== ${label} (salt ${salt}) ===`);
  const res = await frontierPlatformSweepHandler(
    {
      clusterId: 'extraction',
      auditionModels: MEMBERS,
      maxAnswerers: MEMBERS.length,
      extraShapes: SHAPES as never,
      p95CapMs: 120000,
      capUsd: CAP,
      publish: false,
      cacheSalt: salt,
    },
    ctx,
  );
  for (const r of res.latencyRefused) {
    console.log(`  REFUSED pre-spend: ${NAMES.get(r.strategyHash) ?? r.strategyHash.slice(0, 8)} @ ${r.projectedP95Ms}ms`);
  }
  const per = res.perCandidate;
  for (const p of per) {
    const name = NAMES.get(p.strategyHash);
    if (!name || p.runQuality === undefined) continue;
    readings.set(name, [...(readings.get(name) ?? []), { q: p.runQuality, n: p.runN ?? -1, ...(p.costPer1K !== undefined ? { cost: p.costPer1K } : {}), ...(p.latencyP95Ms !== undefined ? { p95: p.latencyP95Ms } : {}) }]);
    console.log(`  ${name.padEnd(36)} ${p.runQuality.toFixed(4)}  n=${p.runN}  $${(p.costPer1K ?? 0).toFixed(4)}/1k  ${Math.round(p.latencyP95Ms ?? 0)}ms`);
  }
  const spend = Number(res.spendUsd ?? 0);
  total += spend;
  console.log(`  spend $${spend.toFixed(4)}`);
  appendFileSync(`${ART}/ledger.jsonl`, `${JSON.stringify({ at: new Date().toISOString(), week: 'track1', lane: label, spendUsd: spend })}\n`);
  writeFileSync(`${ART}/${label}.json`, JSON.stringify(res, null, 1));
  if (res.published) throw new Error('INVARIANT: verify-pick leg published a frontier');
}

console.log('\n──── POOLED (target: beat best member BOTH runs at <2x its cost, else the closing negative) ────');
for (const [name, rs] of [...readings.entries()].sort()) {
  const mean = rs.reduce((s, r) => s + r.q, 0) / rs.length;
  const spread = Math.max(...rs.map((r) => r.q)) - Math.min(...rs.map((r) => r.q));
  const cost = rs.find((r) => r.cost !== undefined)?.cost;
  const p95 = rs.find((r) => r.p95 !== undefined)?.p95;
  console.log(`  ${name.padEnd(36)} pooled ${mean.toFixed(4)}  spread ${spread.toFixed(4)}  $${(cost ?? 0).toFixed(4)}/1k  ${Math.round(p95 ?? 0)}ms`);
}

// Item-level: exactly which items each shape missed, from this leg's fresh cells.
const shapeHashes = SHAPES.map((s) => strategyHash(s as never));
const rows = (
  await handle.db.execute(sql`
    SELECT item_id, strategy_hash, AVG(quality)::float q
      FROM eval_results
     WHERE cluster_id='code-gen' AND provider_mode='live'
       AND created_at >= ${legStart.toISOString()}
     GROUP BY item_id, strategy_hash
  `)
).rows as Array<{ item_id: string; strategy_hash: string; q: number }>;
for (const h of shapeHashes) {
  const misses = rows.filter((r) => r.strategy_hash === h && Number(r.q) < 1).sort((a, b) => a.item_id.localeCompare(b.item_id));
  console.log(`\n${NAMES.get(h)?.trim()}: ${misses.length === 0 ? 'NO MISSES' : misses.map((m) => `${m.item_id} ${Number(m.q).toFixed(2)}`).join(', ')}`);
}
console.log(`\ntotal leg spend $${total.toFixed(4)}`);
await handle.close?.();
