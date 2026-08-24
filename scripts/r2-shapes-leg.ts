// R2 — the first grammar-funded shapes leg (2026-08-24). code-gen, because
// it is EXECUTION-scored: the open judge question (G8) does not bind, so a
// mixture's number here is a number we can trust. Canary by default
// (publish OFF): read what the shapes measure before any frontier moves.
//
//   OBSERVATORY_DB=/research/store OBSERVATORY_ARTIFACTS=/research/artifacts \
//   KEY_RISK_ACCEPTED=2026-08-24 [R2_CAP_USD=6] [R2_P95_CAP_MS=15000] \
//   [R2_SAMPLE_N=10] [R2_PUBLISH=1] npx tsx scripts/r2-shapes-leg.ts
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
if (!process.env.KEY_RISK_ACCEPTED) throw new Error('live spend: set KEY_RISK_ACCEPTED=<date> (ledger row first)');
const STORE = process.env.OBSERVATORY_DB ?? `${REPO}/.pglite/platform-sweep-step5`;
const ART = process.env.OBSERVATORY_ARTIFACTS ?? `${REPO}/artifacts/observatory`;
process.env.POTION_PRICES_PATH = process.env.POTION_PRICES_PATH ?? `${REPO}/prices.json`;
const CLUSTER = process.env.R2_CLUSTER ?? 'code-gen';
const CAP = Number(process.env.R2_CAP_USD ?? 6);
const P95_CAP_MS = Number(process.env.R2_P95_CAP_MS ?? 15000);
const SAMPLE_N = Number(process.env.R2_SAMPLE_N ?? 10);
const PUBLISH = process.env.R2_PUBLISH === '1';

const { createDb, migrate } = await import('@potion/db');
const W = await import('@potion/workers');
const { frontierPlatformSweepHandler } = W;
const { strategyHash } = await import('@potion/core');

// The audition: proven code-gen performers + one strong closer. Mixtures are
// generated over exactly this pool by the grammar (payload.shapes).
const SHORTLIST = ['or-gpt-mini', 'or-gemini-flash', 'or-solar-pro4', 'or-inkling-small', 'or-gpt-full'];

const handle = await createDb(`pglite://${STORE}`);
await migrate(handle.db);
const ctx = { db: handle.db, dbHandle: handle, pricesPath: process.env.POTION_PRICES_PATH! } as never;

console.log(
  `r2 shapes leg: ${SHORTLIST.length} singles + grammar shapes on ${CLUSTER} · cap $${CAP} · p95Cap ${P95_CAP_MS}ms · sampleN ${SAMPLE_N} · publish=${PUBLISH}`,
);
const res = (await frontierPlatformSweepHandler(
  {
    clusterId: CLUSTER,
    auditionModels: SHORTLIST,
    maxAnswerers: SHORTLIST.length,
    shapes: ['cascade', 'draft-verify', 'best-of-n', 'ensemble'],
    shapeBudget: 8,
    p95CapMs: P95_CAP_MS,
    capUsd: CAP,
    sampleN: SAMPLE_N,
    publish: PUBLISH,
    cacheSalt: process.env.R2_SALT ?? `r2-shapes-${CLUSTER}-v1`,
  } as never,
  ctx,
)) as Record<string, unknown>;

const generated = (res.generatedShapes ?? []) as Array<{ template: string; strategyHash: string; type: string }>;
const refused = (res.latencyRefused ?? []) as Array<{ strategyHash: string; type: string; projectedP95Ms: number }>;
const unprojected = (res.latencyUnprojected ?? []) as string[];
const perCandidate = (res.perCandidate ?? []) as Array<{ strategyHash: string; type: string; evidenceSpendUsd: number; runQuality?: number; runN?: number }>;
const sampled = (res.sampled ?? []) as Array<{ strategyHash: string; meanQuality: number; n: number }>;

const names = new Map<string, string>();
for (const m of SHORTLIST) names.set(strategyHash({ type: 'single', model: m } as never), m);
for (const g of generated) names.set(g.strategyHash, `${g.template}`);

console.log(`\ngenerated ${generated.length} shapes; ${refused.length} refused pre-spend for latency; ${unprojected.length} unprojectable`);
for (const r of refused) console.log(`  REFUSED  ${(names.get(r.strategyHash) ?? r.type).padEnd(44)} projected p95 ${r.projectedP95Ms}ms > ${P95_CAP_MS}ms`);
console.log('\nstrategy                                             quality   n     evidence$');
const spendByHash = new Map(perCandidate.map((p) => [p.strategyHash, p.evidenceSpendUsd]));
for (const s of [...sampled].sort((a, b) => b.meanQuality - a.meanQuality)) {
  console.log(
    `${(names.get(s.strategyHash) ?? s.strategyHash.slice(0, 10)).padEnd(52)} ${s.meanQuality.toFixed(3)}   ${String(s.n).padStart(3)}   $${(spendByHash.get(s.strategyHash) ?? 0).toFixed(4)}`,
  );
}
const spend = Number(res.spendUsd ?? 0);
console.log(`\nspend $${spend.toFixed(4)} (projected $${Number(res.projectedSpendUsd ?? 0).toFixed(4)}) · published=${String(res.published ?? false)}`);
mkdirSync(ART, { recursive: true });
appendFileSync(`${ART}/ledger.jsonl`, `${JSON.stringify({ at: new Date().toISOString(), week: 'r2', lane: 'r2-shapes-leg', spendUsd: spend, detail: `${CLUSTER} shapes canary publish=${PUBLISH} refusedForLatency=${refused.length}` })}\n`);
writeFileSync(`${ART}/r2-shapes-leg-${CLUSTER}-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ res, names: [...names.entries()] }, null, 1));
await handle.close?.();
