// $0 partner selection: per-model quality / cost-per-1k / p95 on a cluster,
// from live single-model cells already paid for. Read-only.
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STORE = process.env.OBSERVATORY_DB ?? `${REPO}/.pglite/platform-sweep-step5`;
const CLUSTER = process.argv[2] ?? 'code-gen';
const ONLY = (process.argv[3] ?? '').split(',').filter(Boolean);
const { createDb } = await import('@potion/db');
const require2 = (await import('node:module')).createRequire(
  (await import('node:url')).pathToFileURL(`${REPO}/node_modules/@potion/db/package.json`).href,
);
const { sql } = require2('drizzle-orm') as typeof import('drizzle-orm');
const handle = await createDb(`pglite://${STORE}`);
const rows = (
  await handle.db.execute(sql`
    SELECT strategy_config->>'model' AS model,
           count(*)::int AS n,
           avg(quality) AS quality,
           avg((usage->>'costUsd')::double precision) * 1000 AS cost_per_1k,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY (latency_ms->>'p95')::double precision) AS p95
      FROM eval_results
     WHERE cluster_id = ${CLUSTER} AND provider_mode = 'live'
       AND strategy_config->>'type' = 'single' AND stale IS NOT TRUE
     GROUP BY 1 ORDER BY 3 DESC
  `)
).rows as Array<{ model: string; n: number; quality: number; cost_per_1k: number; p95: number }>;
console.log('model                          n   quality    $per1k     p95ms');
for (const r of rows) {
  if (ONLY.length && !ONLY.includes(r.model)) continue;
  console.log(`${r.model.padEnd(28)} ${String(r.n).padStart(3)}   ${Number(r.quality).toFixed(4)}  ${('$' + Number(r.cost_per_1k).toFixed(4)).padStart(9)}  ${String(Math.round(Number(r.p95))).padStart(7)}`);
}
await handle.close?.();
