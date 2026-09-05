// R4 attempt 2 — PICK shapes (2026-08-24). Attempt 1's rewrite shapes lost
// to their own members (the verifier meddles); the evidence pointed at
// picking between finished candidates instead. Four judge-pick ensembles,
// members chosen from the $0 coverage queries:
//   solar+gemini-flash        mutual full coverage (oracle 1.000), batch tier
//   gemini-flash+grok-4.6     grok covers all 5 gemini fails
//   gemini-flash+sonnet       sonnet covers all 5 gemini fails
//   gemini-flash+3.7-flash    fast cheap pair, 4/5 coverage
// Canary (publish OFF). Execution-scored; the internal judge is part of the
// strategy, so G8 does not taint the measurement.
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
const CAP = Number(process.env.R4_CAP_USD ?? 8);
const PUBLISH = process.env.R4_PUBLISH === '1';

const { createDb, migrate } = await import('@potion/db');
const { frontierPlatformSweepHandler } = await import('@potion/workers');
const { strategyHash } = await import('@potion/core');

const JUDGE = 'or-gpt-mini';
const ens = (a: string, b: string) => ({
  type: 'ensemble' as const,
  models: [a, b],
  fusion: { method: 'judge-pick' as const, judge: { model: JUDGE } },
});
const SHAPES = [
  ens('or-solar-pro4', 'or-gemini-flash'),
  ens('or-gemini-flash', 'or-grok-4.6'),
  ens('or-gemini-flash', 'or-sonnet'),
  ens('or-gemini-flash', 'or-gemini-3.7-flash'),
];
const MEMBERS = ['or-solar-pro4', 'or-gemini-flash', 'or-grok-4.6', 'or-sonnet', 'or-gemini-3.7-flash', JUDGE];
const NAMES = new Map<string, string>();
for (const m of MEMBERS) NAMES.set(strategyHash({ type: 'single', model: m } as never), m);
for (const s of SHAPES) NAMES.set(strategyHash(s as never), `pick(${s.models.join(' | ')})`);

const handle = await createDb(`pglite://${STORE}`);
await migrate(handle.db);
const ctx = { db: handle.db, dbHandle: handle, pricesPath: process.env.POTION_PRICES_PATH! } as never;

console.log(`r4 pick leg: ${MEMBERS.length} singles (cached) + ${SHAPES.length} pick ensembles · cap $${CAP} · p95Cap 30000ms · publish=${PUBLISH}`);
const res = await frontierPlatformSweepHandler(
  {
    clusterId: 'code-gen',
    auditionModels: MEMBERS,
    maxAnswerers: MEMBERS.length,
    extraShapes: SHAPES as never,
    p95CapMs: 30000,
    capUsd: CAP,
    publish: PUBLISH,
  },
  ctx,
);

const refused = res.latencyRefused;
for (const r of refused) console.log(`REFUSED pre-spend: ${NAMES.get(r.strategyHash) ?? r.type} projected p95 ${r.projectedP95Ms}ms`);
const perCandidate = res.perCandidate;
const sampled = res.sampled ?? [];
const q = new Map(sampled.map((s) => [s.strategyHash, s.meanQuality]));
for (const p of perCandidate) if (p.runQuality !== undefined) q.set(p.strategyHash, p.runQuality); // like-for-like: THIS run only
console.log('\nstrategy                                             quality     $per1K     p95ms    evidence$');
for (const p of [...perCandidate].sort((a, b) => (q.get(b.strategyHash) ?? -1) - (q.get(a.strategyHash) ?? -1))) {
  const qq = q.get(p.strategyHash);
  console.log(`${(NAMES.get(p.strategyHash) ?? `${p.type}:${p.strategyHash.slice(0, 8)}`).padEnd(52)} ${qq !== undefined ? qq.toFixed(4) : '   —  '}   ${p.costPer1K !== undefined ? `$${p.costPer1K.toFixed(4)}`.padStart(8) : '     —  '}   ${p.latencyP95Ms !== undefined ? String(Math.round(p.latencyP95Ms)).padStart(6) : '    —'}   $${p.evidenceSpendUsd.toFixed(4)}`);
}
const spend = Number(res.spendUsd ?? 0);
console.log(`\nbaselines: or-solar-pro4 0.9804 · or-gpt-full 0.9940 · frontier top single 1.0000 @ $6.7571/1k`);
console.log(`spend $${spend.toFixed(4)} (projected $${Number(res.projectedSpendUsd ?? 0).toFixed(4)}) · published=${String(res.published ?? false)}`);
mkdirSync(ART, { recursive: true });
appendFileSync(`${ART}/ledger.jsonl`, `${JSON.stringify({ at: new Date().toISOString(), week: 'r4', lane: 'r4-pick-leg', spendUsd: spend, detail: `code-gen pick ensembles publish=${PUBLISH}` })}\n`);
writeFileSync(`${ART}/r4-pick-leg-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ res, names: [...NAMES.entries()] }, null, 1));
await handle.close?.();
