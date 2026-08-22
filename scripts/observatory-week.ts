// THE OBSERVATORY — weekly run (docs/OBSERVATORY.md; logic in
// packages/workers/src/observatory.ts). Canaries first, then auditions,
// inside the monthly envelope; every dollar ledgered; nulls published.
//
//   KEY_RISK_ACCEPTED=YYYY-MM-DD OBSERVATORY_DB=/path/to/research-store \
//     node ~/.local/bin/pnpm exec tsx scripts/observatory-week.ts [--dry]
//
// --dry plans and prints without spending a cent (no provider calls).
//
// Runs against the RESEARCH store (the content-addressed eval cache), never
// the serving database: incumbents re-aggregate at $0 from cache, and a
// research run can never touch a partner's serving state. Publishes only
// what an audition EARNS (a candidate landing on a cluster's frontier);
// canaries never publish (publish:false).
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry');
const NOW = new Date();

// ---- env, loaded the way tranche-measure loads it (.env, not .env.prod) ----
if (existsSync(`${REPO}/.env`)) {
  for (const line of readFileSync(`${REPO}/.env`, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, '');
  }
}
for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY']) delete process.env[k];
if (!DRY && !process.env.KEY_RISK_ACCEPTED) {
  throw new Error('REFUSING to spend: set KEY_RISK_ACCEPTED=YYYY-MM-DD (or pass --dry)');
}
process.env.POTION_EVAL_PROVIDER = 'live';
process.env.POTION_PROVIDER_TIMEOUT_MS = process.env.POTION_PROVIDER_TIMEOUT_MS ?? '180000';
process.env.POTION_PRICES_PATH = process.env.POTION_PRICES_PATH ?? `${REPO}/prices.json`;
const STORE = process.env.OBSERVATORY_DB ?? `${REPO}/.pglite/platform-sweep-step5`;
const ART = process.env.OBSERVATORY_ARTIFACTS ?? `${REPO}/artifacts/observatory`;
mkdirSync(`${ART}/runs`, { recursive: true });

const { createDb, migrate, upsertBudget, mtdSpendUsd, orgs, getLatestFrontier, addScannedModels } =
  await import('@potion/db');
const { loadPrices, fetchOpenRouterModels, diffModelListings } = await import('@potion/providers');
const W = await import('@potion/workers');
const {
  frontierPlatformSweepHandler, PLATFORM_OPS_ORG_ID, PLATFORM_SUITE_BY_CLUSTER,
  isoWeek, envelopeFor, planLanes, canaryTarget, driftVerdict, rankCandidates, digestLine, isFreeTier,
  CANARY_CAP_USD, AUDITION_CAP_USD, CANARY_SAMPLE_N, OBSERVATORY_ENVELOPE_USD,
} = W;
type LedgerRow = W.LedgerRow;
type CanaryResult = W.CanaryResult;
type AuditionResult = W.AuditionResult;

// ---- ledger + envelope ----
const LEDGER = `${ART}/ledger.jsonl`;
const ledger: LedgerRow[] = existsSync(LEDGER)
  ? readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as LedgerRow)
  : [];
const week = isoWeek(NOW);
const envelopeBefore = envelopeFor(ledger, NOW);
const clusters = Object.keys(PLATFORM_SUITE_BY_CLUSTER).sort();
const plan = planLanes(envelopeBefore, clusters);
const ledgerAppend = (row: LedgerRow) => {
  ledger.push(row);
  if (!DRY) appendFileSync(LEDGER, JSON.stringify(row) + '\n');
};

console.log(`── Observatory ${week} ${DRY ? '(DRY — no spend)' : ''} ──`);
console.log(`envelope: $${envelopeBefore.mtdUsd.toFixed(2)} of $${envelopeBefore.capUsd} used this month → $${envelopeBefore.remainingUsd.toFixed(2)} remaining`);
console.log(`plan: ${plan.canaryClusters.length} canaries ($${plan.canaryBudgetUsd.toFixed(2)}), ${plan.auditions} auditions ($${plan.auditionBudgetUsd.toFixed(2)})`);
for (const n of plan.notes) console.log(`  note: ${n}`);

