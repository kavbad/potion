// Journey-grain equivalence (2026-08-25, operator item 2). Nine multi-step
// journeys run end-to-end through THREE arms:
//   monolith-sonnet   — or-sonnet answers every step
//   monolith-gptfull  — or-gpt-full answers every step
//   potion-routed     — each step goes to the serving frontier's cheapest
//                       single at the 0.90 floor for that step's cluster
// The FINAL artifact is scored deterministically (field-match / code-exec) —
// no judge anywhere. Two seeded repetitions. Direct provider calls through
// the same @potion/strategies execute() the serving path uses, so usage and
// cost are the real receipts. Honest scope printed with the result: synthetic
// journeys; partner traffic adjudicates the composition bet for real.
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
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
const CAP = Number(process.env.JOURNEY_CAP_USD ?? 6);
const STORE = process.env.OBSERVATORY_DB ?? `${REPO}/.pglite/platform-sweep-step5`;
const ART = process.env.OBSERVATORY_ARTIFACTS ?? `${REPO}/artifacts/observatory`;

const { loadPrices, createProviders } = await import('@potion/providers');
const { execute, createResolver } = await import('@potion/strategies');
const { scoreCodeExec } = await import('@potion/strategies');
const { selectPoint } = await import('@potion/core');
const { createDb, getLatestFrontier } = await import('@potion/db');
const { JOURNEYS } = await import('./journey-specs.js');
type Check = import('./journey-specs.js').JourneyCheck;

const { table: prices } = loadPrices(`${REPO}/prices.json`);
const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error('OPENROUTER_API_KEY missing');
const providers = createProviders({ prices, apiKeys: { openrouter: key }, timeoutMs: 180_000 });
const resolver = createResolver(providers as never, prices);

// ---- the routed arm's per-cluster picks: the serving frontier's cheapest
// single at the 0.90 floor, read from the research store (single reader —
// run this only while no leg holds the store).
const FALLBACK: Record<string, string> = {
  extraction: 'or-solar-pro4', classification: 'or-solar-pro4', 'rewrite-edit': 'or-gpt-mini',
  summarization: 'or-ling-3.0-flash', 'code-gen': 'or-gpt-mini', 'code-review': 'or-deepseek',
  'multi-step-reasoning': 'or-ling-3.0-flash',
};
const clusters = [...new Set(JOURNEYS.flatMap((j) => j.steps.map((s) => s.clusterId)))];
const picks: Record<string, { model: string; source: 'frontier' | 'fallback' }> = {};
{
  const handle = await createDb(`pglite://${STORE}`);
  for (const c of clusters) {
    const frontier = await getLatestFrontier(handle.db, c, null).catch(() => null);
    const singles = (frontier?.points ?? []).filter(
      (p) => (p.strategyConfig as { type?: string }).type === 'single' && p.quality >= 0.9,
    );
    const point = singles.length > 0 ? selectPoint({ type: 'min_cost', qualityFloor: 0.9 }, { points: singles } as never) : null;
    const model = point ? (point.strategyConfig as { model: string }).model : undefined;
    picks[c] = model ? { model, source: 'frontier' } : { model: FALLBACK[c]!, source: 'fallback' };
  }
  await handle.close?.();
}
console.log('routed-arm picks (min_cost @ floor 0.90):');
for (const [c, p] of Object.entries(picks)) console.log(`  ${c.padEnd(22)} ${p.model} (${p.source})`);

// ---- deterministic checks -------------------------------------------------
function stripFence(t: string): string {
  return t.trim().replace(/^```[a-z0-9_-]*\s*\n?/i, '').replace(/\n?\s*```$/, '').trim();
}
function lookup(obj: unknown, path: string): unknown {
  let cur = obj;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}
function fieldScore(finalText: string, fields: Record<string, string | string[]>): { score: number; misses: string[] } {
  let parsed: unknown;
  try { parsed = JSON.parse(stripFence(finalText)); } catch { return { score: 0, misses: ['<unparseable json>'] }; }
  const misses: string[] = [];
  let hit = 0;
  for (const [path, want] of Object.entries(fields)) {
    const actual = lookup(parsed, path);
    const hay = actual === undefined ? '' : String(actual).toLowerCase();
    const oks = (Array.isArray(want) ? want : [want]).map((w) => w.toLowerCase());
    if (hay !== '' && oks.some((w) => hay.includes(w))) hit += 1;
    else misses.push(`${path}(got:${String(actual).slice(0, 40)})`);
  }
  return { score: hit / Object.keys(fields).length, misses };
}

