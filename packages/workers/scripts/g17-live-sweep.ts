// G1.7 LIVE proof leg (operator script, run once, ledgered):
//   set -a && source .env && set +a
//   PATH=... POTION_EVAL_PROVIDER=live DATABASE_URL=pglite://<repo>/.pglite/livesweep-g17 \
//     pnpm --filter @potion/workers exec tsx scripts/g17-live-sweep.ts
// Seeds a realistic org agent cluster (5 referenced sessions), runs the
// nightly MOCK pipeline (cluster + derived suite + mock frontier — the
// "before" state), then the REAL frontier:live-sweep handler with live
// providers (cap $3), and verifies: all frontier points providerMode
// 'live'; live cacheKeys disjoint from the mock rows'; one eval_live
// request_logs row equal to the run spend; mtdSpendUsd sees it; the
// serving read returns the live org frontier; a nightly re-run does NOT
// clobber it (taint rule). Deterministic word-hash embedder — the LIVE
// surface under test is answering + judging, not embeddings.
import { fileURLToPath } from 'node:url';
import {
  createDb,
  createOrg,
  evalResults,
  insertTraceSpans,
  migrate,
  mtdSpendUsd,
  requestLogs,
  type NewTraceSpan,
} from '@potion/db';
import { loadCurrentFrontier } from '@potion/pareto';
import { eq } from 'drizzle-orm';
import {
  frontierLiveSweepHandler,
  orgHashOf,
  toolSignatureSlug,
  tracesClusterHandler,
} from '../src/handlers.js';

const PRICES = fileURLToPath(new URL('../../../prices.json', import.meta.url));
const ORG = 'org_g17_live';

function wordHash(word: string): number {
  let h = 0;
  for (let i = 0; i < word.length; i++) h = (Math.imul(h, 31) + word.charCodeAt(i)) | 0;
  return Math.abs(h);
}
const embedder = {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array<number>(384).fill(0);
      for (const w of t.toLowerCase().split(/[^a-z0-9]+/)) if (w.length > 0) v[wordHash(w) % 384]! += 1;
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      return v.map((x) => x / norm);
    });
  },
};

const SESSIONS = [
  {
    id: 'tr_g17_1',
    prompt: 'Customer 30001001 reports their data export stalls at 60 percent — investigate and resolve',
    completion:
      'The export worker hit the row-count cap on the orders table. Split the export into two ' +
      'batches, re-ran it to completion, and emailed the customer both download links.',
    result: 'export job: stalled at chunk 6/10, oversized batch',
  },
  {
    id: 'tr_g17_2',
    prompt: 'Customer 30001002 reports their data export produced an empty file — investigate and resolve',
    completion:
      'The export ran before the nightly ETL populated the reporting tables. Re-ran it after the ' +
      'ETL completed and verified the file contains all 4,200 rows; added a dependency check.',
    result: 'export job: completed, 0 rows written',
  },
  {
    id: 'tr_g17_3',
    prompt: 'Customer 30001003 reports their data export is missing the archived records — investigate and resolve',
    completion:
      'Archived records were excluded by the default active-only filter. Re-ran the export with ' +
      'include_archived set and confirmed the archived rows are present in the output.',
    result: 'export job: completed, filter=active-only',
  },
  {
    id: 'tr_g17_4',
    prompt: 'Customer 30001004 reports their data export times out every night — investigate and resolve',
    completion:
      'The export was scheduled during the backup window and starved for IO. Moved the schedule ' +
      'two hours later and the last three runs completed in under four minutes.',
    result: 'export job: timeout at 30m, IO wait 92 percent',
  },
  {
    id: 'tr_g17_5',
    prompt: 'Customer 30001005 reports their data export has wrong currency totals — investigate and resolve',
    completion:
      'Totals were summed before currency conversion. Fixed the export to convert per row at the ' +
      'transaction-date rate and reconciled the corrected totals against the invoice ledger.',
    result: 'export job: completed, totals mismatch flagged',
  },
];

