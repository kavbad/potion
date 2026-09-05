// R4 — the first capability-mixing leg (2026-08-24), from the $0 headroom
// finding: or-solar-pro4 (0.9841 over 90 items) fails exactly 4 items and
// or-gemini-flash passes all four. Oracle ceiling of the pair: 1.000. Four
// pair shapes try to realize it, on the FULL platform suite, scored by
// EXECUTION — the open judge question (G8) cannot taint the outcome.
// Nothing here uses the items' reference tests inside a strategy: every
// shape is servable as-is. Canary by default: read before any frontier moves.
//
//   OBSERVATORY_DB=/research/store OBSERVATORY_ARTIFACTS=/research/artifacts \
//   KEY_RISK_ACCEPTED=2026-08-24 [R4_CAP_USD=8] [R4_PUBLISH=1] npx tsx scripts/r4-pair-leg.ts
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
const CLUSTER = 'code-gen';
const CAP = Number(process.env.R4_CAP_USD ?? 8);
const PUBLISH = process.env.R4_PUBLISH === '1';

const { createDb, migrate } = await import('@potion/db');
const { frontierPlatformSweepHandler } = await import('@potion/workers');
const { strategyHash } = await import('@potion/core');

const CHAMPION = 'or-solar-pro4';
const PARTNER = 'or-gemini-flash';
const STRONG = 'or-gpt-full';
const dv = (draftModel: string, verifierModel: string) => ({ type: 'draft-verify' as const, draftModel, verifierModel });
const SHAPES = [
  dv(CHAMPION, PARTNER),
  dv(PARTNER, CHAMPION),
  dv(CHAMPION, STRONG),
  { type: 'ensemble' as const, models: [CHAMPION, PARTNER], fusion: { method: 'judge-pick' as const, judge: { model: 'or-gpt-mini' } } },
];
const NAMES = new Map<string, string>([
  [strategyHash(SHAPES[0] as never), 'dv(solar → gemini-flash)'],
  [strategyHash(SHAPES[1] as never), 'dv(gemini-flash → solar)'],
  [strategyHash(SHAPES[2] as never), 'dv(solar → gpt-full)'],
  [strategyHash(SHAPES[3] as never), 'ensemble(solar+gemini-flash, judge gpt-mini)'],
  [strategyHash({ type: 'single', model: CHAMPION } as never), CHAMPION],
  [strategyHash({ type: 'single', model: PARTNER } as never), PARTNER],
  [strategyHash({ type: 'single', model: STRONG } as never), STRONG],
]);

const handle = await createDb(`pglite://${STORE}`);
await migrate(handle.db);
const ctx = { db: handle.db, dbHandle: handle, pricesPath: process.env.POTION_PRICES_PATH! } as never;

console.log(`r4 pair leg: 3 singles (cache-resumed) + 4 pair shapes on ${CLUSTER}, FULL suite · cap $${CAP} · publish=${PUBLISH}`);
const res = await frontierPlatformSweepHandler(
  {
    clusterId: CLUSTER,
    auditionModels: [CHAMPION, PARTNER, STRONG],
    maxAnswerers: 3,
    extraShapes: SHAPES as never,
    p95CapMs: 20000,
    capUsd: CAP,
    publish: PUBLISH,
    // no cacheSalt: singles resume from the paid campaign cells at ~$0, and
    // the mixtures' cells land in the REAL evidence chain
  },
  ctx,
);

const refused = res.latencyRefused;
for (const r of refused) console.log(`REFUSED pre-spend: ${NAMES.get(r.strategyHash) ?? r.type} projected p95 ${r.projectedP95Ms}ms`);
const perCandidate = res.perCandidate;
const sampled = res.sampled ?? [];
const qualityOf = new Map(sampled.map((s) => [s.strategyHash, { q: s.meanQuality, n: s.n }]));
for (const p of perCandidate) if (p.runQuality !== undefined) qualityOf.set(p.strategyHash, { q: p.runQuality, n: p.runN ?? -1 }); // like-for-like: THIS run only

console.log('\nstrategy                                             quality     $per1K     p95ms    evidence$');
const rows = perCandidate
  .map((p) => ({ ...p, s: qualityOf.get(p.strategyHash) }))
  .sort((a, b) => (b.s?.q ?? -1) - (a.s?.q ?? -1));
for (const p of rows) {
  console.log(
    `${(NAMES.get(p.strategyHash) ?? `${p.type}:${p.strategyHash.slice(0, 8)}`).padEnd(52)} ${p.s ? p.s.q.toFixed(4) : '   —  '}   ${p.costPer1K !== undefined ? `$${p.costPer1K.toFixed(4)}`.padStart(8) : '     —  '}   ${p.latencyP95Ms !== undefined ? String(Math.round(p.latencyP95Ms)).padStart(6) : '    —'}   $${p.evidenceSpendUsd.toFixed(4)}`,
  );
}
const spend = Number(res.spendUsd ?? 0);
console.log(`\nchampion baseline: ${CHAMPION} 0.9841 (90-item live evidence)`);
console.log(`spend $${spend.toFixed(4)} (projected $${Number(res.projectedSpendUsd ?? 0).toFixed(4)}) · published=${String(res.published ?? false)}`);
mkdirSync(ART, { recursive: true });
appendFileSync(`${ART}/ledger.jsonl`, `${JSON.stringify({ at: new Date().toISOString(), week: 'r4', lane: 'r4-pair-leg', spendUsd: spend, detail: `code-gen pair shapes publish=${PUBLISH}` })}\n`);
writeFileSync(`${ART}/r4-pair-leg-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ res, names: [...NAMES.entries()] }, null, 1));
await handle.close?.();
