// R4 attempt 4 — the gpt-full-anchored exec-pick (2026-08-24).
//
// PRE-REGISTERED, because the last attempt taught us how easy it is to read
// a single run as a result: two independent salted runs on the hard suite
// are pooled, and the humaneval instrument is measured too. The claim being
// tested is stated before the numbers exist:
//
//   or-gpt-full fails 3 of 99 items; or-solar-pro4 passes all 3 and costs
//   $0.0225/1k. If exec-pick(gpt-full | solar) matches or-grok-4.6's 1.000,
//   it DOMINATES grok — same quality, ~4x cheaper, ~2x faster — and grok
//   leaves the frontier. Anything less than grok's quality is a negative and
//   gets published as one.
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

const { createDb, migrate } = await import('@potion/db');
const { frontierPlatformSweepHandler } = await import('@potion/workers');
const { strategyHash } = await import('@potion/core');

const W = { model: 'or-gpt-mini' };
const PAIR = {
  type: 'ensemble' as const,
  models: ['or-gpt-full', 'or-solar-pro4'],
  fusion: { method: 'exec-pick' as const, testWriter: W, judge: W },
};
const TRIO = {
  type: 'ensemble' as const,
  models: ['or-gpt-full', 'or-solar-pro4', 'or-gemini-flash'],
  fusion: { method: 'exec-pick' as const, testWriter: W, judge: W },
};
const MEMBERS = ['or-gpt-full', 'or-solar-pro4', 'or-gemini-flash', 'or-gpt-mini', 'or-grok-4.6'];
const NAMES = new Map<string, string>();
for (const m of MEMBERS) NAMES.set(strategyHash({ type: 'single', model: m } as never), m);
NAMES.set(strategyHash(PAIR as never), 'exec-pick(gpt-full | solar)');
NAMES.set(strategyHash(TRIO as never), 'exec-pick(gpt-full | solar | gemini-flash)');

const handle = await createDb(`pglite://${STORE}`);
await migrate(handle.db);
const ctx = { db: handle.db, dbHandle: handle, pricesPath: process.env.POTION_PRICES_PATH! } as never;

interface Reading { q: number; n: number; cost?: number; p95?: number }
const readings = new Map<string, Reading[]>();

async function leg(label: string, extra: Record<string, unknown>): Promise<number> {
  console.log(`\n=== ${label} ===`);
  const res = (await frontierPlatformSweepHandler(
    {
      clusterId: 'code-gen',
      auditionModels: MEMBERS,
      maxAnswerers: MEMBERS.length,
      extraShapes: [PAIR, TRIO] as never,
      p95CapMs: 32000,
      capUsd: CAP,
      publish: false,
      ...extra,
    } as never,
    ctx,
  )) as Record<string, unknown>;
  for (const r of (res.latencyRefused ?? []) as Array<{ strategyHash: string; projectedP95Ms: number }>) {
    console.log(`  REFUSED pre-spend: ${NAMES.get(r.strategyHash) ?? r.strategyHash.slice(0, 8)} @ ${r.projectedP95Ms}ms`);
  }
  const sampled = (res.sampled ?? []) as Array<{ strategyHash: string; meanQuality: number; n: number }>;
  const per = (res.perCandidate ?? []) as Array<{ strategyHash: string; quality?: number; costPer1K?: number; latencyP95Ms?: number }>;
  const merged = new Map<string, Reading>();
  for (const s of sampled) merged.set(s.strategyHash, { q: s.meanQuality, n: s.n });
  for (const p of per) if (p.quality !== undefined) merged.set(p.strategyHash, { q: p.quality, n: -1, cost: p.costPer1K, p95: p.latencyP95Ms });
  for (const [h, r] of merged) {
    readings.set(h, [...(readings.get(h) ?? []), r]);
    console.log(`  ${(NAMES.get(h) ?? h.slice(0, 10)).padEnd(44)} ${r.q.toFixed(4)}  n=${r.n}${r.cost !== undefined ? `  $${r.cost.toFixed(4)}/1k  ${Math.round(r.p95 ?? 0)}ms` : ''}`);
  }
  const spend = Number(res.spendUsd ?? 0);
  console.log(`  spend $${spend.toFixed(4)}`);
  appendFileSync(`${ART}/ledger.jsonl`, `${JSON.stringify({ at: new Date().toISOString(), week: 'r4', lane: label, spendUsd: spend })}\n`);
  writeFileSync(`${ART}/${label}-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(res, null, 1));
  return spend;
}

mkdirSync(ART, { recursive: true });
let total = 0;
total += await leg('r4-gptfull-run1', { cacheSalt: 'r4-gptfull-a' });
total += await leg('r4-gptfull-run2', { cacheSalt: 'r4-gptfull-b' });
total += await leg('r4-gptfull-humaneval', { suiteOverride: { kind: 'v2', suiteId: 'code-gen-humaneval-js-v1' }, cacheSalt: 'r4-gptfull-he' });

console.log('\n=== POOLED (hard-suite runs 1+2) ===');
for (const [h, rs] of readings) {
  const hard = rs.slice(0, 2);
  if (hard.length === 0) continue;
  const mean = hard.reduce((a, r) => a + r.q, 0) / hard.length;
  const spread = hard.length > 1 ? Math.abs(hard[0]!.q - hard[1]!.q) : 0;
  console.log(`${(NAMES.get(h) ?? h.slice(0, 10)).padEnd(44)} mean ${mean.toFixed(4)}  spread ${spread.toFixed(4)}  (${hard.map((r) => r.q.toFixed(4)).join(', ')})`);
}
console.log(`\nPRE-REGISTERED TARGET: match or-grok-4.6 (1.0000 @ $6.5394 @ 46055ms) → domination.`);
console.log(`total $${total.toFixed(4)}`);
await handle.close?.();
