// multi-step-reasoning re-measurement leg (2026-09-07).
//
// WHY: the flat multi-step-reasoning suite scored the WHOLE answer against a
// bare gold value under prompts that ask the model to "Solve step by step", so
// frontier v3 ranked output-format obedience rather than arithmetic (gpt-4.1 at
// 0.56 on grade-school sums). This leg re-measures the SAME nine frontier
// models on suites/v2/multi-step-reasoning-v2, whose answer-format demand sits
// on one labelled last line that the scorer reads.
//
// The v2 item ids are NEW (msr2-NNN), so no v1 cache cell can resume into this
// run — cacheKeyOf hashes the item id, not the prompt or the scoring. The salt
// below is belt-and-braces on top of that.
//
//   KEY_RISK_ACCEPTED=2026-09-07 npx tsx scripts/msr-v2-leg.ts
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(`${REPO}/.env`)) {
  const fs = await import('node:fs');
  for (const line of fs.readFileSync(`${REPO}/.env`, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^"|"$/g, '');
  }
}
for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY']) delete process.env[k];
if (!process.env.KEY_RISK_ACCEPTED) throw new Error('live spend: set KEY_RISK_ACCEPTED=<date>');
process.env.POTION_EVAL_PROVIDER = 'live';
process.env.POTION_PROVIDER_TIMEOUT_MS = process.env.POTION_PROVIDER_TIMEOUT_MS ?? '180000';
process.env.POTION_PRICES_PATH = `${REPO}/prices.json`;

const SCRATCH = process.env.MSR_SCRATCH ?? '/private/tmp/claude-501/-Users-kavonbadie-Downloads-potion/706d03b2-0722-4e36-b908-18e0e34887bf/scratchpad';
const STORE = process.env.MSR_STORE ?? `${SCRATCH}/pglite-msr-v2`;
const ART = `${SCRATCH}/msr-v2`;
const CAP = Number(process.env.MSR_CAP_USD ?? 3);
const BELT = CAP + 2;
const PUBLISH = process.env.MSR_PUBLISH !== '0';

const { createDb, migrate, upsertBudget, mtdSpendUsd, orgs } = await import('@potion/db');
const { frontierPlatformSweepHandler, PLATFORM_OPS_ORG_ID } = await import('@potion/workers');
const { strategyHash } = await import('@potion/core');

// The nine points of platform-frontiers.json cluster multi-step-reasoning v3.
// The nine baseline points PLUS or-ling-3.0-flash: the served prod frontier
// (multi-step-reasoning v5) carries ling as an operating point, and a
// promotion that dropped it un-measured would be a frontier regression —
// under min_cost floor 0.9 prod routes to ling today.
const MODELS = ['or-solar-pro4','or-deepseek-v4-flash-0731','or-nemotron-3.5-lightning','or-gpt-full',
  'or-gemini-flash','or-inkling-small','or-gemini-3.7-flash','or-inkling','or-kimi-k3',
  'or-ling-3.0-flash'];

const handle = await createDb(`pglite://${STORE}`);
await migrate(handle.db);
await handle.db.insert(orgs).values({ id: PLATFORM_OPS_ORG_ID, name: 'platform ops' }).onConflictDoNothing();
const before = await mtdSpendUsd(handle.db, PLATFORM_OPS_ORG_ID, new Date());
await upsertBudget(handle.db, { orgId: PLATFORM_OPS_ORG_ID, monthlyCapUsd: before + BELT, hardStop: true, warnPct: 80 });
const ctx = { db: handle.db, dbHandle: handle, pricesPath: process.env.POTION_PRICES_PATH! } as never;

console.log(`msr-v2 leg: ${MODELS.length} singles · suite multi-step-reasoning-v2 · cap $${CAP} · belt $${BELT} · publish=${PUBLISH}`);
console.log(`store ${STORE}`);
const t0 = Date.now();
const res = await frontierPlatformSweepHandler(
  {
    clusterId: 'multi-step-reasoning',
    suiteOverride: { kind: 'v2', suiteId: 'multi-step-reasoning-v2' },
    auditionModels: MODELS,
    maxAnswerers: MODELS.length,
    extraShapes: [],
    shapes: [],
    shapeBudget: 0,
    capUsd: CAP,
    instrument: 'default',
    publish: PUBLISH,
    cacheSalt: process.env.MSR_SALT ?? 'msr-v2-2026-09-07',
  },
  ctx,
);
const names = new Map<string, string>();
for (const m of MODELS) names.set(strategyHash({ type: 'single', model: m } as never), m);
const spendByHash = new Map((res.perCandidate ?? []).map((p: { strategyHash: string; evidenceSpendUsd: number }) => [p.strategyHash, p.evidenceSpendUsd]));

// v3's numbers, for the side-by-side that is the whole point of this leg.
const V3: Record<string, number> = { 'or-ling-3.0-flash': 0.96, 'or-solar-pro4': 0.50, 'or-deepseek-v4-flash-0731': 0.98,
  'or-nemotron-3.5-lightning': 0.76, 'or-gpt-full': 0.56, 'or-gemini-flash': 0.66,
  'or-inkling-small': 0.92, 'or-gemini-3.7-flash': 1.00, 'or-inkling': 0.94, 'or-kimi-k3': 0.96 };

console.log('\nmodel                             v3(format)  v2(correct)   delta    n   evidence$');
for (const s of [...(res.sampled ?? [])].sort((a: { meanQuality: number }, b: { meanQuality: number }) => b.meanQuality - a.meanQuality)) {
  const name = names.get(s.strategyHash) ?? s.strategyHash.slice(0, 10);
  const old = V3[name];
  const delta = old === undefined ? '    -' : `${s.meanQuality - old >= 0 ? '+' : ''}${(s.meanQuality - old).toFixed(3)}`;
  console.log(`${name.padEnd(32)} ${(old ?? NaN).toFixed(2).padStart(7)}     ${s.meanQuality.toFixed(3).padStart(6)}   ${delta.padStart(7)}  ${String(s.n).padStart(3)}  $${(spendByHash.get(s.strategyHash) ?? 0).toFixed(4)}`);
}
console.log(`\nspend $${Number(res.spendUsd ?? 0).toFixed(4)} (projected $${Number(res.projectedSpendUsd ?? 0).toFixed(4)}) · published=${String(res.published ?? false)} · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
mkdirSync(ART, { recursive: true });
writeFileSync(`${ART}/msr-v2-leg-result.json`, JSON.stringify({ res, names: [...names.entries()] }, null, 1));
console.log(`artifact ${ART}/msr-v2-leg-result.json`);
await handle.close?.();