async function main(): Promise<void> {
  if (process.env.POTION_EVAL_PROVIDER !== 'live') throw new Error('set POTION_EVAL_PROVIDER=live');
  const handle = await createDb();
  const db = handle.db;
  await migrate(db);
  await createOrg(db, { id: ORG, name: 'G1.7 live leg' });

  for (const s of SESSIONS) {
    const spans: NewTraceSpan[] = [
      {
        orgId: ORG, traceId: s.id, spanId: `${s.id}_root`, name: 'agent.root', model: 'gpt-nano-class',
        usage: { input_tokens: 100, output_tokens: 50 }, costUsd: 0,
        attrs: { 'gen_ai.prompt': s.prompt }, ts: new Date(),
      },
      {
        orgId: ORG, traceId: s.id, spanId: `${s.id}_tool`, name: 'tool.export_status', model: 'gpt-nano-class',
        usage: { input_tokens: 10, output_tokens: 5 }, costUsd: 0,
        attrs: { 'gen_ai.operation.name': 'execute_tool', 'tool.args': 'inspect export job', 'tool.result': s.result },
        ts: new Date(Date.now() + 60_000),
      },
      {
        orgId: ORG, traceId: s.id, spanId: `${s.id}_ans`, name: 'chat', model: 'gpt-nano-class',
        usage: { input_tokens: 200, output_tokens: 120 }, costUsd: 0,
        attrs: { 'gen_ai.completion': s.completion }, ts: new Date(Date.now() + 120_000),
      },
    ];
    await insertTraceSpans(db, spans);
  }

  const ctx = { db, dbHandle: handle, pricesPath: PRICES, embedder };
  // "Before" state: mock pipeline builds the cluster + suite + mock frontier.
  const clusterRes = await tracesClusterHandler({ orgId: ORG }, ctx);
  console.log('cluster:', JSON.stringify(clusterRes.clusters.map((c) => ({ id: c.clusterId, sessions: c.sessions }))));
  const clusterId = `agent-${orgHashOf(ORG)}-${toolSignatureSlug(['export_status'])}`;
  const before = await loadCurrentFrontier(db, clusterId, ORG);
  console.log('mock frontier: v' + before?.version, 'points', before?.points.length,
    'modes', [...new Set(before?.points.map((p) => p.providerMode ?? 'unknown'))]);
  const mockKeys = new Set(
    (await db.select({ k: evalResults.cacheKey }).from(evalResults).where(eq(evalResults.clusterId, clusterId))).map((r) => r.k),
  );

  // THE LIVE SWEEP (cap $3).
  const res = await frontierLiveSweepHandler({ orgId: ORG, clusterId, capUsd: 3 }, ctx);
  console.log('LIVE SWEEP RESULT:', JSON.stringify(res, null, 2));

  // Verifications.
  const after = (await loadCurrentFrontier(db, clusterId, ORG))!;
  const allLive = after.points.every((p) => p.providerMode === 'live');
  console.log('org frontier: v' + after.version, 'points', after.points.length, 'ALL LIVE:', allLive);
  for (const p of after.points) {
    console.log(`  point ${p.strategyHash.slice(0, 8)} q=${p.quality.toFixed(3)} $${p.costPer1K.toFixed(2)}/1K ` +
      `evidence: n=${p.evidence?.n} keys=${p.evidence?.cacheKeys.length} rubric=${p.evidence?.rubricHash?.slice(0, 8) ?? 'none'}`);
  }
  const liveRows = await db.select().from(evalResults).where(eq(evalResults.providerMode, 'live'));
  const disjoint = liveRows.every((r) => !mockKeys.has(r.cacheKey));
  console.log('live rows:', liveRows.length, 'cache keys disjoint from mock:', disjoint);
  const logs = await db.select().from(requestLogs).where(eq(requestLogs.status, 'eval_live'));
  console.log('eval_live request_logs:', logs.map((l) => ({ model: l.model, cost: (l.usage as { costUsd?: number } | null)?.costUsd })));
  const mtd = await mtdSpendUsd(db, ORG, new Date());
  console.log('org MTD spend (budgets see it):', mtd.toFixed(4));

  // Taint rule: nightly re-run must NOT clobber the live frontier.
  const nightly = await tracesClusterHandler({ orgId: ORG }, ctx);
  console.log('nightly re-run: liveFrontierSavesSkipped =', nightly.liveFrontierSavesSkipped);
  const final = (await loadCurrentFrontier(db, clusterId, ORG))!;
  console.log('frontier after nightly: v' + final.version, 'still all live:',
    final.points.every((p) => p.providerMode === 'live'));

  await handle.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
