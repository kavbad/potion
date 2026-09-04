// ATLAS — print today's agenda (F8). What Potion Research should publish
// next, ranked from the measured corpus, with the reasoning shown.
//
//   DATABASE_URL=... npx tsx scripts/research-agenda.ts [--json]
//
// This is the answer to "what should we write?" made inspectable: every
// candidate is a question somebody asks, an empirical claim our numbers
// prove, and a score a human can argue with.
import { createRequire } from 'node:module';
import { generateAgenda, renderAgenda, type ClusterSignal } from '@potion/workers';

const require_ = createRequire(new URL('../packages/db/package.json', import.meta.url));
const pg = require_('pg') as typeof import('pg');

const url = process.env.DATABASE_URL;
if (!url) throw new Error('set DATABASE_URL');
const c = new pg.Client({ connectionString: url, ssl: url.includes('render.com') ? { rejectUnauthorized: false } : undefined });
await c.connect();
const r = await c.query<{ cluster_id: string; points: Array<{ strategyConfig?: { model?: string }; quality: number; costPer1K: number; evidence?: { n?: number } }> }>(
  `select cluster_id, points from frontiers where org_id is null order by cluster_id, version desc`,
);
await c.end();

const seen = new Set<string>();
const signals: ClusterSignal[] = [];
for (const row of r.rows) {
  if (seen.has(row.cluster_id)) continue;
  seen.add(row.cluster_id);
  const points = (row.points ?? [])
    .filter((p) => typeof p.strategyConfig?.model === 'string')
    .map((p) => ({ model: p.strategyConfig!.model!, quality: p.quality, costPer1K: p.costPer1K, n: p.evidence?.n ?? 0 }));
  if (points.length > 0) signals.push({ clusterId: row.cluster_id, points });
}

const agenda = generateAgenda({ signals, now: new Date() });
if (process.argv.includes('--json')) console.log(JSON.stringify(agenda, null, 1));
else console.log(renderAgenda(agenda, 12));
