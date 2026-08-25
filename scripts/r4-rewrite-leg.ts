// Track 1 — the rewrite-edit capability leg (2026-08-24). Pre-registered:
// beat or-sonnet's pooled runQuality CI-clear, or publish the negative.
// The interesting science: dv (the rewrite shape) LOST on code because the
// verifier meddles with correct programs — but rewrite-edit IS editing;
// this cluster is the shape's native regime.
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
const CAP = Number(process.env.LEG_CAP_USD ?? 8);

const { createDb, migrate } = await import('@potion/db');
const { frontierPlatformSweepHandler } = await import('@potion/workers');
const { strategyHash } = await import('@potion/core');

const SONNET = 'or-sonnet';
const OPUS = 'or-claude-opus-5-fast';
const MINI = 'or-gpt-mini';
const SHAPES = [
  { type: 'ensemble' as const, models: [SONNET, OPUS], fusion: { method: 'judge-pick' as const, judge: { model: MINI } } },
  { type: 'draft-verify' as const, draftModel: OPUS, verifierModel: SONNET },
  { type: 'draft-verify' as const, draftModel: SONNET, verifierModel: OPUS },
  { type: 'ensemble' as const, models: [SONNET, MINI], fusion: { method: 'judge-pick' as const, judge: { model: 'or-gemini-3.7-flash' } } },
];
const MEMBERS = [SONNET, OPUS, MINI, 'or-gemini-3.7-flash'];
const NAMES = new Map<string, string>();
for (const m of MEMBERS) NAMES.set(strategyHash({ type: 'single', model: m } as never), m);
NAMES.set(strategyHash(SHAPES[0] as never), 'pick(sonnet|opus-fast, j:gpt-mini)');
NAMES.set(strategyHash(SHAPES[1] as never), 'dv(opus-fast → sonnet)');
NAMES.set(strategyHash(SHAPES[2] as never), 'dv(sonnet → opus-fast)');
NAMES.set(strategyHash(SHAPES[3] as never), 'pick(sonnet|gpt-mini, j:3.7-flash)');

const handle = await createDb(`pglite://${STORE}`);
await migrate(handle.db);
const ctx = { db: handle.db, dbHandle: handle, pricesPath: process.env.POTION_PRICES_PATH! } as never;

interface Reading { q: number; n: number; cost?: number; p95?: number }
const readings = new Map<string, Reading[]>();

async function leg(label: string, salt: string): Promise<number> {
  console.log(`\n=== ${label} ===`);
  const res = (await frontierPlatformSweepHandler(
    {
      clusterId: 'rewrite-edit',
      auditionModels: MEMBERS,
      maxAnswerers: MEMBERS.length,
      extraShapes: SHAPES as never,
      p95CapMs: 30000,
      capUsd: CAP,
      publish: false,
      cacheSalt: salt,
    } as never,
    ctx,
  )) as Record<string, unknown>;
  for (const r of (res.latencyRefused ?? []) as Array<{ strategyHash: string; projectedP95Ms: number }>) {
    console.log(`  REFUSED pre-spend: ${NAMES.get(r.strategyHash) ?? r.strategyHash.slice(0, 8)} @ ${r.projectedP95Ms}ms`);
  }
  const per = (res.perCandidate ?? []) as Array<{ strategyHash: string; runQuality?: number; runN?: number; costPer1K?: number; latencyP95Ms?: number }>;
  for (const p of per) {
    if (p.runQuality === undefined) continue;
    const r: Reading = { q: p.runQuality, n: p.runN ?? -1, ...(p.costPer1K !== undefined ? { cost: p.costPer1K } : {}), ...(p.latencyP95Ms !== undefined ? { p95: p.latencyP95Ms } : {}) };
    readings.set(p.strategyHash, [...(readings.get(p.strategyHash) ?? []), r]);
    console.log(`  ${(NAMES.get(p.strategyHash) ?? p.strategyHash.slice(0, 10)).padEnd(40)} ${r.q.toFixed(4)}  n=${r.n}${r.cost !== undefined ? `  $${r.cost.toFixed(4)}/1k  ${Math.round(r.p95 ?? 0)}ms` : ''}`);
  }
  const spend = Number(res.spendUsd ?? 0);
  console.log(`  spend $${spend.toFixed(4)}`);
  appendFileSync(`${ART}/ledger.jsonl`, `${JSON.stringify({ at: new Date().toISOString(), week: 'track1', lane: label, spendUsd: spend })}\n`);
  writeFileSync(`${ART}/${label}.json`, JSON.stringify(res, null, 1));
  return spend;
}

mkdirSync(ART, { recursive: true });
let total = 0;
total += await leg('rewrite-cap-run1', 'rw-cap-a');
total += await leg('rewrite-cap-run2', 'rw-cap-b');

console.log('\n=== POOLED (like-for-like runQuality) ===');
for (const [h, rs] of readings) {
  const mean = rs.reduce((a, r) => a + r.q, 0) / rs.length;
  const spread = rs.length > 1 ? Math.abs(rs[0]!.q - rs[1]!.q) : 0;
  console.log(`${(NAMES.get(h) ?? h.slice(0, 10)).padEnd(40)} mean ${mean.toFixed(4)}  spread ${spread.toFixed(4)}  (${rs.map((r) => r.q.toFixed(4)).join(', ')})`);
}
console.log(`\nPRE-REGISTERED TARGET: beat or-sonnet's pooled runQuality CI-clear.`);
console.log(`total $${total.toFixed(4)}`);
await handle.close?.();
