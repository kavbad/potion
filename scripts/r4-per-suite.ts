// $0: is a cluster-wide "quality" actually a SUITE MIX? Group live single
// cells by item-id prefix (each suite has its own) per model.
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
    SELECT strategy_config->>'model' AS model,
           split_part(item_id, '-', 1) AS suite,
           count(*)::int AS cells,
           avg(quality) AS quality
      FROM eval_results
     WHERE cluster_id = 'code-gen' AND provider_mode = 'live'
       AND strategy_config->>'type' = 'single' AND stale IS NOT TRUE
       AND strategy_config->>'model' IN ('or-gpt-full','or-grok-4.6','or-gpt-mini','or-gemini-flash')
     GROUP BY 1,2 ORDER BY 1,2
  `)
).rows as Array<Record<string, unknown>>;
console.log('model            suite-prefix  cells  quality');
for (const r of rows) {
  console.log(`${String(r.model).padEnd(16)} ${String(r.suite).padEnd(12)} ${String(r.cells).padStart(5)}  ${Number(r.quality).toFixed(4)}`);
}
await handle.close?.();
