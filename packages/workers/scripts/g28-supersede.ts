// G2.8 verdict supersession (post-capstone item 0, Stage 6 — operator script,
// run once against .pglite/g28-live, $0):
//   PATH=... DATABASE_URL=pglite://<repo>/.pglite/g28-live \
//     pnpm --filter @potion/workers exec tsx scripts/g28-supersede.ts
//
// The capstone rendered two contradictory verdicts pre-0029 — a 0.2707
// contractual-breach and a 1.0645 all-clear — and the all-clear left no
// durable record at all. This script issues the corrected verdict through
// SUPERSESSION, rubric-style: both priors are inserted as quarantined rows
// (preserved verbatim from what WAS recorded), the verdict is re-rendered
// under the fixed deterministic pairing via the real handler (all cache hits,
// no provider calls), and the priors gain superseded_by + supersede_reason.
// The audit trail shows the instrument catching and correcting itself —
// history is an asset, not an embarrassment.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createDb,
  evalResults,
  insertGuaranteeVerdict,
  listGuaranteeVerdicts,
  listIncidents,
  migrate,
  supersedeVerdict,
} from '@potion/db';
import { and, eq } from 'drizzle-orm';
import { guaranteeSuiteVerifyHandler, type JobContext } from '../src/handlers.js';
import { loadGuaranteeReport } from '../../../apps/server/src/routes/guarantee-report.js';
import { renderGuaranteeReportHtml } from '../../../apps/server/src/billing/render-guarantee-html.js';
import type { PotionContext } from '../../../apps/server/src/context.js';

const ORG = 'org_g28_capstone';
const CLUSTER = 'agent-2dfbfb-d8898a';
const PRICES = fileURLToPath(new URL('../../../prices.json', import.meta.url));
const OUT = fileURLToPath(new URL('../../../artifacts/', import.meta.url));

