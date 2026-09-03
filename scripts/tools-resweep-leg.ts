// TOOLS-INSTRUMENT RE-SWEEP (2026-09-01, the or-gemini-flash incident).
// fr-50398da4 (agentic-tool-use, instrument=tools, v1) still carries
// or-gemini-flash at q=1.0 n=24 while production served zero-token bursts;
// the serving degeneracy guard excludes it at serve time. The durable fix is
// a fresh LIVE measurement on the 1.1.0 suite (whose multi-turn items can
// SEE the empty-stop-after-tool-result failure), minted as a new frontier
// version. publish is OFF unless RESWEEP_PUBLISH=1: read the numbers first.
//
//   OBSERVATORY_DB=/research/store OBSERVATORY_ARTIFACTS=/research/artifacts \
//   POTION_EVAL_PROVIDER=live KEY_RISK_ACCEPTED=<date> \
//   [RESWEEP_CAP_USD=10] [RESWEEP_RETIRE=1] [RESWEEP_PUBLISH=1] \
//   npx tsx scripts/tools-resweep-leg.ts
//
// TWO RULES THIS LEG ENFORCES THAT m3-tools-leg DID NOT NEED:
//  1. FRESH CELLS ONLY. aggregatesFromEvalResults has no run/salt filter —
//     non-stale live tools cells from the August leg would AVERAGE into the
//     new frontier point at the same (cluster, hash, pricesVersion)
//     coordinates, diluting the re-measurement with exactly the evidence the
//     incident contradicted. The leg refuses while such cells exist;
//     RESWEEP_RETIRE=1 marks them stale first (cause printed + ledgered).
//  2. INCUMBENTS ARE RE-MEASURED, NOT CARRIED. Both v1 points ride
//     auditionModels explicitly, and the fresh cache salt forces every cell
//     to execute live — "carried forward from cache at $0" would re-mint the
//     stale q=1.0 verbatim.
import { appendFileSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(`${REPO}/.env`)) {
  for (const line of readFileSync(`${REPO}/.env`, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^"|"$/g, '');
  }
}
if (!process.env.KEY_RISK_ACCEPTED) throw new Error('live spend: set KEY_RISK_ACCEPTED=<date> (ledger row first)');
const STORE = process.env.OBSERVATORY_DB ?? `${REPO}/.pglite/platform-sweep-step5`;
const ART = process.env.OBSERVATORY_ARTIFACTS ?? `${REPO}/artifacts/observatory`;
process.env.POTION_PRICES_PATH = process.env.POTION_PRICES_PATH ?? `${REPO}/prices.json`;
const CAP = Number(process.env.RESWEEP_CAP_USD ?? 10);
const PUBLISH = process.env.RESWEEP_PUBLISH === '1';
const SALT = process.env.RESWEEP_SALT ?? 'tools-resweep-2026-09-01';
const CLUSTER = 'agentic-tool-use';

const { createDb, migrate } = await import('@potion/db');
// drizzle-orm is not hoisted to the image root; resolve it through @potion/db's copy
const require2 = (await import('node:module')).createRequire(
  (await import('node:url')).pathToFileURL(`${REPO}/node_modules/@potion/db/package.json`).href,
);
const { sql } = require2('drizzle-orm') as typeof import('drizzle-orm');
const W = await import('@potion/workers');
const { frontierPlatformSweepHandler } = W;
const { strategyHash } = await import('@potion/core');

// The m3 shortlist + BOTH v1 incumbents (rule 2 above).
const SHORTLIST = [
  'or-gpt-full',
  'or-grok-4.6',
  'or-inkling-small',
  'or-kat-coder-pro-v2.5',
  'or-gpt-5.6-terra-pro',
  'or-gemini-flash',
  'or-solar-pro4',
];

const handle = await createDb(`pglite://${STORE}`);
await migrate(handle.db);

// ---- rule 1: fresh cells only -------------------------------------------
// Cutoff = the incident date. Cells measured BEFORE it are the contradicted
// evidence; cells from this leg's own dry run (created today, same salt)
// must survive so the publish re-run can aggregate them. created_at is ISO
// text, so lexicographic < is chronological <.
const INCIDENT_CUTOFF = '2026-09-01T00:00:00.000Z';
const staleTargets = sql`
      cluster_id = ${CLUSTER}
  AND instrument = 'tools'
  AND provider_mode = 'live'
  AND org_id IS NULL
  AND stale = false
  AND created_at < ${INCIDENT_CUTOFF}`;