// ---- db: the research store; the ops org's belt = this run's allowance ----
const handle = await createDb(`pglite://${STORE}`);
await migrate(handle.db);
await handle.db.insert(orgs).values({ id: PLATFORM_OPS_ORG_ID, name: 'platform ops' }).onConflictDoNothing();
const opsBefore = await mtdSpendUsd(handle.db, PLATFORM_OPS_ORG_ID, NOW);
const allowance = plan.canaryBudgetUsd + plan.auditionBudgetUsd;
if (!DRY) {
  await upsertBudget(handle.db, { orgId: PLATFORM_OPS_ORG_ID, monthlyCapUsd: opsBefore + allowance, hardStop: true, warnPct: 80 });
}
const ctx = { db: handle.db, dbHandle: handle, pricesPath: process.env.POTION_PRICES_PATH! } as never;
const { table: prices } = loadPrices(process.env.POTION_PRICES_PATH!);

// ---- lane 1: canaries ----
const canaries: CanaryResult[] = [];
const routedCostByCluster: Record<string, number> = {};
for (const clusterId of clusters) {
  const frontier = await getLatestFrontier(handle.db, clusterId, null);
  const target = frontier ? canaryTarget(frontier.points) : null;
  if (!frontier || !target) {
    console.log(`  canary ${clusterId.padEnd(22)} no platform frontier — nothing to watch`);
    continue;
  }
  routedCostByCluster[clusterId] = target.costPer1K;
  const model = (target.strategyConfig as { model?: string }).model;
  if (!model) {
    console.log(`  canary ${clusterId.padEnd(22)} routed pick is a composite (${target.strategyHash.slice(0, 8)}) — composites are canaried via their stages in a later rung`);
    continue;
  }
  if (!plan.canaryClusters.includes(clusterId)) {
    canaries.push({ clusterId, model, strategyHash: target.strategyHash, storedQuality: target.quality, storedCi95: target.evidence?.qualityCi95 ?? 0, observedMean: null, n: 0, verdict: 'inconclusive', spendUsd: 0, error: 'skipped: envelope' });
    continue;
  }
  if (DRY) {
    console.log(`  canary ${clusterId.padEnd(22)} would re-run ${model} on ${CANARY_SAMPLE_N} items (stored q ${target.quality.toFixed(3)} ±${(target.evidence?.qualityCi95 ?? 0).toFixed(3)})`);
    continue;
  }
  try {
    const res = await frontierPlatformSweepHandler(
      { clusterId, capUsd: CANARY_CAP_USD, maxAnswerers: 1, auditionModels: [model], sampleN: CANARY_SAMPLE_N, publish: false, cacheSalt: week },
      ctx,
    );
    const observed = res.frontierPoints.find((p) => p.strategyHash === target.strategyHash) ?? res.frontierPoints[0] ?? null;
    const n = observed?.evidence?.n ?? res.itemCount;
    const verdict = observed
      ? driftVerdict({ quality: target.quality, qualityCi95: target.evidence?.qualityCi95 ?? 0 }, { meanQuality: observed.quality, n })
      : { verdict: 'inconclusive' as const, lowerBound: Number.NaN };
    canaries.push({ clusterId, model, strategyHash: target.strategyHash, storedQuality: target.quality, storedCi95: target.evidence?.qualityCi95 ?? 0, observedMean: observed?.quality ?? null, n, verdict: verdict.verdict, spendUsd: res.spendUsd });
    ledgerAppend({ at: NOW.toISOString(), week, lane: 'canary', spendUsd: res.spendUsd, detail: `${clusterId}/${model}` });
    console.log(`  canary ${clusterId.padEnd(22)} ${model.padEnd(28)} q ${observed?.quality.toFixed(3) ?? '  —  '} vs stored ${target.quality.toFixed(3)} → ${verdict.verdict.toUpperCase()}  ($${res.spendUsd.toFixed(4)}, published=${res.published})`);
    if (res.published) throw new Error(`INVARIANT: a canary published a frontier on ${clusterId} — publish:false is broken`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    canaries.push({ clusterId, model, strategyHash: target.strategyHash, storedQuality: target.quality, storedCi95: target.evidence?.qualityCi95 ?? 0, observedMean: null, n: 0, verdict: 'inconclusive', spendUsd: 0, error: msg });
    console.log(`  canary ${clusterId.padEnd(22)} ERROR ${msg.slice(0, 140)}`);
  }
}

// ---- lane 2: auditions (catalogue read-only; registry grows only by what we audition) ----
const auditions: AuditionResult[] = [];
let catalogue = { listings: 0, newSinceRegistry: 0, skippedNoPricing: 0, freeTierExcluded: 0, ranked: 0 };
try {
  const listings = await fetchOpenRouterModels({ apiKey: process.env.OPENROUTER_API_KEY! });
  const diff = diffModelListings(listings, prices);
  const ranked = rankCandidates(diff.added, routedCostByCluster, plan.auditions);
  const freeTierExcluded = diff.added.filter(isFreeTier).length;
  catalogue = { listings: listings.length, newSinceRegistry: diff.added.length, skippedNoPricing: diff.skippedNoPricing.length, freeTierExcluded, ranked: ranked.length };
  console.log(`catalogue: ${listings.length} listings, ${diff.added.length} not in the registry (${freeTierExcluded} free-tier excluded), ${ranked.length} ranked for audition`);
  for (const r of ranked) {
    console.log(`  audition ${r.entry.alias.padEnd(34)} → ${r.clusterId.padEnd(20)} ${r.why}`);
    if (DRY) continue;
    try {
      await addScannedModels(handle.db, [r.entry] as never, `${prices.version}+obs-${week}`);
      const res = await frontierPlatformSweepHandler(
        { clusterId: r.clusterId, capUsd: AUDITION_CAP_USD, maxAnswerers: 1, auditionModels: [r.entry.alias] },
        ctx,
      );
      const earned = res.frontierPoints.some((p) => (p.strategyConfig as { model?: string }).model === r.entry.alias);
      auditions.push({ alias: r.entry.alias, clusterId: r.clusterId, lane: r.lane, why: r.why, spendUsd: res.spendUsd, earnedSlot: earned, frontierVersion: res.frontierVersion });
      ledgerAppend({ at: NOW.toISOString(), week, lane: 'audition', spendUsd: res.spendUsd, detail: `${r.entry.alias}@${r.clusterId}` });
      console.log(`           ${earned ? 'EARNED A SLOT' : 'did not earn a slot'} on ${r.clusterId} (frontier v${res.frontierVersion ?? '—'}, $${res.spendUsd.toFixed(4)})`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      auditions.push({ alias: r.entry.alias, clusterId: r.clusterId, lane: r.lane, why: r.why, spendUsd: 0, earnedSlot: null, frontierVersion: null, error: msg });
      console.log(`           ERROR ${msg.slice(0, 160)}`);
    }
  }
} catch (e) {
  console.log(`catalogue: unavailable (${e instanceof Error ? e.message : String(e)}) — auditions skipped this week`);
}

// ---- the record: nulls are published ----
const spendUsd = [...canaries, ...auditions].reduce((s, r) => s + r.spendUsd, 0);
const run = {
  week, at: NOW.toISOString(), envelopeBefore, plan, canaries, auditions, catalogue, spendUsd,
  envelopeAfter: envelopeFor(ledger, NOW),
};
if (!DRY) {
  writeFileSync(`${ART}/runs/${week}.json`, JSON.stringify(run, null, 1) + '\n');
  appendFileSync(`${ART}/digest.md`, `- ${digestLine(run)}\n`);
}
console.log(`\n${digestLine(run)}`);
await handle.close();
