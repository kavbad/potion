// R4 attempt 3 — EXEC-PICK (2026-08-24). Attempt 2's judge-pick beat both
// members but realized only 27% of the oracle: the text judge mispicks on
// hard disagreements. This leg measures the fusion built to fix that —
// request-derived tests, sandbox execution, judge only on ties.
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

const JUDGE = { model: 'or-gpt-mini' };
const xp = (models: string[], writer: string) => ({
  type: 'ensemble' as const,
  models,
  fusion: { method: 'exec-pick' as const, testWriter: { model: writer }, judge: JUDGE },
});
const SHAPES = [
  xp(['or-solar-pro4', 'or-gemini-flash'], 'or-gpt-mini'),
  xp(['or-solar-pro4', 'or-gemini-flash'], 'or-gemini-3.7-flash'),
  xp(['or-gemini-flash', 'or-gpt-mini'], 'or-gemini-3.7-flash'),
];
const MEMBERS = ['or-solar-pro4', 'or-gemini-flash', 'or-gpt-mini', 'or-gemini-3.7-flash'];
const NAMES = new Map<string, string>();
for (const m of MEMBERS) NAMES.set(strategyHash({ type: 'single', model: m } as never), m);
NAMES.set(strategyHash(SHAPES[0] as never), 'exec-pick(solar|gemini-flash, w:gpt-mini)');
NAMES.set(strategyHash(SHAPES[1] as never), 'exec-pick(solar|gemini-flash, w:3.7-flash)');
NAMES.set(strategyHash(SHAPES[2] as never), 'exec-pick(gemini-flash|gpt-mini, w:3.7-flash)');

const handle = await createDb(`pglite://${STORE}`);
await migrate(handle.db);
const ctx = { db: handle.db, dbHandle: handle, pricesPath: process.env.POTION_PRICES_PATH! } as never;

console.log(`r4 exec-pick leg: ${MEMBERS.length} singles (cached) + ${SHAPES.length} exec-pick shapes · cap $${CAP} · p95Cap 30000ms · publish=${PUBLISH}`);
const res = (await frontierPlatformSweepHandler(
  {
    clusterId: 'code-gen',
    auditionModels: MEMBERS,
    maxAnswerers: MEMBERS.length,
    extraShapes: SHAPES as never,
    p95CapMs: 30000,
    capUsd: CAP,
    publish: PUBLISH,
  } as never,
  ctx,
)) as Record<string, unknown>;

const refused = (res.latencyRefused ?? []) as Array<{ strategyHash: string; type: string; projectedP95Ms: number }>;
for (const r of refused) console.log(`REFUSED pre-spend: ${NAMES.get(r.strategyHash) ?? r.type} projected p95 ${r.projectedP95Ms}ms`);
const perCandidate = (res.perCandidate ?? []) as Array<{ strategyHash: string; type: string; evidenceSpendUsd: number; runQuality?: number; runN?: number; costPer1K?: number; latencyP95Ms?: number }>;
const sampled = (res.sampled ?? []) as Array<{ strategyHash: string; meanQuality: number; n: number }>;
const q = new Map(sampled.map((s) => [s.strategyHash, s.meanQuality]));
for (const p of perCandidate) if (p.runQuality !== undefined) q.set(p.strategyHash, p.runQuality); // like-for-like: THIS run only
console.log('\nstrategy                                                   quality     $per1K     p95ms    evidence$');
for (const p of [...perCandidate].sort((a, b) => (q.get(b.strategyHash) ?? -1) - (q.get(a.strategyHash) ?? -1))) {
  const qq = q.get(p.strategyHash);
  console.log(`${(NAMES.get(p.strategyHash) ?? `${p.type}:${p.strategyHash.slice(0, 8)}`).padEnd(58)} ${qq !== undefined ? qq.toFixed(4) : '   —  '}   ${p.costPer1K !== undefined ? `$${p.costPer1K.toFixed(4)}`.padStart(8) : '     —  '}   ${p.latencyP95Ms !== undefined ? String(Math.round(p.latencyP95Ms)).padStart(6) : '    —'}   $${p.evidenceSpendUsd.toFixed(4)}`);
}
const spend = Number(res.spendUsd ?? 0);
console.log(`\nbaselines: judge-pick(solar|gemini) 0.9856 @ $0.98 · or-gpt-mini 0.9858 @ $0.25 · or-gpt-full 0.9940 @ $1.30 · grok-4.6 1.0000 @ $6.76/46s`);
console.log(`spend $${spend.toFixed(4)} (projected $${Number(res.projectedSpendUsd ?? 0).toFixed(4)}) · published=${String(res.published ?? false)}`);
mkdirSync(ART, { recursive: true });
appendFileSync(`${ART}/ledger.jsonl`, `${JSON.stringify({ at: new Date().toISOString(), week: 'r4', lane: 'r4-exec-leg', spendUsd: spend, detail: `code-gen exec-pick publish=${PUBLISH}` })}\n`);
writeFileSync(`${ART}/r4-exec-leg-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ res, names: [...NAMES.entries()] }, null, 1));
await handle.close?.();
