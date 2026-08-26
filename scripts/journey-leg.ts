// Instrument campaign — THE FIRST JOURNEY FRONTIER (2026-08-26).
// Pre-registered (tasks/todo.md): journey-e2e-v1 (9 multi-step journeys,
// deterministic ends, the same strategy answers every step) × 4 singles,
// live. Whole-job quality, cost, and latency per model — task completion
// as the atomic outcome, measured for real. NOT promoted to serving:
// instrument evidence + Frontier Notes material. Cap $3 hard.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(`${REPO}/.env`)) {
  for (const line of readFileSync(`${REPO}/.env`, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^"|"$/g, '');
  }
}
if (!process.env.KEY_RISK_ACCEPTED) throw new Error('live spend: set KEY_RISK_ACCEPTED=<date> (ledger row first)');
process.env.POTION_EVAL_PROVIDER = 'live';
process.env.POTION_PROVIDER_TIMEOUT_MS = process.env.POTION_PROVIDER_TIMEOUT_MS ?? '180000';
process.env.POTION_PRICES_PATH = process.env.POTION_PRICES_PATH ?? `${REPO}/prices.json`;
const STORE = process.env.OBSERVATORY_DB ?? `${REPO}/.pglite/platform-sweep-step5`;
const ART = process.env.OBSERVATORY_ARTIFACTS ?? `${REPO}/artifacts/observatory`;
const CAP = Number(process.env.LEG_CAP_USD ?? 3);

const { createDb, migrate } = await import('@potion/db');
const { runEval } = await import('@potion/harness');
const { strategyHash } = await import('@potion/core');

const MODELS = ['or-gpt-mini', 'or-gemini-flash', 'or-sonnet', 'or-gpt-full'];
const handle = await createDb(`pglite://${STORE}`);
await migrate(handle.db);
mkdirSync(ART, { recursive: true });

const summary = await runEval(
  {
    suiteIds: [],
    suiteV2Ids: ['journey-e2e-v1'],
    strategies: MODELS.map((m) => ({ type: 'single', model: m } as never)),
    budgetCapUsd: CAP,
    provider: 'live',
    resume: true,
    containStrategyFailures: true,
  },
  { db: handle, pricesPath: process.env.POTION_PRICES_PATH! },
);

console.log(`\n──── THE FIRST JOURNEY FRONTIER (9 whole jobs, live, deterministic ends) ────`);
const byModel = new Map<string, { qs: number[]; cost: number; lat: number[] }>();
const hashToModel = new Map(MODELS.map((m) => [strategyHash({ type: 'single', model: m } as never), m]));
for (const r of summary.results) {
  const model = hashToModel.get(r.strategyHash);
  if (!model) continue;
  const e = byModel.get(model) ?? { qs: [], cost: 0, lat: [] };
  e.qs.push(r.quality);
  e.cost += r.usage.costUsd;
  e.lat.push(r.usage.latencyMs);
  byModel.set(model, e);
}
const rows = [...byModel.entries()]
  .map(([model, e]) => ({
    model,
    mean: e.qs.reduce((s, q) => s + q, 0) / e.qs.length,
    perfect: e.qs.filter((q) => q >= 1).length,
    n: e.qs.length,
    totalCost: e.cost,
    meanMs: e.lat.reduce((s, l) => s + l, 0) / e.lat.length,
  }))
  .sort((a, b) => b.mean - a.mean);
for (const r of rows) {
  console.log(
    `  ${r.model.padEnd(18)} mean end-score ${r.mean.toFixed(4)} · ${r.perfect}/${r.n} perfect · ` +
      `$${r.totalCost.toFixed(4)} for all ${r.n} journeys · mean ${Math.round(r.meanMs)}ms/journey`,
  );
}
const spend = summary.spendUsd;
console.log(`\n  aggregates: ${summary.aggregates.length} · executed ${summary.executed} · cacheHits ${summary.cacheHits}`);
if (summary.failedStrategies?.length) {
  for (const f of summary.failedStrategies) console.log(`  CONTAINED: ${f.strategyHash.slice(0, 8)} after ${f.completedCells} cells — ${f.error}`);
}
console.log(`  total leg spend $${spend.toFixed(4)} (cap $${CAP})`);
appendFileSync(`${ART}/ledger.jsonl`, `${JSON.stringify({ at: new Date().toISOString(), week: 'instrument-campaign', lane: 'journey-frontier-run1', spendUsd: spend })}\n`);
writeFileSync(`${ART}/journey-frontier-run1.json`, JSON.stringify({ rows, spendUsd: spend, aggregates: summary.aggregates }, null, 1));
await handle.close?.();
