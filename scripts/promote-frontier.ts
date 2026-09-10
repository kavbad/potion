// FRONTIER PROMOTION — research store → production DB, scripted.
//
// The M3 tools leg's close-out (2026-08-23) promoted its frontier "via
// saveFrontier in the server container" — an undocumented manual hop that
// existed only as tribal knowledge. This script IS that hop: export reads a
// frontier (points, evidence, pricesVersion — verbatim) from a source store
// into a JSON file; import saves it into the target DB as the next version
// of the target's own (org NULL, cluster, instrument) chain.
//
//   export: POTION_PROMOTE_DB=pglite:///research/store \
//           npx tsx scripts/promote-frontier.ts export <clusterId> <instrument> <out.json>
//   import: POTION_PROMOTE_DB=$DATABASE_URL \
//           npx tsx scripts/promote-frontier.ts import <file.json>
//
// REFUSALS (fail closed):
//  · export refuses when the source frontier has zero points;
//  · import refuses when ANY point's providerMode is not 'live' — a
//    simulated number never rides a promotion into serving (the provenance
//    guard would block it there anyway; refusing here keeps the chain clean);
//  · import refuses when the file's cluster+instrument already serve a
//    frontier with the SAME point set (idempotence guard — a double-run must
//    not mint a no-op version);
//  · import refuses when the file's pricesVersion differs from the one the
//    target is serving — the cost axis is only comparable within a prices
//    version (POTION_PROMOTE_ACCEPT_PRICES_CHANGE=1 to promote deliberately);
//  · import refuses when the target has a token profile on every point and
//    the file does not — selectPoint enables request-aware costing and the
//    output-budget check only on full coverage, so losing it fails open
//    (POTION_PROMOTE_ACCEPT_PROFILE_LOSS=1 to promote deliberately).
//
// The refusals themselves live in ./promote-frontier-guards.ts so they can be
// tested; this file throws on a missing DB url at import, so nothing inline
// here was ever reachable from a test.
import { readFileSync, writeFileSync } from 'node:fs';
import { promotionRefusal } from './promote-frontier-guards.js';

const [, , cmd, ...args] = process.argv;
const DB_URL = process.env.POTION_PROMOTE_DB ?? process.env.DATABASE_URL;
if (!DB_URL) throw new Error('set POTION_PROMOTE_DB (or DATABASE_URL) to the store to read/write');
if (cmd !== 'export' && cmd !== 'import') {
  throw new Error('usage: promote-frontier.ts export <clusterId> <instrument> <out.json> | import <file.json>');
}

const { createDb } = await import('@potion/db');
const { getLatestFrontier } = await import('@potion/db');
const { saveFrontier } = await import('@potion/pareto');

const handle = await createDb(DB_URL);
try {
  if (cmd === 'export') {
    const [clusterId, instrument, out] = args;
    if (!clusterId || !instrument || !out) throw new Error('export needs <clusterId> <instrument> <out.json>');
    const frontier = await getLatestFrontier(handle.db, clusterId, null, instrument as never);
    if (!frontier) throw new Error(`no (platform, ${clusterId}, ${instrument}) frontier in the source store`);
    if (frontier.points.length === 0) throw new Error(`source frontier ${frontier.id} has zero points — nothing to promote`);
    writeFileSync(out, JSON.stringify({ exportedAt: new Date().toISOString(), sourceId: frontier.id, sourceVersion: frontier.version, clusterId, instrument, trigger: frontier.trigger, pricesVersion: frontier.pricesVersion, points: frontier.points }, null, 1));
    console.log(`exported ${frontier.id} v${frontier.version} (${frontier.points.length} points, prices ${frontier.pricesVersion}) → ${out}`);
  } else {
    const [file] = args;
    if (!file) throw new Error('import needs <file.json>');
    const doc = JSON.parse(readFileSync(file, 'utf8')) as {
      sourceId: string; sourceVersion: number; clusterId: string; instrument: string;
      trigger: string; pricesVersion: string;
      points: { strategyHash: string; providerMode?: string; quality?: number; evidence?: { runIds?: string[] } }[];
    };
    let current;
    try {
      current = await getLatestFrontier(handle.db, doc.clusterId, null, doc.instrument as never);
    } catch (e) {
      if (String(e).includes('does not exist')) {
        throw new Error(
          'REFUSED: the target store has no schema — a promotion target must be an ' +
            'already-migrated live store (the production DB, or a store the server has booted on), ' +
            'never a path this script creates.',
        );
      }
      throw e;
    }
    const refusal = promotionRefusal(current ?? null, doc);
    if (refusal) throw new Error(refusal);

    const saved = await saveFrontier(
      handle.db,
      doc.clusterId,
      doc.points as never,
      'recompute',
      doc.pricesVersion,
      { instrument: doc.instrument as never },
    );
    console.log(
      `promoted ${doc.sourceId} v${doc.sourceVersion} → target ${saved.id} v${saved.version} ` +
        `(${saved.points.length} points, ${doc.clusterId}/${doc.instrument}, prices ${doc.pricesVersion})`,
    );
  }
} finally {
  await handle.close?.();
}
