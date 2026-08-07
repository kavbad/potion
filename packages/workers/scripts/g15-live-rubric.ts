// G1.5 LIVE proof leg (operator script, run once, ledgered):
//   PATH=... POTION_RUBRIC_PROVIDER=live DATABASE_URL=pglite://<repo>/.pglite/rubric-g15 \
//     pnpm --filter @potion/workers exec tsx scripts/g15-live-rubric.ts
// Seeds a realistic demo-org agent cluster (4 referenced sessions), runs the
// REAL rubric:generate handler with live providers (generation + probe
// calibration, cap $2), verifies persisted rows, then approves and verifies
// the restamp. The clustering embedder is deterministic word-hash — the
// LIVE surface under test is generation + probe judging, not embeddings.
import { fileURLToPath } from 'node:url';
import {
  clusterRubrics,
  createDb,
  createOrg,
  getClusterRubric,
  approveClusterRubric,
  judgeCalibrations,
  loadDerivedSuite,
  migrate,
  insertTraceSpans,
  requestLogs,
  type NewTraceSpan,
} from '@potion/db';
import { eq } from 'drizzle-orm';
import { orgHashOf, rubricGenerateHandler, toolSignatureSlug, tracesClusterHandler } from '../src/handlers.js';

const PRICES = fileURLToPath(new URL('../../../prices.json', import.meta.url));
const ORG = 'org_g15_live';

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

const SESSIONS: Array<{ id: string; prompt: string; completion: string; toolResult: string }> = [
  {
    id: 'tr_live_1',
    prompt: 'Customer 20240811 reports duplicate charges on their subscription — investigate and resolve',
    completion:
      'Found two charges for invoice 20240811 created by a webhook retry. Refunded the duplicate ' +
      '($49.00), added an idempotency key to the billing webhook, and emailed the customer a ' +
      'confirmation with the refund reference.',
    toolResult: 'charges: 2 rows, same idempotency window',
  },
  {
    id: 'tr_live_2',
    prompt: 'Customer 20240812 reports duplicate charges after switching plans — investigate and resolve',
    completion:
      'The plan switch created overlapping subscriptions; the old one billed once more. Cancelled ' +
      'the stale subscription, refunded the overlapping charge, and confirmed the new plan bills ' +
      'from the switch date.',
    toolResult: 'subscriptions: 2 active, 1 stale',
  },
  {
    id: 'tr_live_3',
    prompt: 'Customer 20240813 reports duplicate charges on the annual invoice — investigate and resolve',
    completion:
      'The annual invoice was paid twice — once by card, once by the saved bank transfer. Refunded ' +
      'the card payment, kept the transfer, and disabled auto-charge while a payment method is pending.',
    toolResult: 'payments: card + transfer against one invoice',
  },
  {
    id: 'tr_live_4',
    prompt: 'Customer 20240814 reports duplicate charges from a failed checkout — investigate and resolve',
    completion:
      'Checkout retried after a gateway timeout and both attempts settled. Voided the second ' +
      'authorization before capture, so no refund was needed, and raised the gateway timeout.',
    toolResult: 'authorizations: 2, one voidable',
  },
];

async function main(): Promise<void> {
  if (process.env.POTION_RUBRIC_PROVIDER !== 'live') throw new Error('set POTION_RUBRIC_PROVIDER=live');
  const handle = await createDb();
  const db = handle.db;
  await migrate(db);
  await createOrg(db, { id: ORG, name: 'G1.5 live leg' });

  for (const s of SESSIONS) {
    const spans: NewTraceSpan[] = [
      {
        orgId: ORG, traceId: s.id, spanId: `${s.id}_root`, name: 'agent.root', model: 'gpt-nano-class',
        usage: { input_tokens: 100, output_tokens: 50 }, costUsd: 0,
        attrs: { 'gen_ai.prompt': s.prompt }, ts: new Date(),
      },
      {
        orgId: ORG, traceId: s.id, spanId: `${s.id}_tool`, name: 'tool.billing_lookup', model: 'gpt-nano-class',
        usage: { input_tokens: 10, output_tokens: 5 }, costUsd: 0,
        attrs: { 'gen_ai.operation.name': 'execute_tool', 'tool.args': 'customer billing history', 'tool.result': s.toolResult },
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
  const clusterRes = await tracesClusterHandler({ orgId: ORG }, ctx);
  console.log('cluster:', JSON.stringify(clusterRes.clusters.map((c) => ({ id: c.clusterId, sessions: c.sessions }))));
  const clusterId = `agent-${orgHashOf(ORG)}-${toolSignatureSlug(['billing_lookup'])}`;
  const suite = await loadDerivedSuite(db, `${clusterId}-replays-v1`);
  console.log('suite items:', suite?.items.length, 'referenced:', suite?.items.filter((i) => i.reference !== undefined).length);

  const res = await rubricGenerateHandler({ orgId: ORG, clusterId, capUsd: 2, seed: 20260807 }, ctx);
  console.log('RESULT:', JSON.stringify(res, null, 2));

  const rubric = (await getClusterRubric(db, res.rubricId))!;
  console.log('RUBRIC TEXT:\n' + rubric.rubricText);
  const cal = res.calibration
    ? (await db.select().from(judgeCalibrations).where(eq(judgeCalibrations.id, res.calibration.id)))[0]
    : null;
  console.log('calibration row:', cal ? JSON.stringify({ answerer: cal.answererModel, rubricHash: cal.rubricHash?.slice(0, 12), r: cal.pearsonVsTruth, rho: cal.spearmanVsTruth, mAE: cal.meanAbsErr, flagged: cal.flagged, n: cal.n, providerMode: cal.providerMode, spend: cal.spendUsd }) : 'none');
  const logs = await db.select().from(requestLogs).where(eq(requestLogs.status, 'rubric_gen'));
  console.log('rubric_gen request_logs:', logs.map((l) => ({ model: l.model, cost: (l.usage as { costUsd?: number } | null)?.costUsd })));

  const restamped = await approveClusterRubric(db, res.rubricId);
  const after = (await loadDerivedSuite(db, `${clusterId}-replays-v1`))!;
  const homogeneous = after.items.every(
    (i) => i.scoring.kind === 'llm-judge' && i.scoring.rubric === rubric.rubricText,
  );
  console.log('approved: restamped', restamped, 'homogeneous', homogeneous);
  const all = await db.select().from(clusterRubrics);
  console.log('statuses:', all.map((r) => r.status));
  await handle.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
