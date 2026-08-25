// Mixing close, leg 1/2 — cascades (2026-08-25). Pre-registered in
// tasks/todo.md: the run-all cost corollary does not bind cascades (they
// pay the escalation integral), and cascade(mini→sonnet) inherits the
// pair's 1.0000 oracle IF the confidence gate fires on mini's failures.
// This leg measures whether any gate we have can see mini's errors.
// Publishes nothing; member cells ride the A3 cache.
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

const MINI = 'or-gpt-mini';
const SONNET = 'or-sonnet';
const GROK = 'or-grok-4.6';
const casc = (second: string, method: 'logprob' | 'self-report-calibrated', below: number) => ({
  type: 'cascade' as const,
  stages: [{ model: MINI, escalateIf: { confidenceBelow: below } }, { model: second }],
  confidenceMethod: method,
});
const SHAPES = [
  casc(SONNET, 'logprob', 0.9),
  casc(SONNET, 'logprob', 0.75),
  casc(SONNET, 'self-report-calibrated', 0.9),
  casc(GROK, 'logprob', 0.9),
];
const MEMBERS = [MINI, SONNET, GROK];
const NAMES = new Map<string, string>();
for (const m of MEMBERS) NAMES.set(strategyHash({ type: 'single', model: m } as never), m);
NAMES.set(strategyHash(SHAPES[0] as never), 'casc(mini→sonnet, logprob@0.90)   ');
NAMES.set(strategyHash(SHAPES[1] as never), 'casc(mini→sonnet, logprob@0.75)   ');
NAMES.set(strategyHash(SHAPES[2] as never), 'casc(mini→sonnet, self-rep@0.90)  ');
NAMES.set(strategyHash(SHAPES[3] as never), 'casc(mini→grok,   logprob@0.90)   ');

const handle = await createDb(`pglite://${STORE}`);
await migrate(handle.db);
const ctx = { db: handle.db, dbHandle: handle, pricesPath: process.env.POTION_PRICES_PATH! } as never;
mkdirSync(ART, { recursive: true });

const legStart = new Date();
let total = 0;
const readings = new Map<string, Array<{ q: number; n: number; cost?: number; p95?: number }>>();

for (const [i, salt] of (['a3-val-a', 'a3-val-b'] as const).entries()) {
  const label = `t1-cascade-run${i + 1}`;
  console.log(`\n=== ${label} (salt ${salt}) ===`);
  const res = (await frontierPlatformSweepHandler(
    {
      clusterId: 'code-gen',
      auditionModels: MEMBERS,
      maxAnswerers: MEMBERS.length,
      extraShapes: SHAPES as never,
      p95CapMs: 120000,
      capUsd: CAP,
      publish: false,
      cacheSalt: salt,
    } as never,
    ctx,
  )) as Record<string, unknown>;
  for (const r of (res.latencyRefused ?? []) as Array<{ strategyHash: string; projectedP95Ms: number }>) {
    console.log(`  REFUSED pre-spend: ${NAMES.get(r.strategyHash) ?? r.strategyHash.slice(0, 8)} @ ${r.projectedP95Ms}ms`);
  }
  const per = (res.perCandidate ?? []) as Array<{ strategyHash: string; runQuality?: number; runN?: number; costPer1K?: number; latencyP95Ms?: number }>;
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
  if (res.published) throw new Error('INVARIANT: cascade leg published a frontier');
}

console.log('\n──── POOLED (targets: ≥0.9947 & +0.005 over mini <$2/1k = gate works; 1.0000 <$8.05 = domination) ────');
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
for (const [si, h] of shapeHashes.entries()) {
  const misses = rows.filter((r) => r.strategy_hash === h && Number(r.q) < 1).sort((a, b) => a.item_id.localeCompare(b.item_id));
  console.log(`\n${NAMES.get(SHAPES[si] && strategyHash(SHAPES[si] as never))?.trim()}: ${misses.length === 0 ? 'NO MISSES' : misses.map((m) => `${m.item_id} ${Number(m.q).toFixed(2)}`).join(', ')}`);
}
console.log(`\ntotal leg spend $${total.toFixed(4)}`);
await handle.close?.();