async function main() {
  // THE GUARD THIS SCRIPT EARNED ON ITS OWN FIRST RUN: invoked without
  // POTION_EVAL_PROVIDER=live, the suite-verify handler silently degrades to
  // MOCK mode, evaluates the suite under mock providers, and renders a mock
  // verdict — which is EXACTLY the leg-5c defect this script exists to
  // supersede. It reproduced it, and the 0029 row's providerMode column is
  // what caught it. frontier:live-sweep throws on a missing env; suite-verify
  // does not (it stamps the mode instead) — so the operator surface must.
  if (process.env.POTION_EVAL_PROVIDER !== 'live') {
    throw new Error('g28-supersede requires POTION_EVAL_PROVIDER=live — a mock-mode re-render would repeat the defect being corrected');
  }
  const h = await createDb();
  const db = h.db;
  await migrate(db); // idempotent — applies 0029 to the capstone db

  // Resolve the candidate's FULL hash from the stored evidence.
  const rows = await db
    .select({ s: evalResults.strategyHash })
    .from(evalResults)
    .where(and(eq(evalResults.clusterId, CLUSTER), eq(evalResults.providerMode, 'live')));
  const candidate = [...new Set(rows.map((r) => r.s))].find((s) => s.startsWith('8fe33bc4'));
  const incumbent = [...new Set(rows.map((r) => r.s))].find((s) => s.startsWith('1a9bac73'));
  if (!candidate || !incumbent) throw new Error('capstone evidence not found — wrong DATABASE_URL?');

  // ---- PRIOR A: the pre-fix breach, verbatim from its incident ------------
  const incidents = await listIncidents(db, ORG, 50);
  const breach = incidents.find((i) => {
    const d = i.detail as Record<string, unknown>;
    return i.kind === 'quality_breach' && String(d.fromStrategy ?? '').startsWith('8fe33bc4');
  });
  if (!breach) throw new Error('the 0.2707 breach incident is missing');
  const breachDetail = breach.detail as Record<string, unknown>;
  const priorA = await insertGuaranteeVerdict(db, {
    orgId: ORG,
    policyId: String(breachDetail.policyId ?? 'pol-g28'),
    clusterId: CLUSTER,
    suiteId: `${CLUSTER}-replays-v1`,
    candidateHash: candidate,
    incumbentHash: incumbent,
    providerMode: 'live',
    outcome: 'contractual-breach',
    // Verbatim — including the pre-fix seed 4159430066 and ci95
    // [0.1754, 0.3743]. No pairEvidence: pre-0029 did not record it.
    retention: breachDetail.retention as Record<string, unknown>,
    detail:
      `reconstructed ${new Date().toISOString().slice(0, 10)} from incident ${breach.id} ` +
      `(rendered pre-0029 at ${breach.createdAt.toISOString()})`,
    verdictIncidentId: breach.id,
  });

  // ---- PRIOR B: the 1.0645 all-clear, from the leg-5c run log -------------
  // Pre-0029 an all-clear with no advisory wrote NOTHING — this row exists to
  // preserve the observation, not to validate it. Its absence of pairEvidence
  // and seed IS the finding.
  const priorB = await insertGuaranteeVerdict(db, {
    orgId: ORG,
    policyId: 'pol-g28-serve',
    clusterId: CLUSTER,
    suiteId: `${CLUSTER}-replays-v1`,
    candidateHash: candidate,
    incumbentHash: incumbent,
    providerMode: 'live',
    outcome: 'all-clear',
    retention: {
      mean: 1.0644927536231883,
      ci95: [0.9847826086956519, 1.1420289855072463],
      pairs: 23,
      excludedPairs: 0,
      epsilon: 0.05,
      floor: 0.9,
      seed: null,
      note: 'reconstructed from the leg-5c operator run log; no durable record existed',
    },
    detail:
      'unverifiable-no-durable-record: pre-0029 all-clears persisted nothing; the inputs behind ' +
      'this number were never recorded and no candidate pairing against the designated incumbent ' +
      'reproduces it (re-run experiment, 2026-08-09) — preserved as evidence of the defect',
  });

  // ---- ACTIVE: re-render under deterministic pairing via the REAL handler --
  const ctxJob: JobContext = { db, dbHandle: h, pricesPath: PRICES };
  const result = await guaranteeSuiteVerifyHandler(
    {
      orgId: ORG,
      policyId: 'pol-g28-serve',
      clusterId: CLUSTER,
      servingStrategyHash: candidate,
      capUsd: 8, // never reached — every eval row cache-hits
    },
    ctxJob,
  );
  if (!result.verdictId) throw new Error('re-render wrote no verdict row');
  console.log(
    `ACTIVE verdict ${result.verdictId}: ${result.outcome} ` +
      `mean=${result.retention?.mean.toFixed(4)} ci=[${result.retention?.ci95.map((x) => x.toFixed(4)).join(', ')}] ` +
      `seed=${result.retention?.seed} pairs=${result.retention?.pairs} spend=$${result.spendUsd.toFixed(4)}`,
  );

  // ---- SUPERSEDE, each prior with its own reason --------------------------
  await supersedeVerdict(db, {
    orgId: ORG,
    priorIds: [priorA],
    newId: result.verdictId,
    reason:
      'pre-0029: order-dependent CI — pairedQualities lacked ORDER BY and the bootstrap seed ' +
      'hashed scan-ordered ratios; mean unaffected (order-invariant), interval and seed were not ' +
      '(fixed 0013c28)',
  });
  await supersedeVerdict(db, {
    orgId: ORG,
    priorIds: [priorB],
    newId: result.verdictId,
    reason:
      'unverifiable-no-durable-record: rendered by a pre-0029 all-clear path that persisted ' +
      'nothing; inputs unrecoverable, observation preserved and quarantined',
  });

  console.log('\nVERDICT TRAIL (newest first):');
  for (const v of await listGuaranteeVerdicts(db, ORG)) {
    const r = v.retention as { mean?: number } | null;
    console.log(
      `  ${v.id.slice(0, 8)}  ${v.outcome.padEnd(19)} mean=${r?.mean?.toFixed(4) ?? '—'} ` +
        `${v.supersededBy ? `SUPERSEDED→${v.supersededBy.slice(0, 8)}` : 'ACTIVE'}`,
    );
  }

  // ---- Regenerate the customer-facing report artifacts --------------------
  const today = new Date().toISOString().slice(0, 10);
  const ctxSrv = { db: h, pricesPath: PRICES, providerMode: 'live' } as unknown as PotionContext;
  const report = await loadGuaranteeReport(ctxSrv, ORG, { fromDay: today, toDay: today });
  writeFileSync(`${OUT}g28-capstone-report.json`, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(`${OUT}g28-capstone-report.html`, renderGuaranteeReportHtml(report));
  const entry = report.entries.find((e) => e.clusterId === CLUSTER);
  console.log(
    `\nREPORT: entries=${report.entries.length} legacyPath=${report.legacyPath} ` +
      `headline=${entry?.retention ? `${entry.retention.verdict} ${entry.retention.mean.toFixed(4)} (${entry.retention.confidence})` : 'none'}`,
  );

  await h.close();
  console.log('SUPERSESSION DONE');
}

void main().catch((e: unknown) => {
  console.error(`SUPERSESSION FAILED: ${(e as Error).message}`);
  process.exit(1);
});
