// MIXING M3 / Observatory rung 6 — the first tool-calling leg (2026-08-23).
// Measures the miner's agentic-tool-use shortlist AND four named cascades
// on the tool-calling suite (items carry real tools; scored on the call).
// publish is OFF unless VISION_PUBLISH=1: read the numbers first.
//
//   OBSERVATORY_DB=/research/store OBSERVATORY_ARTIFACTS=/research/artifacts \
//   KEY_RISK_ACCEPTED=2026-08-23 [M3_CAP_USD=15] [VISION_PUBLISH=1] npx tsx scripts/m3-tools-leg.ts
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(`${REPO}/.env`)) {
  const dotenv = await import('node:fs');
  for (const line of dotenv.readFileSync(`${REPO}/.env`, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^"|"$/g, '');
  }
}
if (!process.env.KEY_RISK_ACCEPTED) throw new Error('live spend: set KEY_RISK_ACCEPTED=<date> (ledger row first)');
const STORE = process.env.OBSERVATORY_DB ?? `${REPO}/.pglite/platform-sweep-step5`;
const ART = process.env.OBSERVATORY_ARTIFACTS ?? `${REPO}/artifacts/observatory`;
process.env.POTION_PRICES_PATH = process.env.POTION_PRICES_PATH ?? `${REPO}/prices.json`;
const CAP = Number(process.env.VISION_CAP_USD ?? 5);
const PUBLISH = process.env.VISION_PUBLISH === '1';

const { createDb, migrate } = await import('@potion/db');
const W = await import('@potion/workers');
const { frontierPlatformSweepHandler } = W;

const SHORTLIST = ['or-gemini-flash', 'or-gemini-3.7-flash', 'or-gpt-full', 'or-gpt-mini', 'or-sonnet', 'or-grok-4.6', 'or-kimi-k3', 'or-inkling-small'];
const cascade = (cheap: string, strong: string) => ({
  type: 'cascade' as const,
  stages: [{ model: cheap, escalateIf: { confidenceBelow: 0.8 } }, { model: strong }],
  confidenceMethod: 'self-report-calibrated' as const,
});
const CASCADES = [cascade('or-inkling-small', 'or-gpt-full'), cascade('or-gemini-flash', 'or-gpt-full')];

const handle = await createDb(`pglite://${STORE}`);
await migrate(handle.db);
const ctx = { db: handle.db, dbHandle: handle, pricesPath: process.env.POTION_PRICES_PATH! } as never;

console.log(`g vision leg: ${SHORTLIST.length} singles + ${CASCADES.length} cascades on extraction-vision-v1 · cap $${CAP} · publish=${PUBLISH}`);
const res = await frontierPlatformSweepHandler(
  {
    clusterId: 'extraction',
    suiteOverride: { kind: 'v2', suiteId: 'extraction-vision-v1' },
    auditionModels: SHORTLIST,
    // No capabilityFilter: the registry does not KNOW supports_tools for these
    // models (null → excluded, honestly), and this instrument measures tool
    // use directly — a model that cannot call a tool scores 0 here.
    extraShapes: CASCADES as never,
    capUsd: CAP,
    maxAnswerers: SHORTLIST.length,
    publish: PUBLISH,
    cacheSalt: 'g-vision-v1',
    instrument: 'vision',
  } as never,
  ctx,
);
const sampled = (res as { sampled?: { strategyHash: string; meanQuality: number; n: number }[] }).sampled ?? [];
const byHash = new Map<string, string>();
const { strategyHash } = await import('@potion/core');
for (const m of SHORTLIST) byHash.set(strategyHash({ type: 'single', model: m }), m);
for (const c of CASCADES) byHash.set(strategyHash(c), `cascade(${c.stages[0]!.model} → ${c.stages[1]!.model})`);
console.log('\nstrategy                                     quality   n');
for (const s of [...sampled].sort((a, b) => b.meanQuality - a.meanQuality)) {
  console.log(`${(byHash.get(s.strategyHash) ?? s.strategyHash.slice(0, 8)).padEnd(44)} ${s.meanQuality.toFixed(3)}   ${s.n}`);
}
const spend = (res as { spendUsd?: number }).spendUsd ?? 0;
console.log(`\nspend $${spend.toFixed(4)} · published=${String((res as { published?: boolean }).published ?? false)}`);
mkdirSync(ART, { recursive: true });
appendFileSync(`${ART}/ledger.jsonl`, `${JSON.stringify({ at: new Date().toISOString(), week: 'm3', lane: 'm3-leg', spendUsd: spend, detail: `extraction-vision-v1 publish=${PUBLISH}` })}\n`);
writeFileSync(`${ART}/m3-tools-leg-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ res, byHash: [...byHash.entries()] }, null, 1));
await handle.close?.();
