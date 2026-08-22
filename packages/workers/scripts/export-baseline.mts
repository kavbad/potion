// Observatory support — export the campaign database's platform frontiers to
// packages/db/baseline/platform-frontiers.json, in the exact shape
// importPlatformBaseline consumes (packages/db/src/repos/platform-baseline.ts).
//
// Same verbatim-move discipline as the original 2026-08-18 export: the same
// frontier rows, the same per-point evidence objects, the same live stamps.
// Nothing re-derived. The export REFUSES any frontier holding a non-live
// point, mirroring the importer's refusal, so the committed file can never
// smuggle mock evidence into a deployment.
//
// Usage:
//   DB_COPY=/path/to/pglite-copy npx tsx scripts/export-baseline.mts
//
// ALWAYS a COPY, never the live campaign dir (single-writer; the ~$13 lesson).
import { writeFileSync } from 'node:fs';
import { createDb } from '@potion/db';

const dbPath = process.env.DB_COPY;
if (!dbPath) throw new Error('set DB_COPY to a COPY of the campaign pglite dir');
const outPath = process.env.OUT ?? new URL('../../db/baseline/platform-frontiers.json', import.meta.url).pathname;

const handle = await createDb(`pglite://${dbPath}`);

const frontierRows = (await handle.db.execute(`
  select distinct on (cluster_id)
    id, cluster_id, version, parent_id, trigger, points, org_id, prices_version, created_at
  from frontiers
  where org_id is null
  order by cluster_id, version desc
`)).rows as Array<Record<string, unknown>>;

const entries = [];
for (const f of frontierRows) {
  const pts = (await handle.db.execute(`
    select cluster_id, strategy_hash, strategy_config, quality, cost_per_1k,
           latency_p95, evidence, provider_mode
    from frontier_points
    where frontier_id = '${String(f.id).replace(/'/g, "''")}'
    order by cost_per_1k asc
  `)).rows as Array<Record<string, unknown>>;
  const notLive = pts.filter((p) => p.provider_mode !== 'live');
  if (pts.length === 0 || notLive.length > 0) {
    throw new Error(
      `REFUSING export: ${String(f.cluster_id)} v${String(f.version)} has ` +
      `${pts.length === 0 ? 'no points' : `${notLive.length} non-live point(s)`}`,
    );
  }
  entries.push({
    frontier: {
      id: f.id, cluster_id: f.cluster_id, version: f.version, parent_id: f.parent_id,
      trigger: f.trigger, points: f.points, org_id: f.org_id,
      prices_version: f.prices_version, created_at: f.created_at,
    },
    points: pts,
  });
}
await handle.close();

entries.sort((a, b) => String(a.frontier.cluster_id).localeCompare(String(b.frontier.cluster_id)));
const out = {
  source:
    'Tranche campaign #2 (2026-08-20/21, $51.03 of $60 belt): 8 legs run2 + creative run3 + rewrite-edit run4 — 28 models incl. 20-model tranche, hardened *-hard-v1 suites on code-gen/extraction/classification/code-review.',
  capturedFrom: '.pglite/platform-sweep-step5',
  capturedAt: new Date().toISOString().slice(0, 10),
  providerMode: 'live',
  note:
    'Exported verbatim: same rows, same per-point evidence (cacheKeys, runIds, n, ci95, suite id+version, rubricHash, calibrationId), same live stamps. A MOVE, not a claim. Refuses any non-live point. Supersedes the 2026-08-18 S6 export.',
  frontiers: entries,
};
writeFileSync(outPath, JSON.stringify(out, null, 1) + '\n');
console.log(`wrote ${outPath}: ${entries.length} frontiers`);
for (const e of entries)
  console.log(`  ${String(e.frontier.cluster_id).padEnd(22)} v${e.frontier.version} ${e.points.length} pts ${String(e.frontier.prices_version).slice(0, 40)}`);
