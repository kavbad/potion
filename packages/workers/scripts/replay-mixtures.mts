// Mixing program rung 2 — replay every mechanism over the cache, $0.
//   DB_COPY=/path/to/pglite-copy [PRICES_VERSION=...] npx tsx scripts/replay-mixtures.mts
// ALWAYS a COPY of the research store (single-writer PGlite).
import { createDb, migrate } from '@potion/db';
import { replayCluster, replayDigestLine, type ClusterMatrix } from '../src/replay.js';

const PV = process.env.PRICES_VERSION ?? '2026-08-04-or2+tranche-2026-08-19';
const dbPath = process.env.DB_COPY;
if (!dbPath) throw new Error('set DB_COPY to a COPY of the research store');
const handle = await createDb(`pglite://${dbPath}`);
await migrate(handle.db); // the copy is throwaway; bring its schema current
const rows = (await handle.db.execute(`
  select cluster_id, item_id, strategy_config->>'model' as model, quality, confidence,
         coalesce((usage->>'costUsd')::double precision, 0) as cost_usd
  from eval_results
  where prices_version = '${PV.replace(/'/g, "''")}' and strategy_config->>'type' = 'single'
    and provider_mode = 'live' and org_id is null
`)).rows as Array<{ cluster_id: string; item_id: string; model: string; quality: number; confidence: number | null; cost_usd: number }>;
await handle.close();

const byCluster = new Map<string, ClusterMatrix>();
let withConf = 0;
for (const r of rows) {
  const m = byCluster.get(r.cluster_id) ?? new Map();
  byCluster.set(r.cluster_id, m);
  const row = m.get(r.item_id) ?? new Map();
  m.set(r.item_id, row);
  if (r.confidence !== null) withConf++;
  row.set(r.model, { quality: Number(r.quality), costUsd: Number(r.cost_usd), ...(r.confidence !== null ? { confidence: Number(r.confidence) } : {}) });
}
console.log(`cells: ${rows.length} (${withConf} with confidence) across ${byCluster.size} clusters\n`);
for (const [clusterId, matrix] of [...byCluster.entries()].sort()) {
  const r = replayCluster(clusterId, matrix);
  console.log(replayDigestLine(r));
  for (const x of r.recipes.filter((x) => x.kind !== 'oracle').slice(0, 3)) {
    console.log(`    ${x.kind.padEnd(26)} ${x.models.join(' → ').padEnd(60)} q ${x.meanQuality.toFixed(3)} (${x.qualityDeltaVsBestSingle >= 0 ? '+' : ''}${(x.qualityDeltaVsBestSingle * 100).toFixed(1)}pts) ${x.costSavingVsBestSingle >= 0 ? `${(x.costSavingVsBestSingle * 100).toFixed(0)}% cheaper` : `${(-x.costSavingVsBestSingle * 100).toFixed(0)}% pricier`}${x.cheaperAndAsGood ? '  ← CHEAPER & AS GOOD' : x.frontierCandidate ? '  ← frontier candidate (max_quality)' : ''}${x.params?.tau !== undefined ? `  τ=${x.params.tau}` : ''}`);
  }
}
