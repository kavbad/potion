// S6 — widen the measured frontier to every reachable answerer.
//
// BEFORE: the platform sweep measured 3 of 8 reachable answerers (one class
// representative each) plus one cascade. or-gemini-flash, or-gpt-mini,
// or-haiku, or-gpt-full and or-sonnet sat in the catalog and had never been
// scored on any cluster — and dial honesty makes an unmeasured model
// unroutable, so they were breadth on paper only.
//
// WHY THIS IS AFFORDABLE. It runs against the Step 5 campaign database, whose
// eval_results cache already holds the three measured models at full item
// count. Those cells cache-hit and meter $0; only the five NEW models cost
// money. Full item counts are preserved, so the widened points carry the same
// evidence strength (n=14–15) as the ones already published — this buys
// BREADTH, it does not trade depth away for it.
//
// TWO INDEPENDENT BOUNDS, the Step 5 pattern:
//   per-leg cap  — the harness preflight REFUSES before spending if a leg's
//                  projection exceeds it. Set from the projection itself.
//   campaign belt— cumulative ACTUAL spend across legs. The operator's number.
//                  Checked after every leg; the campaign stops, mid-run, the
//                  moment it would be crossed.
//
// Usage:
//   pnpm exec tsx scripts/s6-widen.ts --dry-run          (no spend, gates only)
//   KEY_RISK_ACCEPTED=YYYY-MM-DD pnpm exec tsx scripts/s6-widen.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const DRY = process.argv.includes('--dry-run');

/** The operator's authorization for this campaign, in dollars of ACTUAL spend. */
const CAMPAIGN_BELT_USD = 25;

for (const line of readFileSync(`${REPO}/.env`, 'utf8').split('\n')) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, '');
}
// One provider, one bill to reconcile against.
for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY']) delete process.env[k];
if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY absent from .env');

if (!DRY) {
  const accepted = process.env.KEY_RISK_ACCEPTED;
  if (!accepted || !/^\d{4}-\d{2}-\d{2}$/.test(accepted)) {
    throw new Error(
      'REFUSING to spend: set KEY_RISK_ACCEPTED=YYYY-MM-DD (or pass --dry-run). ' +
        `This campaign bills a real provider key up to $${CAMPAIGN_BELT_USD}.`,
    );
  }
}
process.env.POTION_EVAL_PROVIDER = 'live';

const { createDb, migrate, upsertBudget, mtdSpendUsd } = await import('@potion/db');
const { frontierPlatformSweepHandler, PLATFORM_OPS_ORG_ID, PLATFORM_SUITE_BY_CLUSTER } =
  await import('@potion/workers');
const { orgs } = await import('@potion/db');

// The Step 5 campaign database — its eval cache is why this is affordable.
const CAMPAIGN_DB = `${REPO}/.pglite/platform-sweep-step5`;
const handle = await createDb(`pglite://${CAMPAIGN_DB}`);
await migrate(handle.db);

// Belt-and-braces: the ops org's own hard-stop budget, independent of the
// per-leg caps and of this script's accounting.
await handle.db
  .insert(orgs)
  .values({ id: PLATFORM_OPS_ORG_ID, name: 'platform ops' })
  .onConflictDoNothing();
const spentBefore = await mtdSpendUsd(handle.db, PLATFORM_OPS_ORG_ID, new Date());
await upsertBudget(handle.db, {
  orgId: PLATFORM_OPS_ORG_ID,
  monthlyCapUsd: spentBefore + CAMPAIGN_BELT_USD,
  hardStop: true,
  warnPct: 80,
});

console.log('── S6: widen every cluster to all reachable answerers ──────────');
console.log(`mode          : ${DRY ? 'DRY RUN (no spend)' : 'LIVE'}`);
console.log(`campaign db   : .pglite/platform-sweep-step5 (Step 5 cache reused)`);
console.log(`ops MTD before: $${spentBefore.toFixed(4)}`);
console.log(`campaign belt : $${CAMPAIGN_BELT_USD.toFixed(2)} of ACTUAL spend`);
console.log('');

// Per-leg caps from the leg-0 projection, rounded up with margin. The preflight
// refuses if a leg's own projection exceeds these, so they are a gate, not a target.
const LEG_CAP_USD: Record<string, number> = {
  'code-gen': 10, extraction: 9, 'rag-answer': 9, classification: 9,
  'multi-step-reasoning': 9, summarization: 6, 'agentic-tool-use': 6,
  'rewrite-edit': 6, 'code-review': 6, creative: 6,
};

let cumulative = 0;
const ledger: string[] = [];
for (const clusterId of Object.keys(PLATFORM_SUITE_BY_CLUSTER)) {
  if (cumulative >= CAMPAIGN_BELT_USD) {
    console.log(`\nBELT REACHED at $${cumulative.toFixed(4)} — stopping before '${clusterId}'.`);
    break;
  }
  const capUsd = LEG_CAP_USD[clusterId] ?? 6;
  if (DRY) {
    console.log(`  ${clusterId.padEnd(22)} would run, leg cap $${capUsd.toFixed(2)}`);
    continue;
  }
  const started = Date.now();
  try {
    const res = await frontierPlatformSweepHandler(
      { clusterId, capUsd },
      { db: handle.db, dbHandle: handle, pricesPath: `${REPO}/prices.json` } as never,
    );
    cumulative += res.spendUsd;
    const line =
      `${clusterId.padEnd(22)} cand=${String(res.candidates.length).padStart(2)} ` +
      `exec=${String(res.executed).padStart(3)} cached=${String(res.cacheHits).padStart(3)} ` +
      `pts=${res.points} proj=$${res.projectedSpendUsd.toFixed(4)} ` +
      `spend=$${res.spendUsd.toFixed(4)} cum=$${cumulative.toFixed(4)}` +
      (res.droppedAnswerers.length > 0 ? ` DROPPED=${res.droppedAnswerers.join(',')}` : '');
    console.log(`  ${line}  (${((Date.now() - started) / 1000).toFixed(0)}s)`);
    ledger.push(line);
  } catch (err) {
    console.log(`  ${clusterId.padEnd(22)} REFUSED/FAILED: ${(err as Error).message}`);
    ledger.push(`${clusterId} FAILED: ${(err as Error).message}`);
  }
}

console.log('\n── ledger ─────────────────────────────────────────────────────');
for (const l of ledger) console.log('  ' + l);
console.log(`\nCAMPAIGN ACTUAL: $${cumulative.toFixed(4)} of $${CAMPAIGN_BELT_USD.toFixed(2)} belt`);
await handle.close();
