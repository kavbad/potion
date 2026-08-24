// $0 diagnosis: did or-gpt-full's upstream model version move? If the old
// 0.9945 cells were measured under a different resolved version than
// today's, the staleness engine's modelVersions cause explains the whole
// discrepancy — and self-corrects the frontier without anyone editing data.
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STORE = process.env.OBSERVATORY_DB ?? `${REPO}/.pglite/platform-sweep-step5`;
const ALIAS = process.argv[2] ?? 'or-gpt-full';
const { createDb } = await import('@potion/db');
const require2 = (await import('node:module')).createRequire(
  (await import('node:url')).pathToFileURL(`${REPO}/node_modules/@potion/db/package.json`).href,
);
const { sql } = require2('drizzle-orm') as typeof import('drizzle-orm');
const handle = await createDb(`pglite://${STORE}`);
const rows = (
  await handle.db.execute(sql`
    SELECT model_versions->>${ALIAS} AS version,
           count(*)::int AS cells,
           avg(quality) AS quality,
           min(created_at) AS first_seen,
           max(created_at) AS last_seen,
           bool_or(stale) AS any_stale
      FROM eval_results
     WHERE cluster_id = 'code-gen' AND provider_mode = 'live'
       AND strategy_config->>'type' = 'single'
       AND strategy_config->>'model' = ${ALIAS}
     GROUP BY 1 ORDER BY 4
  `)
).rows as Array<Record<string, unknown>>;
console.log(`${ALIAS} on code-gen — evidence grouped by resolved model version:\n`);
console.log('resolved version                          cells  quality   first seen            last seen             stale?');
for (const r of rows) {
  console.log(
    `${String(r.version ?? '(not recorded)').padEnd(40)} ${String(r.cells).padStart(5)}  ${Number(r.quality).toFixed(4)}   ${String(r.first_seen).slice(0, 19)}   ${String(r.last_seen).slice(0, 19)}   ${r.any_stale}`,
  );
}
await handle.close?.();
