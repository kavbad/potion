// Supersede the MOCK-mode verdict this script's own first run produced.
//   set -a && source .env && set +a
//   POTION_EVAL_PROVIDER=live DATABASE_URL=pglite://<repo>/.pglite/g28-live \
//     pnpm --filter @potion/workers exec tsx scripts/g28-supersede-fix.ts
//
// g28-supersede.ts ran without POTION_EVAL_PROVIDER=live, so its "corrected"
// verdict paired MOCK evidence (mode=mock, $0.0413 mock-priced eval) —
// reproducing the leg-5c defect it was correcting. The durable table caught
// it: providerMode on the row. This issues the LIVE re-render and supersedes
// the mock row, extending the chain rather than editing it.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDb, listGuaranteeVerdicts, migrate, supersedeVerdict } from '@potion/db';
import { guaranteeSuiteVerifyHandler, type JobContext } from '../src/handlers.js';
import { loadGuaranteeReport } from '../../../apps/server/src/routes/guarantee-report.js';
import { renderGuaranteeReportHtml } from '../../../apps/server/src/billing/render-guarantee-html.js';
import type { PotionContext } from '../../../apps/server/src/context.js';

const ORG = 'org_g28_capstone';
const CLUSTER = 'agent-2dfbfb-d8898a';
const PRICES = fileURLToPath(new URL('../../../prices.json', import.meta.url));
const OUT = fileURLToPath(new URL('../../../artifacts/', import.meta.url));

async function main() {
  if (process.env.POTION_EVAL_PROVIDER !== 'live') {
    throw new Error('requires POTION_EVAL_PROVIDER=live');
  }
  const h = await createDb();
  await migrate(h.db);
  const rows = await listGuaranteeVerdicts(h.db, ORG);
  const mockActive = rows.find((v) => v.supersededBy === null && v.providerMode === 'mock');
  if (!mockActive) throw new Error('no active mock verdict to supersede — already fixed?');
  const candidate = mockActive.candidateHash;

  const ctxJob: JobContext = { db: h.db, dbHandle: h, pricesPath: PRICES };
  const result = await guaranteeSuiteVerifyHandler(
    { orgId: ORG, policyId: 'pol-g28-serve', clusterId: CLUSTER, servingStrategyHash: candidate, capUsd: 8 },
    ctxJob,
  );
  if (!result.verdictId) throw new Error('live re-render wrote no verdict row');
  console.log(
    `LIVE verdict ${result.verdictId}: ${result.outcome} mode=${result.providerMode} ` +
      `mean=${result.retention?.mean.toFixed(4)} ci=[${result.retention?.ci95.map((x) => x.toFixed(4)).join(', ')}] ` +
      `seed=${result.retention?.seed} pairs=${result.retention?.pairs} spend=$${result.spendUsd.toFixed(4)}`,
  );

  await supersedeVerdict(h.db, {
    orgId: ORG,
    priorIds: [mockActive.id],
    newId: result.verdictId,
    reason:
      'mock-mode operator error: g28-supersede.ts first run lacked POTION_EVAL_PROVIDER=live, so ' +
      'the handler paired MOCK evidence — reproducing the leg-5c defect it was correcting. The ' +
      '0029 providerMode column is what caught it. This also RESOLVES the original mystery: ' +
      'leg-5c itself was a mock-mode verify (identical mean 1.0645), not unrecorded inputs.',
  });

  console.log('\nVERDICT TRAIL (newest first):');
  for (const v of await listGuaranteeVerdicts(h.db, ORG)) {
    const r = v.retention as { mean?: number } | null;
    console.log(
      `  ${v.id.slice(0, 8)}  ${v.outcome.padEnd(19)} mode=${v.providerMode.padEnd(5)} ` +
        `mean=${r?.mean?.toFixed(4) ?? '—'} ${v.supersededBy ? `SUPERSEDED→${v.supersededBy.slice(0, 8)}` : 'ACTIVE'}`,
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const ctxSrv = { db: h, pricesPath: PRICES, providerMode: 'live' } as unknown as PotionContext;
  const report = await loadGuaranteeReport(ctxSrv, ORG, { fromDay: today, toDay: today });
  writeFileSync(`${OUT}g28-capstone-report.json`, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(`${OUT}g28-capstone-report.html`, renderGuaranteeReportHtml(report));
  const entry = report.entries.find((e) => e.clusterId === CLUSTER);
  console.log(
    `\nREPORT: headline=${entry?.retention ? `${entry.retention.verdict} ${entry.retention.mean.toFixed(4)} (${entry.retention.confidence}, ${entry.retention.providerMode})` : 'none'}`,
  );
  await h.close();
  console.log('FIX DONE');
}

void main().catch((e: unknown) => {
  console.error(`FIX FAILED: ${(e as Error).message}`);
  process.exit(1);
});
