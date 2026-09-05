// Instrument campaign — rewrite-edit-hard-v1 validation leg (2026-08-26).
// Pre-registered (tasks/todo.md): the 14-item constraint-preservation tier
// joins the 14 ported flat items; judge-scored (judge-class), rubrics
// rubric-anchored. Success = discriminates; nobody-passes items are checked
// against the wider pool before any defect verdict (the exh2-m07 lesson).
// Adapted from scripts/extraction-v2-leg.ts — same machinery, new params.
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
const CAP = Number(process.env.LEG_CAP_USD ?? 6);

const { createDb, migrate } = await import('@potion/db');
const { frontierPlatformSweepHandler } = await import('@potion/workers');
const { strategyHash } = await import('@potion/core');
const require2 = createRequire(pathToFileURL(`${REPO}/node_modules/@potion/db/package.json`).href);
const { sql } = require2('drizzle-orm') as typeof import('drizzle-orm');

// Env knobs (2026-08-26): run 2 fits inside the platform-ops monthly belt
// by dropping one answerer — LEG_MODELS + LEG_SALTS scope a partial rerun.
const MODELS = (process.env.LEG_MODELS?.split(',') ?? ['or-solar-pro4', 'or-gpt-full', 'or-gemini-flash', 'or-gpt-mini', 'or-sonnet']);
const NAME_BY_HASH = new Map<string, string>();
for (const m of MODELS) NAME_BY_HASH.set(strategyHash({ type: 'single', model: m } as never), m);
const CLUSTERS = ['rewrite-edit'];
const legStart = new Date();

const handle = await createDb(`pglite://${STORE}`);
await migrate(handle.db);
const ctx = { db: handle.db, dbHandle: handle, pricesPath: process.env.POTION_PRICES_PATH! } as never;

mkdirSync(ART, { recursive: true });
let total = 0;
// cluster → model → readings
const pooled = new Map<string, Map<string, Array<{ q: number; n: number }>>>();

for (const clusterId of CLUSTERS) {
  pooled.set(clusterId, new Map());
  for (const salt of process.env.LEG_SALTS?.split(',') ?? ['rwv1-a', 'rwv1-b']) {
    const label = `rwv1-${clusterId}-${salt}`;
    console.log(`\n=== ${label} (salt ${salt}) ===`);
    const res = await frontierPlatformSweepHandler(
      { clusterId, auditionModels: MODELS, maxAnswerers: MODELS.length, capUsd: CAP, publish: false, cacheSalt: salt },
      ctx,
    );
    const per = res.perCandidate;
    for (const p of per) {
      const model = NAME_BY_HASH.get(p.strategyHash);
      if (!model || p.runQuality === undefined) continue;
      const m = pooled.get(clusterId)!;
      m.set(model, [...(m.get(model) ?? []), { q: p.runQuality, n: p.runN ?? -1 }]);
      console.log(`  ${model.padEnd(20)} ${p.runQuality.toFixed(4)}  n=${p.runN}  $${(p.costPer1K ?? 0).toFixed(4)}/1k  ${Math.round(p.latencyP95Ms ?? 0)}ms`);
    }
    const spend = Number(res.spendUsd ?? 0);
    total += spend;
    console.log(`  spend $${spend.toFixed(4)}`);
    appendFileSync(`${ART}/ledger.jsonl`, `${JSON.stringify({ at: new Date().toISOString(), week: 'instrument-campaign', lane: label, spendUsd: spend })}\n`);
    writeFileSync(`${ART}/${label}.json`, JSON.stringify(res, null, 1));
    if (res.published) throw new Error(`INVARIANT: validation leg published a frontier on ${clusterId}`);
  }
}

console.log('\n──── POOLED (two salted runs, like-for-like runQuality) ────');
for (const clusterId of CLUSTERS) {
  console.log(`\n${clusterId}:`);
  const rows = [...pooled.get(clusterId)!.entries()]
    .map(([model, rs]) => ({ model, mean: rs.reduce((s, r) => s + r.q, 0) / rs.length, spread: Math.max(...rs.map((r) => r.q)) - Math.min(...rs.map((r) => r.q)), runs: rs.length }))
    .sort((a, b) => b.mean - a.mean);
  for (const r of rows) console.log(`  ${r.model.padEnd(20)} pooled ${r.mean.toFixed(4)}  spread ${r.spread.toFixed(4)}  (${r.runs} runs)`);
  const top = rows[0];
  const top3spread = rows.length >= 3 ? rows[0]!.mean - rows[2]!.mean : Number.NaN;
  console.log(top && top.mean < 0.99
    ? `  VERDICT: discriminates — top ${top.model} at ${top.mean.toFixed(4)} (< 0.99); top-3 spread ${top3spread.toFixed(4)}`
    : `  VERDICT: STILL SATURATED at the top (${top?.model} ${top?.mean.toFixed(4)}) — published as a negative`);
}

// Per-item map over ONLY this leg's fresh cells: nobody-passes = authoring
// defect; everybody-passes on the frontier tier = the tier missed.
for (const clusterId of CLUSTERS) {
  const rows = (
    await handle.db.execute(sql`
      SELECT item_id, strategy_config->>'model' AS model, AVG(quality)::float AS q
        FROM eval_results
       WHERE cluster_id = ${clusterId}
         AND provider_mode = 'live'
         AND strategy_config->>'type' = 'single'
         AND created_at >= ${legStart.toISOString()}
       GROUP BY item_id, strategy_config->>'model'
    `)
  ).rows as Array<{ item_id: string; model: string; q: number }>;
  const byItem = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (!MODELS.includes(r.model)) continue;
    const m = byItem.get(r.item_id) ?? new Map<string, number>();
    m.set(r.model, Number(r.q));
    byItem.set(r.item_id, m);
  }
  const items = [...byItem.keys()].sort();
  let allPass = 0;
  const nobody: string[] = [];
  const splits: string[] = [];
  for (const item of items) {
    const qs = [...byItem.get(item)!.values()];
    if (qs.every((q) => q >= 1)) allPass += 1;
    else if (qs.every((q) => q < 1)) nobody.push(item);
    else splits.push(item);
  }
  console.log(`\n${clusterId} item map (${items.length} items, this leg's cells only):`);
  console.log(`  all five pass: ${allPass} · split (the discrimination): ${splits.length} · NOBODY passes: ${nobody.length}${nobody.length ? ` — ${nobody.join(', ')}` : ''}`);
  if (splits.length > 0) console.log(`  splitting items: ${splits.join(', ')}`);
}

console.log(`\ntotal leg spend $${total.toFixed(4)}`);
await handle.close?.();
