// $0: where should capability mixing go next? A pick-style mixture is
// bounded by its best member — so it can only win where the champion is
// BELOW ceiling and its failures are covered by another measured model.
// Scan every cluster for exactly that.
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STORE = process.env.OBSERVATORY_DB ?? `${REPO}/.pglite/platform-sweep-step5`;
const { createDb } = await import('@potion/db');
const require2 = (await import('node:module')).createRequire(
  (await import('node:url')).pathToFileURL(`${REPO}/node_modules/@potion/db/package.json`).href,
);
const { sql } = require2('drizzle-orm') as typeof import('drizzle-orm');
const handle = await createDb(`pglite://${STORE}`);

const rows = (
  await handle.db.execute(sql`
    SELECT cluster_id, item_id, strategy_config->>'model' AS model, avg(quality) AS q
      FROM eval_results
     WHERE provider_mode = 'live' AND strategy_config->>'type' = 'single'
       AND instrument = 'default' AND stale IS NOT TRUE
     GROUP BY 1,2,3
  `)
).rows as Array<{ cluster_id: string; item_id: string; model: string; q: number }>;

const byCluster = new Map<string, Map<string, Map<string, number>>>(); // cluster → item → model → q
for (const r of rows) {
  const c = byCluster.get(r.cluster_id) ?? new Map();
  const it = c.get(r.item_id) ?? new Map();
  it.set(r.model, Number(r.q));
  c.set(r.item_id, it);
  byCluster.set(r.cluster_id, c);
}

console.log('cluster              items  champion                 champ Q   fails  covered  CEILING?');
const out: Array<{ cluster: string; champ: string; q: number; fails: number; covered: number; ceiling: boolean }> = [];
for (const [cluster, items] of byCluster) {
  const models = new Map<string, { sum: number; n: number }>();
  for (const [, m] of items) for (const [model, q] of m) {
    const a = models.get(model) ?? { sum: 0, n: 0 };
    a.sum += q; a.n += 1; models.set(model, a);
  }
  // champion = highest mean over items it actually attempted (min 8 items)
  const ranked = [...models.entries()].filter(([, a]) => a.n >= 8).map(([model, a]) => ({ model, q: a.sum / a.n, n: a.n })).sort((x, y) => y.q - x.q);
  const champ = ranked[0];
  if (!champ) continue;
  let fails = 0, covered = 0;
  for (const [, m] of items) {
    const cq = m.get(champ.model);
    if (cq === undefined || cq >= 1) continue;
    fails += 1;
    if ([...m.entries()].some(([model, q]) => model !== champ.model && q >= 1)) covered += 1;
  }
  out.push({ cluster, champ: champ.model, q: champ.q, fails, covered, ceiling: champ.q >= 0.9999 });
  console.log(
    `${cluster.padEnd(20)} ${String(items.size).padStart(5)}  ${champ.model.padEnd(24)} ${champ.q.toFixed(4)}   ${String(fails).padStart(5)}  ${String(covered).padStart(7)}  ${champ.q >= 0.9999 ? 'AT CEILING — no headroom' : ''}`,
  );
}
console.log('\nR4 candidates (champion below ceiling AND failures covered by another model):');
for (const o of out.filter((o) => !o.ceiling && o.covered > 0).sort((a, b) => b.covered - a.covered)) {
  console.log(`  ${o.cluster.padEnd(20)} champion ${o.champ} at ${o.q.toFixed(4)} — ${o.covered} of ${o.fails} failures are covered`);
}
await handle.close?.();
