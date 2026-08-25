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
// A failed week must not fail silently (audit 2026-08-22): any uncaught
// error posts one line to the research log page and exits non-zero. The
// success path already posts its own entry at the end.
for (const signal of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(signal, (err: unknown) => {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error(`observatory week FAILED (${signal}): ${msg}`);
    const done = () => process.exit(1);
    if (DRY || !process.env.NOTION_API_KEY || !process.env.NOTION_PAGE_ID) return done();
    import('@potion/workers')
      .then((w) => w.postNoteLine({ token: process.env.NOTION_API_KEY!, pageId: process.env.NOTION_PAGE_ID! }, `⚠ Observatory week failed at ${new Date().toISOString()}: ${msg.slice(0, 600)}`))
      .then((r) => console.error(r))
      .finally(done);
  });
}

const STORE = process.env.OBSERVATORY_DB ?? `${REPO}/.pglite/platform-sweep-step5`;
const ART = process.env.OBSERVATORY_ARTIFACTS ?? `${REPO}/artifacts/observatory`;
mkdirSync(`${ART}/runs`, { recursive: true });

const { createDb, migrate, upsertBudget, mtdSpendUsd, orgs, getLatestFrontier, addScannedModels, seedModelRegistry } =
  await import('@potion/db');
const { loadPrices, fetchOpenRouterModels, diffModelListings, createProviders } = await import('@potion/providers');
const W = await import('@potion/workers');
const {
  frontierPlatformSweepHandler, PLATFORM_OPS_ORG_ID, PLATFORM_SUITE_BY_CLUSTER,
  isoWeek, envelopeFor, planLanes, canaryTarget, driftVerdict, saturationVerdict, rankCandidates, digestLine, isFreeTier, postObservatoryEntry,
  CANARY_CAP_USD, AUDITION_CAP_USD, CANARY_SAMPLE_N, OBSERVATORY_ENVELOPE_USD, runFrontierNotes, postNoteLine,
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
// The belt is the ENVELOPE remainder — the real monthly limit — not the sum of
// expected lane costs: per-run caps are pessimistic ceilings, actuals are
// ledgered, and this hard stop is what makes the envelope a belt.
if (!DRY) {
  await upsertBudget(handle.db, { orgId: PLATFORM_OPS_ORG_ID, monthlyCapUsd: opsBefore + envelopeBefore.remainingUsd, hardStop: true, warnPct: 80 });
}
const ctx = { db: handle.db, dbHandle: handle, pricesPath: process.env.POTION_PRICES_PATH! } as never;
const { table: prices } = loadPrices(process.env.POTION_PRICES_PATH!);
// The sweep prefers the store's db registry over the price file. A store whose
// registry holds only what past auditions inserted would fail class
// representation for EVERY lane (second live week, 2026-08-22) — seed the full
// table first; seeding never clobbers, so audited candidates keep their rows.
if (!DRY) await seedModelRegistry(handle.db, prices);

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
    const sample = (res.sampled ?? []).find((x) => x.strategyHash === target.strategyHash) ?? null;
    const n = sample?.n ?? 0;
    const verdict = sample
      ? driftVerdict({ quality: target.quality, qualityCi95: target.evidence?.qualityCi95 ?? 0 }, { meanQuality: sample.meanQuality, n })
      : { verdict: 'inconclusive' as const, lowerBound: Number.NaN };
    canaries.push({ clusterId, model, strategyHash: target.strategyHash, storedQuality: target.quality, storedCi95: target.evidence?.qualityCi95 ?? 0, observedMean: sample?.meanQuality ?? null, n, verdict: verdict.verdict, spendUsd: res.spendUsd, ...(sample ? {} : { error: 'no scored cells for the target strategy' }) });
    ledgerAppend({ at: NOW.toISOString(), week, lane: 'canary', spendUsd: res.spendUsd, detail: `${clusterId}/${model}` });
    console.log(`  canary ${clusterId.padEnd(22)} ${model.padEnd(28)} q ${sample ? sample.meanQuality.toFixed(3) : '  —  '} (n=${n}) vs stored ${target.quality.toFixed(3)} ±${(target.evidence?.qualityCi95 ?? 0).toFixed(3)} → ${verdict.verdict.toUpperCase()}  ($${res.spendUsd.toFixed(4)}, published=${res.published})`);
    if (res.published) throw new Error(`INVARIANT: a canary published a frontier on ${clusterId} — publish:false is broken`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    canaries.push({ clusterId, model, strategyHash: target.strategyHash, storedQuality: target.quality, storedCi95: target.evidence?.qualityCi95 ?? 0, observedMean: null, n: 0, verdict: 'inconclusive', spendUsd: 0, error: msg });
    console.log(`  canary ${clusterId.padEnd(22)} ERROR ${msg.slice(0, 140)}`);
  }
}

