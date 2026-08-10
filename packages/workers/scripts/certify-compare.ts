// Session-vs-step comparability leg (post-capstone item 3, owner
// requirement): on ONE cluster of the fresh corpus, certify BOTH suite
// generations — session-level (-replays-v1) and step-level (-replays-v2) —
// so the step-synthesis improvement is demonstrated on SHARED data, not
// asserted across corpora. Two suite_certifications rows, one incumbent,
// one judge. Expected: v1 fails (the capstone's 0.2-class self-retention),
// v2 certifies — the acceptance evidence for post-capstone item 2.
//
// OWNER-GATED LIVE LEG (fresh-corpus decision, 2026-08-10): run once the
// converter-v2 corpus has accumulated and an incumbent is designated.
//   PATH=... DATABASE_URL=pglite://<db> POTION_EVAL_PROVIDER=live \
//     pnpm --filter @potion/workers exec tsx scripts/certify-compare.ts \
//       <orgId> <clusterId> [capUsd]
// Projected at 184 v2 items + ~23 v1 items: ≈ $5–10 total, per-call metered.
import { createDb, listSuiteCertifications, migrate } from '@potion/db';
import { fileURLToPath } from 'node:url';
import { suiteCertifyHandler, type JobContext } from '../src/handlers.js';

const PRICES = fileURLToPath(new URL('../../../prices.json', import.meta.url));

async function main() {
  const [orgId, clusterId, capArg] = process.argv.slice(2);
  if (!orgId || !clusterId) {
    throw new Error('usage: certify-compare.ts <orgId> <clusterId> [capUsd]');
  }
  if (process.env.POTION_EVAL_PROVIDER !== 'live') {
    // The g28-supersede lesson: an operator surface must refuse silent mock
    // degradation — a mock certification of a live corpus is a false-live
    // validity claim (the handler's mode-mismatch guard backstops this).
    throw new Error('certify-compare requires POTION_EVAL_PROVIDER=live');
  }
  const capUsd = capArg !== undefined ? Number(capArg) : undefined;
  const h = await createDb();
  await migrate(h.db);
  const ctx: JobContext = { db: h.db, dbHandle: h, pricesPath: PRICES };

  for (const generation of ['v1', 'v2'] as const) {
    const suiteId = `${clusterId}-replays-${generation}`;
    const r = await suiteCertifyHandler(
      { orgId, clusterId, suiteId, ...(capUsd !== undefined ? { capUsd } : {}) },
      ctx,
    );
    console.log(
      `${generation.toUpperCase()} (${suiteId}): ${r.status} outcome=${r.outcome} ` +
        `selfRetention=${r.selfRetentionMean?.toFixed(4) ?? '—'} mode=${r.providerMode} ` +
        `spend=$${r.spendUsd.toFixed(4)} cert=${r.certificationId?.slice(0, 8) ?? 'null'}` +
        (r.detail ? `\n  ${r.detail}` : ''),
    );
  }

  console.log('\nCERTIFICATION TRAIL (newest first):');
  for (const c of await listSuiteCertifications(h.db, orgId)) {
    const e = (c.evidence ?? {}) as { selfRetentionMean?: number };
    console.log(
      `  ${c.id.slice(0, 8)}  ${c.suiteId}  v${c.suiteVersion}  ${c.status.padEnd(10)} ` +
        `${typeof e.selfRetentionMean === 'number' ? e.selfRetentionMean.toFixed(4) : '—'}  ${c.providerMode}`,
    );
  }
  await h.close();
  console.log('COMPARE DONE');
}

void main().catch((e: unknown) => {
  console.error(`COMPARE FAILED: ${(e as Error).message}`);
  process.exit(1);
});