// ---- execution ------------------------------------------------------------
const ARMS: Array<{ id: string; modelFor: (clusterId: string) => string }> = [
  { id: 'monolith-sonnet', modelFor: () => 'or-sonnet' },
  { id: 'monolith-gptfull', modelFor: () => 'or-gpt-full' },
  { id: 'potion-routed', modelFor: (c) => picks[c]!.model },
];
const REPS = [1101, 2202]; // two seeded repetitions

interface ArmRun { journey: string; rep: number; score: number; costUsd: number; ms: number; misses: string[] }
const runs: Record<string, ArmRun[]> = Object.fromEntries(ARMS.map((a) => [a.id, []]));
let spent = 0;

for (const rep of REPS) {
  for (const journey of JOURNEYS) {
    for (const arm of ARMS) {
      if (spent > CAP) throw new Error(`cap $${CAP} exceeded at $${spent.toFixed(2)} — stopping`);
      const outputs: string[] = [];
      let cost = 0;
      let ms = 0;
      const t0 = Date.now();
      for (const [si, step] of journey.steps.entries()) {
        let prompt = step.prompt;
        // {{prev}} = last output, {{prevN}} = N+1 steps back.
        prompt = prompt.replace(/\{\{prev(\d*)\}\}/g, (_, n) => outputs[outputs.length - 1 - (n === '' ? 0 : Number(n))] ?? '');
        const r = await execute(
          { type: 'single', model: arm.modelFor(step.clusterId) } as never,
          [{ role: 'user', content: prompt }],
          { providers: providers as never, prices, resolve: resolver, seed: rep * 1000 + si } as never,
        );
        outputs.push(r.text);
        cost += r.usage.costUsd ?? 0;
      }
      ms = Date.now() - t0;
      spent += cost;
      const finalText = outputs[outputs.length - 1]!;
      let score: number;
      let misses: string[] = [];
      if (journey.check.kind === 'field-match') {
        ({ score, misses } = fieldScore(finalText, journey.check.fields));
      } else {
        const res = await scoreCodeExec(stripFence(finalText), { kind: 'code-exec', language: 'javascript', tests: journey.check.tests } as never);
        score = res.quality;
        if (score < 1) misses = res.report.failures.slice(0, 2);
      }
      runs[arm.id]!.push({ journey: journey.id, rep, score, costUsd: cost, ms, misses });
      console.log(`  ${arm.id.padEnd(18)} ${journey.id} rep${rep === REPS[0] ? 1 : 2}  score ${score.toFixed(2)}  $${cost.toFixed(4)}  ${ms}ms${misses.length ? `  [${misses.join('; ').slice(0, 90)}]` : ''}`);
    }
  }
}

console.log('\n──── JOURNEY-GRAIN EQUIVALENCE (deterministic ends; 9 journeys × 2 reps) ────');
const summary: Record<string, { meanScore: number; perfect: number; totalCost: number; meanMs: number }> = {};
for (const arm of ARMS) {
  const rs = runs[arm.id]!;
  summary[arm.id] = {
    meanScore: rs.reduce((s, r) => s + r.score, 0) / rs.length,
    perfect: rs.filter((r) => r.score >= 1).length,
    totalCost: rs.reduce((s, r) => s + r.costUsd, 0),
    meanMs: rs.reduce((s, r) => s + r.ms, 0) / rs.length,
  };
  const x = summary[arm.id]!;
  console.log(`  ${arm.id.padEnd(18)} mean end-score ${x.meanScore.toFixed(4)} · ${x.perfect}/${rs.length} perfect · total $${x.totalCost.toFixed(4)} · mean ${Math.round(x.meanMs)}ms/journey`);
}
const mono = Math.min(summary['monolith-sonnet']!.totalCost, summary['monolith-gptfull']!.totalCost);
const routed = summary['potion-routed']!.totalCost;
console.log(`\n  cheapest monolith total $${mono.toFixed(4)} vs routed $${routed.toFixed(4)} → routed is ${(mono / routed).toFixed(1)}x cheaper`);
console.log(`  total spend this experiment: $${spent.toFixed(4)} (cap $${CAP})`);

mkdirSync(ART, { recursive: true });
writeFileSync(`${ART}/journey-equivalence.json`, JSON.stringify({ at: new Date().toISOString(), picks, runs, summary }, null, 1));
appendFileSync(`${ART}/ledger.jsonl`, `${JSON.stringify({ at: new Date().toISOString(), week: 'journey', lane: 'journey-equivalence', spendUsd: spent })}\n`);
