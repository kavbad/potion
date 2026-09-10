// GSM8K compile leg (2026-09-07): measure a 14-model audition + hand-authored
// and grammar-generated compositions on the gsm8k-v1 suite (150 TRAIN items),
// and publish the frontier for cluster "gsm8k" into an ISOLATED store. The
// benchmark then serves the held-out TEST split through the HTTP endpoint.
//   KEY_RISK_ACCEPTED=2026-09-07 npx tsx scripts/gsm8k-leg.ts
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { StrategyConfig } from '@potion/core';

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
// Both default OUTSIDE the repo: the store is a multi-GB pglite directory and
// the artifacts are run records, neither of which belongs in git. Override
// with GSM8K_STORE / GSM8K_ARTIFACTS to point at an existing warm store.
const SCRATCH = process.env.GSM8K_SCRATCH ?? `${tmpdir()}/potion-gsm8k`;
const STORE = process.env.GSM8K_STORE ?? `${SCRATCH}/pglite-sweep`;
const ART = process.env.GSM8K_ARTIFACTS ?? `${SCRATCH}/runs`;
const CAP = Number(process.env.GSM8K_CAP_USD ?? 20);
const BELT = CAP + 2;
const PUBLISH = process.env.GSM8K_PUBLISH !== '0';

const { createDb, migrate, upsertBudget, mtdSpendUsd, orgs } = await import('@potion/db');
const { frontierPlatformSweepHandler, PLATFORM_OPS_ORG_ID } = await import('@potion/workers');
const { strategyHash, StrategyConfigSchema } = await import('@potion/core');

const ALL_SINGLES = ['or-solar-pro4','or-ling-3.0-flash','or-nemotron-3.5-lightning','or-deepseek-v4-flash-0731','or-laguna-s-2.1','or-gemini-flash','or-gpt-mini','or-inkling-small','or-gemini-3.7-flash','or-deepseek','or-inkling','or-sonnet','or-kimi-k3','or-gpt-full'];
const SHORTLIST = process.env.GSM8K_SINGLES ? process.env.GSM8K_SINGLES.split(',') : ALL_SINGLES;
const call = (model: string) => ({ op: 'call', model });
const EXTRA = [
  { type: 'cascade', confidenceMethod: 'self-report-calibrated', stages: [ { model: 'or-solar-pro4', escalateIf: { confidenceBelow: 0.7 } }, { model: 'or-deepseek-v4-flash-0731', escalateIf: { confidenceBelow: 0.7 } }, { model: 'or-gemini-3.7-flash' } ] },
  { type: 'cascade', confidenceMethod: 'self-report-calibrated', stages: [ { model: 'or-deepseek-v4-flash-0731', escalateIf: { confidenceBelow: 0.7 } }, { model: 'or-gemini-3.7-flash' } ] },
  { type: 'program', name: 'agree-cheap-or-escalate', body: { op: 'if', check: { kind: 'agree', of: [call('or-ling-3.0-flash'), call('or-deepseek-v4-flash-0731')] }, then: { op: 'pick', of: [call('or-ling-3.0-flash'), call('or-deepseek-v4-flash-0731')], by: { kind: 'confidence' } }, else: call('or-gemini-3.7-flash') } },
  { type: 'program', name: 'agree-mid-or-sonnet', body: { op: 'if', check: { kind: 'agree', of: [call('or-deepseek-v4-flash-0731'), call('or-gemini-3.7-flash')] }, then: { op: 'pick', of: [call('or-deepseek-v4-flash-0731'), call('or-gemini-3.7-flash')], by: { kind: 'confidence' } }, else: call('or-sonnet') } },
  { type: 'program', name: 'vote-3-cheap', body: { op: 'vote', of: [call('or-solar-pro4'), call('or-ling-3.0-flash'), call('or-deepseek-v4-flash-0731')] } },
];
const SHAPE_IDX = process.env.GSM8K_SHAPES === undefined ? EXTRA.map((_, i) => i) : process.env.GSM8K_SHAPES.split(',').filter(Boolean).map(Number);
// The schema is the validator; the cast only reconciles optional-property
// variance — zod infers `k?: T | undefined`, which exactOptionalPropertyTypes
// will not assign to StrategyConfig's `k?: T`.
const extraShapes = SHAPE_IDX.map((i) => StrategyConfigSchema.parse(EXTRA[i]) as StrategyConfig);
const GRAMMAR = process.env.GSM8K_GRAMMAR === '1';

