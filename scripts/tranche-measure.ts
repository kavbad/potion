// Measure the tranche: 23 models across 17 vendors, all ten clusters.
//
// Same two-bound discipline as S6, plus the guard S6's aftermath added:
//   per-leg cap  — the harness preflight refuses before spending if a leg's
//                  projection exceeds it. Set from the leg-0 projection.
//   campaign belt— cumulative ACTUAL spend. The operator's number. Checked
//                  after every leg; stops the campaign mid-run.
//   maxAnswerers — passed EXPLICITLY, which is the acknowledgement the sweep
//                  now requires when the reachable pool exceeds the width
//                  ceiling. Without it the sweep refuses rather than
//                  silently measuring the cheapest twelve.
//
// Runs against the Step 5 campaign database so the 8 already-measured models
// cache-hit and only the 23 new ones cost anything.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const CAMPAIGN_BELT_USD = 60;
const MAX_ANSWERERS = 40; // 31 reachable today; headroom, never a truncation

for (const line of readFileSync(`${REPO}/.env`, 'utf8').split('\n')) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, '');
}
for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY']) delete process.env[k];
const accepted = process.env.KEY_RISK_ACCEPTED;
if (!accepted || !/^\d{4}-\d{2}-\d{2}$/.test(accepted)) {
  throw new Error(`REFUSING to spend: set KEY_RISK_ACCEPTED=YYYY-MM-DD (belt $${CAMPAIGN_BELT_USD})`);
}
process.env.POTION_EVAL_PROVIDER = 'live';
// A 1600-token generation from a slow model exceeds the 60s serving default;
// five legs died on it while every model answered fine at 8 tokens.
process.env.POTION_PROVIDER_TIMEOUT_MS = process.env.POTION_PROVIDER_TIMEOUT_MS ?? '180000';
process.env.POTION_PRICES_PATH = `${REPO}/.tranche/prices.json`;

const { createDb, migrate, upsertBudget, mtdSpendUsd, orgs } = await import('@potion/db');
const { frontierPlatformSweepHandler, PLATFORM_OPS_ORG_ID, PLATFORM_SUITE_BY_CLUSTER } = await import('@potion/workers');

const handle = await createDb(`pglite://${REPO}/.pglite/platform-sweep-step5`);
await migrate(handle.db);
await handle.db.insert(orgs).values({ id: PLATFORM_OPS_ORG_ID, name: 'platform ops' }).onConflictDoNothing();
const before = await mtdSpendUsd(handle.db, PLATFORM_OPS_ORG_ID, new Date());
await upsertBudget(handle.db, {
  orgId: PLATFORM_OPS_ORG_ID, monthlyCapUsd: before + CAMPAIGN_BELT_USD, hardStop: true, warnPct: 80,
});

console.log('── tranche: 23 models, 17 vendors, 10 clusters ─────────────────');
console.log(`risk accepted : ${accepted}`);
console.log(`ops MTD before: $${before.toFixed(4)}`);
console.log(`campaign belt : $${CAMPAIGN_BELT_USD.toFixed(2)} ACTUAL`);
console.log(`maxAnswerers  : ${MAX_ANSWERERS} (explicit — the sweep refuses a silent truncation)\n`);

// Per-leg caps sit ABOVE the sweep's own projection, which counts EVERY
// candidate cell including the 8 that will cache-hit and meter $0. My first
// pass sized them from the new models alone and all ten legs refused before
// spending — the preflight doing exactly its job, on a number it cannot know
// is partly pre-paid. The belt on ACTUAL spend is the real protection; these
// are the gate that stops a leg whose projection is wildly off.
const LEG_CAP: Record<string, number> = {
  'code-gen': 45, extraction: 39, 'rag-answer': 39, classification: 38,
  'multi-step-reasoning': 38, summarization: 21, 'agentic-tool-use': 21,
  'rewrite-edit': 21, 'code-review': 21, creative: 21,
};

let cumulative = 0;
for (const clusterId of Object.keys(PLATFORM_SUITE_BY_CLUSTER)) {
  if (cumulative >= CAMPAIGN_BELT_USD) {
    console.log(`\nBELT REACHED at $${cumulative.toFixed(4)} — stopping before '${clusterId}'.`);
    break;
  }
  const t0 = Date.now();
  try {
    const res = await frontierPlatformSweepHandler(
      { clusterId, capUsd: LEG_CAP[clusterId] ?? 14, maxAnswerers: MAX_ANSWERERS },
      { db: handle.db, dbHandle: handle, pricesPath: process.env.POTION_PRICES_PATH! } as never,
    );
    cumulative += res.spendUsd;
    console.log(
      `  ${clusterId.padEnd(22)} cand=${String(res.candidates.length).padStart(2)} ` +
      `exec=${String(res.executed).padStart(4)} cached=${String(res.cacheHits).padStart(3)} ` +
      `pts=${res.points} spend=$${res.spendUsd.toFixed(4)} cum=$${cumulative.toFixed(4)} ` +
      `(${((Date.now() - t0) / 60000).toFixed(1)}m)`,
    );
  } catch (err) {
    console.log(`  ${clusterId.padEnd(22)} FAILED: ${(err as Error).message}`);
  }
}
console.log(`\nCAMPAIGN ACTUAL: $${cumulative.toFixed(4)} of $${CAMPAIGN_BELT_USD.toFixed(2)} belt`);
await handle.close();
