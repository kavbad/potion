// Step 8 lab-walkthrough ARRANGEMENT (not the novice's path): build the
// persisted PGlite dir the walkthrough's api server boots against, carrying
// what a real deployment has before any user arrives — the taxonomy cluster
// row and a LIVE-evidenced platform frontier for it (Step 5's product;
// without live evidence the generator honestly drafts frontier-not-live).
//
// Imports built dists by relative path (the generate-golden.mjs pattern) so
// the dashboard package keeps zero workspace dependencies.
//
// Usage: node scripts/lab-walk-arrange.mjs <pglite-dir>
import { createDb, migrate, clusters } from '../packages/db/dist/index.js';
import { saveFrontier } from '../packages/pareto/dist/index.js';
import { strategyHash } from '../packages/core/dist/index.js';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/lab-walk-arrange.mjs <pglite-dir>');
  process.exit(2);
}

const h = await createDb(`pglite://${dir}`);
await migrate(h.db);
await h.db
  .insert(clusters)
  .values({ id: 'summarization', name: 'summarization', description: 'taxonomy cluster' })
  .onConflictDoNothing();
const config = { type: 'single', model: 'mock-cheap' };
await saveFrontier(
  h.db,
  'summarization',
  [
    {
      clusterId: 'summarization',
      strategyHash: strategyHash(config),
      strategyConfig: config,
      quality: 0.85,
      costPer1K: 0.012,
      latencyP95: 700,
      providerMode: 'live',
      evidence: { cacheKeys: ['ck-lab-walk'], runIds: ['run-lab-walk'], n: 14, qualityCi95: 0.02 },
    },
  ],
  'recompute',
  'pv-lab-walk',
);
await h.close();
console.log(`arranged: ${dir}`);