// ---- lane 1a: saturation alarm (A3, 2026-08-24; $0 — stored frontiers only) ----
// An instrument whose champion never fails has stopped measuring; this lane
// says so every week instead of waiting for a human to get suspicious.
type ClusterSaturation = import('@potion/workers').ClusterSaturation;
const saturation: ClusterSaturation[] = [];
for (const clusterId of clusters) {
  const frontier = await getLatestFrontier(handle.db, clusterId, null);
  if (!frontier || frontier.points.length === 0) continue;
  const s = saturationVerdict(frontier.points);
  saturation.push({ clusterId, ...s });
  if (s.verdict !== 'ok') {
    console.log(`  saturation ${clusterId.padEnd(22)} ${s.verdict.toUpperCase().padEnd(9)} top ${s.topQuality.toFixed(3)}, ${s.crowdedTop} within 0.02 of it${s.verdict === 'saturated' ? ' — hardening due' : ''}`);
  }
}

// ---- lane 1b: budget canaries (2026-08-23) ----
// A frontier point is a claim under the conditions the customer uses it in,
// and the harness never varied the output budget. Found live: the extraction
// pick, a reasoning model, returns nothing under max_tokens 120–800. Every
// pick the canary measured this week is re-run on CANARY_BUDGET_N items at
// CANARY_BUDGET_TOKENS; a collapse of quality there is a budget-blind point,
// recorded on the run and said in the digest. Spend ≈ a quarter of lane 1.
type BudgetCanary = import('@potion/workers').BudgetCanary;
const CANARY_BUDGET_TOKENS = 256;
const CANARY_BUDGET_N = 2;
const budgetCanaries: BudgetCanary[] = [];
for (const c of canaries) {
  if (c.n === 0 || c.error) continue;
  if (DRY) { console.log(`  budget ${c.clusterId.padEnd(22)} would re-run ${c.model} on ${CANARY_BUDGET_N} items at max_tokens ${CANARY_BUDGET_TOKENS}`); continue; }
  try {
    const res = await frontierPlatformSweepHandler(
      { clusterId: c.clusterId, capUsd: CANARY_CAP_USD / 2, maxAnswerers: 1, auditionModels: [c.model], sampleN: CANARY_BUDGET_N, publish: false, cacheSalt: `${week}-b${CANARY_BUDGET_TOKENS}`, maxOutputTokens: CANARY_BUDGET_TOKENS },
      ctx,
    );
    const sample = (res.sampled ?? []).find((x) => x.strategyHash === c.strategyHash) ?? null;
    const n = sample?.n ?? 0;
    // Two items cannot prove drift; they can prove an answer that is not there.
    const verdict: BudgetCanary['verdict'] = !sample || n === 0 ? 'inconclusive' : sample.meanQuality < c.storedQuality / 2 ? 'budget-blind' : 'ok';
    budgetCanaries.push({ clusterId: c.clusterId, model: c.model, strategyHash: c.strategyHash, storedQuality: c.storedQuality, observedMean: sample?.meanQuality ?? null, n, budgetTokens: CANARY_BUDGET_TOKENS, verdict, spendUsd: res.spendUsd });
    ledgerAppend({ at: NOW.toISOString(), week, lane: 'budget-canary', spendUsd: res.spendUsd, detail: `${c.clusterId}/${c.model}@${CANARY_BUDGET_TOKENS}` });
    console.log(`  budget ${c.clusterId.padEnd(22)} ${c.model.padEnd(28)} q ${sample ? sample.meanQuality.toFixed(3) : '  —  '} (n=${n}) at ${CANARY_BUDGET_TOKENS} tokens vs stored ${c.storedQuality.toFixed(3)} → ${verdict}  $${res.spendUsd.toFixed(4)}`);
    if (res.published) throw new Error(`INVARIANT: a budget canary published a frontier on ${c.clusterId} — publish:false is broken`);
  } catch (e) {
    budgetCanaries.push({ clusterId: c.clusterId, model: c.model, strategyHash: c.strategyHash, storedQuality: c.storedQuality, observedMean: null, n: 0, budgetTokens: CANARY_BUDGET_TOKENS, verdict: 'inconclusive', spendUsd: 0, error: e instanceof Error ? e.message : String(e) });
    console.log(`  budget ${c.clusterId.padEnd(22)} ${c.model} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
const budgetBlind = budgetCanaries.filter((b) => b.verdict === 'budget-blind');
if (budgetBlind.length > 0) console.log(`  budget-blind points: ${budgetBlind.map((b) => `${b.clusterId}/${b.model}`).join(', ')}`);

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
      // The research store's registry may be EMPTY (the sweep then reads the
      // price file). Inserting a lone candidate would make the db registry
      // consist of one model and fail class representation — seed from the
      // table first so the candidate JOINS the roster (first live week, 2026-08-22).
      await addScannedModels(handle.db, [r.entry] as never, `${prices.version}+obs-${week}`);
      // Measure first WITHOUT publishing; a frontier version moves only when
      // the candidate actually lands on it (the republish is then a \$0 cache hit).
      let res = await frontierPlatformSweepHandler(
        { clusterId: r.clusterId, capUsd: AUDITION_CAP_USD, maxAnswerers: 1, auditionModels: [r.entry.alias], publish: false },
        ctx,
      );
      const measured = res.candidates.length > 0 && res.executed + res.cacheHits > 0;
      let earned = (res.frontierPoints ?? []).some((p) => (p.strategyConfig as { model?: string }).model === r.entry.alias);
      if (measured && earned) {
        res = await frontierPlatformSweepHandler(
          { clusterId: r.clusterId, capUsd: AUDITION_CAP_USD, maxAnswerers: 1, auditionModels: [r.entry.alias] },
          ctx,
        );
        earned = (res.frontierPoints ?? []).some((p) => (p.strategyConfig as { model?: string }).model === r.entry.alias);
      }
      if (!measured) {
        // Contained at the first call (provider error) — the candidate is not
        // servable as listed. A published null, not a crash and not a slot.
        auditions.push({ alias: r.entry.alias, clusterId: r.clusterId, lane: r.lane, why: r.why, spendUsd: res.spendUsd, earnedSlot: null, frontierVersion: null, error: 'not measurable: provider refused the model at the first call' });
        console.log(`           not measurable on ${r.clusterId}: provider refused the model at the first call ($${res.spendUsd.toFixed(4)})`);
      } else {
        auditions.push({ alias: r.entry.alias, clusterId: r.clusterId, lane: r.lane, why: r.why, spendUsd: res.spendUsd, earnedSlot: earned, frontierVersion: res.frontierVersion });
        console.log(`           ${earned ? 'EARNED A SLOT' : 'did not earn a slot'} on ${r.clusterId} (frontier v${res.frontierVersion ?? '—'}, $${res.spendUsd.toFixed(4)})`);
      }
      ledgerAppend({ at: NOW.toISOString(), week, lane: 'audition', spendUsd: res.spendUsd, detail: `${r.entry.alias}@${r.clusterId}` });
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
const spendUsd = [...canaries, ...budgetCanaries, ...auditions].reduce((s, r) => s + r.spendUsd, 0);
const run = {
  week, at: NOW.toISOString(), envelopeBefore, plan, canaries, budgetCanaries, auditions, catalogue, saturation, spendUsd,
  envelopeAfter: envelopeFor(ledger, NOW),
};
if (!DRY) {
  writeFileSync(`${ART}/runs/${week}.json`, JSON.stringify(run, null, 1) + '\n');
// Coverage ratchet (rung 5): the monthly artifact, refreshed every week.
if (!DRY) {
  const { writeRatchet } = await import('./observatory-ratchet.ts');
  console.log(`ratchet: ${writeRatchet(ART, process.env.POTION_PRICES_PATH!, NOW)}`);
}
  appendFileSync(`${ART}/digest.md`, `- ${digestLine(run)}${budgetBlind.length > 0 ? ` · ${budgetBlind.length} budget-blind` : ''}\n`);
}
console.log(`\n${digestLine(run)}`);
if (!DRY && process.env.NOTION_API_KEY && process.env.NOTION_PAGE_ID) {
  console.log(await postObservatoryEntry({ token: process.env.NOTION_API_KEY, pageId: process.env.NOTION_PAGE_ID }, run));
}

// ---- Frontier Notes: the week's issue, from this run + the replay lane ----
// docs/FRONTIER-NOTES.md. Writes ${ART}/notes/${week}.{json,md}; the
// dashboard serves that directory. Held (never published) on any redaction
// hit or when FRONTIER_NOTES_GATE=1. Writer cost is ledgered like every
// other research dollar.
if (!DRY) {
  try {
    const key = process.env.OPENROUTER_API_KEY;
    const writer = key
      ? { provider: createProviders({ prices, apiKeys: { openrouter: key }, timeoutMs: 120_000 }).openrouter, model: process.env.FRONTIER_NOTES_WRITER ?? 'or-sonnet' }
      : undefined;
    const byline = process.env.FRONTIER_NOTES_BYLINE;
    // Dogfood: the issue is written THROUGH Potion's own API when a serving
    // key is present (POTION_SELF_KEY); the provider writer is the fallback.
    const potion = process.env.POTION_SELF_KEY ? { url: process.env.POTION_API_URL ?? 'http://server:3000', apiKey: process.env.POTION_SELF_KEY, policy: process.env.FRONTIER_NOTES_POLICY ?? 'frontier-notes-writer', cluster: process.env.FRONTIER_NOTES_CLUSTER ?? 'creative' } : undefined;
    const notes = await runFrontierNotes({
      run: run as never,
      ...(potion ? { potion } : {}),
      db: handle.db as never,
      pricesVersion: prices.version,
      notesDir: `${ART}/notes`,
      now: NOW,
      ...(writer ? { writer } : {}),
      ...(byline ? { byline } : {}),
      gate: process.env.FRONTIER_NOTES_GATE === '1',
      extraNeverName: (process.env.FRONTIER_NOTES_NEVER_NAME ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    });
    console.log(notes.digest);
    if (notes.issue.writer && notes.issue.writer.costUsd > 0) {
      ledgerAppend({ at: NOW.toISOString(), week, lane: 'canary', spendUsd: notes.issue.writer.costUsd, detail: `frontier-notes/${notes.issue.writer.model}` });
    }
    if (process.env.NOTION_API_KEY && process.env.NOTION_PAGE_ID) {
      console.log(await postNoteLine({ token: process.env.NOTION_API_KEY, pageId: process.env.NOTION_PAGE_ID }, `${notes.digest} · ${process.env.POTION_APP_URL ?? 'https://app.withpotion.com'}/research/${notes.issue.slug}`));
    }
  } catch (e) {
    console.log(`frontier notes: failed — ${e instanceof Error ? e.message : String(e)}`);
  }
}
await handle.close();
