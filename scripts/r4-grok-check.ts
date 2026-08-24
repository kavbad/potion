// Does or-gpt-full really tie or-grok-4.6 now? (2026-08-24)
//
// Attempt 4 measured both at 1.0000 on two fresh salted runs while the
// CACHED aggregate still says gpt-full 0.9945 — stale evidence from an
// earlier campaign. This is the tie-break: a third independent reading of
// exactly those two, nothing else, compared like-for-like on runQuality.
// If gpt-full holds, grok is dominated on every axis and the top quality
// point on code-gen belongs to a model that costs 1/5 and answers 16x
// faster. Canary: publishes nothing.
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

const { createDb, migrate } = await import('@potion/db');
const { frontierPlatformSweepHandler } = await import('@potion/workers');
const { strategyHash } = await import('@potion/core');

const PAIR = ['or-gpt-full', 'or-grok-4.6'];
const NAMES = new Map(PAIR.map((m) => [strategyHash({ type: 'single', model: m } as never), m]));

const handle = await createDb(`pglite://${STORE}`);
await migrate(handle.db);
const ctx = { db: handle.db, dbHandle: handle, pricesPath: process.env.POTION_PRICES_PATH! } as never;

console.log('grok-domination check: 3rd independent reading, gpt-full vs grok-4.6, full hard suite');
const res = (await frontierPlatformSweepHandler(
  {
    clusterId: 'code-gen',
    auditionModels: PAIR,
    maxAnswerers: PAIR.length,
    capUsd: Number(process.env.CHECK_CAP_USD ?? 2),
    publish: false,
    cacheSalt: 'grok-domination-c',
  } as never,
  ctx,
)) as Record<string, unknown>;

const per = (res.perCandidate ?? []) as Array<{ strategyHash: string; runQuality?: number; runN?: number; costPer1K?: number; latencyP95Ms?: number; aggregateQuality?: number }>;
console.log('\nmodel                    runQuality   n    $per1k      p95ms    (stale aggregate)');
for (const p of per.sort((a, b) => (b.runQuality ?? -1) - (a.runQuality ?? -1))) {
  console.log(
    `${(NAMES.get(p.strategyHash) ?? p.strategyHash.slice(0, 10)).padEnd(24)} ${(p.runQuality ?? NaN).toFixed(4)}   ${String(p.runN ?? '-').padStart(2)}  ${('$' + (p.costPer1K ?? 0).toFixed(4)).padStart(9)}  ${String(Math.round(p.latencyP95Ms ?? 0)).padStart(7)}    ${(p.aggregateQuality ?? NaN).toFixed(4)}`,
  );
}
const g = per.find((p) => NAMES.get(p.strategyHash) === 'or-gpt-full');
const k = per.find((p) => NAMES.get(p.strategyHash) === 'or-grok-4.6');
if (g?.runQuality !== undefined && k?.runQuality !== undefined) {
  const dominates = g.runQuality >= k.runQuality && (g.costPer1K ?? 9e9) < (k.costPer1K ?? 0) && (g.latencyP95Ms ?? 9e9) < (k.latencyP95Ms ?? 0);
  console.log(`\nVERDICT: gpt-full ${dominates ? 'DOMINATES' : 'does NOT dominate'} grok-4.6 on this reading (quality ${g.runQuality.toFixed(4)} vs ${k.runQuality.toFixed(4)}).`);
}
const spend = Number(res.spendUsd ?? 0);
console.log(`spend $${spend.toFixed(4)}`);
mkdirSync(ART, { recursive: true });
appendFileSync(`${ART}/ledger.jsonl`, `${JSON.stringify({ at: new Date().toISOString(), week: 'r4', lane: 'grok-domination-check', spendUsd: spend })}\n`);
writeFileSync(`${ART}/grok-domination-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(res, null, 1));
await handle.close?.();
