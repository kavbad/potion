// R2/R4 — the $0 complementarity query (strategy doc, fact 6). Read-only.
// For one cluster: which items does the champion FAIL, and does any other
// measured model pass them? Champion-fails ∧ someone-passes = mixing
// headroom already paid for; champion-fails ∧ nobody-passes = the
// instrument's own ceiling — new items needed, not new mixtures.
//
//   OBSERVATORY_DB=/research/store npx tsx scripts/r2-headroom-query.ts [cluster] [champion]
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STORE = process.env.OBSERVATORY_DB ?? `${REPO}/.pglite/platform-sweep-step5`;
const CLUSTER = process.argv[2] ?? 'code-gen';
const CHAMPION = process.argv[3] ?? 'or-solar-pro4';

const { createDb } = await import('@potion/db');
// drizzle-orm is not hoisted to the image root; resolve it through @potion/db's copy
const require2 = (await import('node:module')).createRequire(
  (await import('node:url')).pathToFileURL(`${REPO}/node_modules/@potion/db/package.json`).href,
);
const { sql } = require2('drizzle-orm') as typeof import('drizzle-orm');
const handle = await createDb(`pglite://${STORE}`);
const db = handle.db;

// Latest quality per (item, single model), live cells, unstale.
const rows = (
  await db.execute(sql`
    SELECT DISTINCT ON (item_id, strategy_config->>'model')
           item_id, strategy_config->>'model' AS model, quality
      FROM eval_results
     WHERE cluster_id = ${CLUSTER}
       AND provider_mode = 'live'
       AND strategy_config->>'type' = 'single'
       AND stale IS NOT TRUE
     ORDER BY item_id, strategy_config->>'model', created_at DESC
  `)
).rows as Array<{ item_id: string; model: string; quality: number }>;

const byItem = new Map<string, Map<string, number>>();
for (const r of rows) {
  const m = byItem.get(r.item_id) ?? new Map<string, number>();
  m.set(r.model, Number(r.quality));
  byItem.set(r.item_id, m);
}
const items = [...byItem.keys()].sort();
const champScores = items.map((i) => byItem.get(i)!.get(CHAMPION)).filter((q) => q !== undefined) as number[];
console.log(`${CLUSTER}: ${items.length} items with live single-model evidence; champion ${CHAMPION} measured on ${champScores.length}`);
console.log(`champion mean over its items: ${(champScores.reduce((a, b) => a + b, 0) / Math.max(1, champScores.length)).toFixed(4)}`);

let mixHeadroom = 0;
let ceiling = 0;
for (const item of items) {
  const m = byItem.get(item)!;
  const champ = m.get(CHAMPION);
  if (champ === undefined || champ >= 1) continue;
  const passers = [...m.entries()].filter(([model, q]) => model !== CHAMPION && q >= 1).map(([model]) => model);
  if (passers.length > 0) {
    mixHeadroom += 1;
    console.log(`  HEADROOM  ${item}: champion ${champ.toFixed(2)}; passed by ${passers.join(', ')}`);
  } else {
    ceiling += 1;
    const best = [...m.entries()].sort((a, b) => b[1] - a[1])[0]!;
    console.log(`  CEILING   ${item}: champion ${champ.toFixed(2)}; best anyone ${best[0]} ${best[1].toFixed(2)}`);
  }
}
console.log(`\nchampion-fails items: ${mixHeadroom + ceiling} of ${champScores.length}`);
console.log(`  → passed by another model (mixing headroom, already paid for): ${mixHeadroom}`);
console.log(`  → passed by NOBODY (instrument ceiling — needs harder items, not mixtures): ${ceiling}`);
await handle.close?.();
