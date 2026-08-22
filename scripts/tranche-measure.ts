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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
// TRANCHE_BELT_USD lets a targeted rerun inherit the REMAINDER of a prior
// campaign's authorization instead of a fresh $60.
const CAMPAIGN_BELT_USD = Number(process.env.TRANCHE_BELT_USD ?? 60);
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
  // code-review raised 21 -> 30 at suite adoption: code-review-hard-v1 is 28
  // items against the old suite's 14, and 12 of them still pay judge calls.
  // The preflight's projection is the real gate; this cap just has to sit
  // above an honest projection rather than refuse the leg outright.
  'rewrite-edit': 21, 'code-review': 30, creative: 21,
};

// LEG ORDER — spend first where the measurement can actually rank what it
// measures. This used to be Object.keys(PLATFORM_SUITE_BY_CLUSTER), i.e. the
// declaration order of a lookup table, which is not an ordering anyone chose:
// it put the three weakest instruments first and burned the belt before
// reaching the strongest. Ordered here by each cluster's measured resolving
// power — its quality spread across the committed frontier against the CI its
// own evidence carries (packages/db/baseline/platform-frontiers.json).
const LEG_ORDER: string[] = [
  'multi-step-reasoning', // spread 0.520 vs CI +-0.112 — the ONE cluster whose
                          // quality differences its own evidence resolves
  'rag-answer',           // 0.160 / +-0.083
  'summarization',        // 0.129 / +-0.066
  'creative',             // 0.121 / +-0.085
  'agentic-tool-use',     // 0.114 / +-0.059
  'rewrite-edit',         // 0.079 / +-0.064
  // FORMER CEILING CLUSTERS — the *-hard-v1 suites were ADOPTED into
  // PLATFORM_SUITE_BY_CLUSTER on 2026-08-20, so the next sweep of each
  // measures on the hardened instrument, from zero cache (new suite = new
  // content hashes). They stay last for ONE more campaign — their old
  // resolving-power numbers are meaningless now and their new ones do not
  // exist yet. Re-derive this order from the first hard-suite frontiers.
  'code-gen',
  'extraction',
  'classification',
  'code-review',
];

// The order IS the spend plan, so a cluster missing from it is silently never
// measured. Both directions, so adding a taxonomy cluster fails loudly here
// rather than quietly dropping a leg.
{
  const mapped = Object.keys(PLATFORM_SUITE_BY_CLUSTER);
  const missing = mapped.filter((c) => !LEG_ORDER.includes(c));
  const unknown = LEG_ORDER.filter((c) => !mapped.includes(c));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `LEG_ORDER is out of sync with PLATFORM_SUITE_BY_CLUSTER — ` +
      `never measured: [${missing.join(', ')}]; not a cluster: [${unknown.join(', ')}]`,
    );
  }
}

// PER-LEG DURABILITY. Two campaigns lost completed legs because the only
// copy lived in a PGlite directory that an interrupted process corrupts.
// Each leg is now written to its own file the instant it lands, so the
// database is a cache and the files are the record.
const LEGS_DIR = `${REPO}/.tranche/legs`;
mkdirSync(LEGS_DIR, { recursive: true });

// TRANCHE_ONLY=creative,rewrite-edit reruns just the named legs. The belt
// and order machinery stay in force; everything else is skipped, not run at
// $0 — a skipped leg's published frontier is untouched.
const only = process.env.TRANCHE_ONLY
  ? process.env.TRANCHE_ONLY.split(',').map((c) => c.trim()).filter(Boolean)
  : null;
if (only) {
  const unknown = only.filter((c) => !LEG_ORDER.includes(c));
  if (unknown.length > 0) throw new Error(`TRANCHE_ONLY names unknown clusters: ${unknown.join(', ')}`);
  console.log(`TARGETED RERUN: ${only.join(', ')} (belt $${CAMPAIGN_BELT_USD})`);
}

let cumulative = 0;
for (const clusterId of LEG_ORDER) {
  if (only && !only.includes(clusterId)) continue;
  if (cumulative >= CAMPAIGN_BELT_USD) {
    console.log(`\nBELT REACHED at $${cumulative.toFixed(4)} — stopping before '${clusterId}'.`);
    break;
  }
  // The belt was checked only BETWEEN legs, so the last leg to start could
  // carry total spend to belt + its own cap — and reordering makes that worse,
  // because it moves the most expensive legs (code-gen $45, extraction $39)
  // to the END, where the remaining belt is smallest. Clamping the leg's cap
  // to what is left makes the belt mean what its name says. A leg that cannot
  // fit is refused whole by the harness preflight, which is the right outcome:
  // a partially swept cluster would publish a frontier built from an
  // incomplete candidate set.
  const remainingBelt = CAMPAIGN_BELT_USD - cumulative;
  const legCap = Math.min(LEG_CAP[clusterId] ?? 14, remainingBelt);
  if (legCap < (LEG_CAP[clusterId] ?? 14)) {
    console.log(
      `  ${clusterId.padEnd(22)} cap clamped $${(LEG_CAP[clusterId] ?? 14).toFixed(2)} -> ` +
      `$${legCap.toFixed(2)} (belt remainder)`,
    );
  }
  const t0 = Date.now();
  try {
    const res = await frontierPlatformSweepHandler(
      { clusterId, capUsd: legCap, maxAnswerers: MAX_ANSWERERS },
      { db: handle.db, dbHandle: handle, pricesPath: process.env.POTION_PRICES_PATH! } as never,
    );
    cumulative += res.spendUsd;
    // Write BEFORE logging: if anything kills this process in the next
    // millisecond, the leg is already on disk.
    writeFileSync(
      `${LEGS_DIR}/${clusterId}.json`,
      JSON.stringify(
        {
          clusterId,
          frontierId: res.frontierId,
          frontierVersion: res.frontierVersion,
          pricesVersion: JSON.parse(readFileSync(process.env.POTION_PRICES_PATH!, 'utf8')).version,
          spendUsd: res.spendUsd,
          candidates: res.candidates,
          failedCandidates: res.failedCandidates,
          points: res.frontierPointsFull,
          capturedAt: new Date().toISOString(),
        },
        null,
        2,
      ) + '\n',
    );
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