const existing = (
  await handle.db.execute(sql`
    SELECT prices_version AS pv, count(*)::int AS n
      FROM eval_results
     WHERE ${staleTargets}
     GROUP BY prices_version`)
).rows as Array<{ pv: string; n: number }>;
const total = existing.reduce((a, r) => a + Number(r.n), 0);
if (total > 0 && process.env.RESWEEP_RETIRE !== '1') {
  console.error(
    `REFUSED: ${total} non-stale live tools-instrument cells exist for '${CLUSTER}' ` +
      `(prices versions: ${existing.map((r) => `${r.pv}×${r.n}`).join(', ')}). ` +
      `They would average into the fresh aggregate at matching coordinates. ` +
      `Re-run with RESWEEP_RETIRE=1 to mark them stale (cause: 2026-09-01 production ` +
      `zero-token bursts contradict the recorded measurement).`,
  );
  await handle.close?.();
  process.exit(2);
}
if (total > 0) {
  await handle.db.execute(sql`UPDATE eval_results SET stale = true WHERE ${staleTargets}`);
  console.log(
    `retired ${total} pre-incident tools cells (marked stale; cause: 2026-09-01 ` +
      `serving-measured degeneracy contradicts the suite measurement — re-measuring fresh)`,
  );
}

const ctx = { db: handle.db, dbHandle: handle, pricesPath: process.env.POTION_PRICES_PATH! } as never;
console.log(
  `tools re-sweep: ${SHORTLIST.length} singles on agentic-tool-use-tools-v1@1.1.0 (36 items, ` +
    `12 multi-turn) · salt ${SALT} · cap $${CAP} · publish=${PUBLISH}`,
);
const res = await frontierPlatformSweepHandler(
  {
    clusterId: CLUSTER,
    suiteOverride: { kind: 'v2', suiteId: 'agentic-tool-use-tools-v1' },
    auditionModels: SHORTLIST,
    capUsd: CAP,
    maxAnswerers: SHORTLIST.length,
    publish: PUBLISH,
    cacheSalt: SALT,
    instrument: 'tools',
  } as never,
  ctx,
);

const byHash = new Map<string, string>();
for (const m of SHORTLIST) byHash.set(strategyHash({ type: 'single', model: m }), m);
const r = res as {
  runId?: string;
  spendUsd?: number;
  executed?: number;
  cacheHits?: number;
  published?: boolean;
  frontierId?: string | null;
  frontierVersion?: number | null;
  sampled?: { strategyHash: string; meanQuality: number; n: number }[];
  frontierPointsFull?: { strategyHash: string; quality: number; costPer1K: number }[];
  failedCandidates?: { strategyHash: string; alias: string | null; error: string }[];
};
console.log(`\nrun ${r.runId} · spend $${(r.spendUsd ?? 0).toFixed(4)} · executed ${r.executed} · cacheHits ${r.cacheHits}`);
if ((r.cacheHits ?? 0) > 0 && !PUBLISH) {
  console.warn(`NOTE: ${r.cacheHits} cache hits under a supposedly fresh salt — verify the salt actually changed.`);
}
if (r.sampled) {
  console.log('\nstrategy                       quality   n   (n must equal 36 — more means cell mixing)');
  for (const s of [...r.sampled].sort((a, b) => b.meanQuality - a.meanQuality)) {
    console.log(`${(byHash.get(s.strategyHash) ?? s.strategyHash.slice(0, 8)).padEnd(30)} ${s.meanQuality.toFixed(3)}   ${s.n}`);
  }
}
if (r.frontierPointsFull && r.frontierPointsFull.length > 0) {
  console.log(`\npublished v${r.frontierVersion} (${r.frontierId}):`);
  for (const p of r.frontierPointsFull) {
    console.log(`  ${(byHash.get(p.strategyHash) ?? p.strategyHash.slice(0, 8)).padEnd(30)} q=${p.quality.toFixed(4)} $${p.costPer1K.toFixed(4)}/1K`);
  }
}
for (const f of r.failedCandidates ?? []) {
  console.log(`FAILED: ${f.alias ?? f.strategyHash.slice(0, 8)} — ${f.error}`);
}
mkdirSync(ART, { recursive: true });
appendFileSync(
  `${ART}/ledger.jsonl`,
  `${JSON.stringify({ at: new Date().toISOString(), week: 'g-tools-resweep', lane: 'tools-resweep', spendUsd: r.spendUsd ?? 0, detail: `agentic-tool-use-tools-v1@1.1.0 publish=${PUBLISH} salt=${SALT} retired=${total}` })}\n`,
);
const out = `${ART}/tools-resweep-${new Date().toISOString().slice(0, 10)}${PUBLISH ? '' : '-dry'}.json`;
writeFileSync(out, JSON.stringify({ res, byHash: [...byHash.entries()] }, null, 1));
console.log(`\nartifact: ${out}`);
await handle.close?.();