const handle = await createDb(`pglite://${STORE}`);
await migrate(handle.db);
await handle.db.insert(orgs).values({ id: PLATFORM_OPS_ORG_ID, name: 'platform ops' }).onConflictDoNothing();
const before = await mtdSpendUsd(handle.db, PLATFORM_OPS_ORG_ID, new Date());
await upsertBudget(handle.db, { orgId: PLATFORM_OPS_ORG_ID, monthlyCapUsd: before + BELT, hardStop: true, warnPct: 80 });
const ctx = { db: handle.db, dbHandle: handle, pricesPath: process.env.POTION_PRICES_PATH! } as never;

console.log(`leg [${process.env.GSM8K_CLUSTER ?? 'gsm8k'} / ${process.env.GSM8K_SUITE ?? 'gsm8k-v1'}]: ${SHORTLIST.length} singles + ${extraShapes.length} authored shapes + grammar shapes · cap $${CAP} · belt $${BELT} · publish=${PUBLISH} · store ${STORE}`);
const t0 = Date.now();
const res = await frontierPlatformSweepHandler(
  {
    clusterId: process.env.GSM8K_CLUSTER ?? 'gsm8k',
    suiteOverride: { kind: 'v2', suiteId: process.env.GSM8K_SUITE ?? 'gsm8k-v1' },
    auditionModels: SHORTLIST,
    maxAnswerers: SHORTLIST.length,
    extraShapes,
    shapes: GRAMMAR ? ['cascade', 'draft-verify', 'best-of-n', 'ensemble', 'composite'] : [],
    shapeBudget: GRAMMAR ? 8 : 0,
    p95CapMs: Number(process.env.GSM8K_P95_CAP_MS ?? 40000),
    capUsd: CAP,
    instrument: 'default',
    publish: PUBLISH,
    cacheSalt: process.env.GSM8K_SALT ?? 'gsm8k-leg-v2',
  },
  ctx,
);
const names = new Map<string, string>();
for (const m of SHORTLIST) names.set(strategyHash({ type: 'single', model: m } as never), m);
for (const e of extraShapes) names.set(strategyHash(e), (e as { name?: string }).name ?? `${e.type}:${JSON.stringify(e).slice(0, 60)}`);
for (const g of res.generatedShapes ?? []) names.set(g.strategyHash, g.template);
const spendByHash = new Map((res.perCandidate ?? []).map((p: { strategyHash: string; evidenceSpendUsd: number }) => [p.strategyHash, p.evidenceSpendUsd]));
console.log(`\ngenerated ${(res.generatedShapes ?? []).length} shapes; refused for latency ${(res.latencyRefused ?? []).length}; unprojected ${(res.latencyUnprojected ?? []).length}`);
console.log('\nstrategy                                                     quality   n    evidence$');
for (const s of [...(res.sampled ?? [])].sort((a: { meanQuality: number }, b: { meanQuality: number }) => b.meanQuality - a.meanQuality)) {
  console.log(`${(names.get(s.strategyHash) ?? s.strategyHash.slice(0, 10)).padEnd(60)} ${s.meanQuality.toFixed(3)}   ${String(s.n).padStart(3)}  $${(spendByHash.get(s.strategyHash) ?? 0).toFixed(4)}`);
}
console.log(`\nspend $${Number(res.spendUsd ?? 0).toFixed(4)} (projected $${Number(res.projectedSpendUsd ?? 0).toFixed(4)}) · published=${String(res.published ?? false)} · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
mkdirSync(ART, { recursive: true });
writeFileSync(`${ART}/gsm8k-leg-result-${process.env.GSM8K_TAG ?? 'main'}.json`, JSON.stringify({ res, names: [...names.entries()] }, null, 1));
await handle.close?.();
