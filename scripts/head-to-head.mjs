// HEAD-TO-HEAD: Potion vs openrouter/auto vs a fixed incumbent (2026-09-17).
//
// The 2026-09-07 head-to-head lived outside the repo and is gone; only its
// findings survive (memory + code comments). This one is committed.
//
// THREE ARMS per item, same items, same scorer:
//   potion   — POST /v1/chat/completions on the live API as a customer would
//              (potion-auto, a named 0.95-floor policy via x-potion-policy),
//              metered by the receipt the response carries (potion.cost_usd).
//   auto     — openrouter/auto called directly with usage accounting on;
//              cost is OpenRouter's own usage.cost (the auto-router has no
//              list price — the catalogue scanner excludes it for that).
//   incumbent— a fixed model called directly through OpenRouter (default
//              anthropic/claude-sonnet-4.5, what two consenting customers
//              named), same usage.cost.
//
// ITEMS: the platform suites, per kind of work, through the SAME map the
// platform sweep uses (PLATFORM_SUITE_BY_CLUSTER), first N items by id —
// byte-stable, like the sweep. SCORING: the harness scorers, verbatim
// (scoreAnswer): exact / field-match / field-contains / tool-call /
// code-exec / llm-judge with the platform's live judge. Every arm is scored
// by the same instrument, so quality is comparable ACROSS ARMS; it is also
// the instrument the frontiers were measured on.
//
// LESSONS BUILT IN (2026-09-07): report which items decide the headline
// (two agentic items set it last time); a realistic output budget (the 11
// failures were max_tokens=64 starving reasoning models); bootstrap
// intervals on every ratio; Potion's fallback rate and resolved cluster per
// item; which model the auto-router actually picked.
//
// Runs INSIDE the server container (node 22, built packages, OPENROUTER key):
//   docker cp head-to-head.mjs deploy-server-1:/app/head-to-head.mjs
//   docker exec -e POTION_API_KEY=… -e H2H_CAP_USD=30 -w /app deploy-server-1 node /app/head-to-head.mjs
// Env: POTION_API_URL (default https://api.withpotion.com), POTION_API_KEY,
//      POTION_POLICY (default h2h-floor-0.95), OPENROUTER_API_KEY,
//      H2H_PER_CLUSTER (20), H2H_MAX_TOKENS (1600), H2H_CAP_USD (30),
//      H2H_INCUMBENT (anthropic/claude-sonnet-4.5), H2H_OUT (/app/h2h-out).
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const req = createRequire('/app/packages/workers/package.json');
const { PLATFORM_SUITE_BY_CLUSTER } = req('/app/packages/workers/dist/handlers.js');
const { scoreAnswer } = req('/app/packages/harness/dist/scorers.js');
const { createProviders, loadPrices } = req('/app/packages/providers/dist/index.js');
const { buildRegistry, classRepresentative } = req('/app/packages/researcher/dist/index.js');
const { createDb, loadModelRegistry } = req('/app/packages/db/dist/index.js');

const API = process.env.POTION_API_URL ?? 'https://api.withpotion.com';
const KEY = process.env.POTION_API_KEY;
const POLICY = process.env.POTION_POLICY ?? 'h2h-floor-0.95';
const OR_KEY = process.env.OPENROUTER_API_KEY;
const PER_CLUSTER = Number(process.env.H2H_PER_CLUSTER ?? 20);
const MAX_TOKENS = Number(process.env.H2H_MAX_TOKENS ?? 1600);
const CAP_USD = Number(process.env.H2H_CAP_USD ?? 30);
const INCUMBENT = process.env.H2H_INCUMBENT ?? 'anthropic/claude-sonnet-4.5';
const OUT = process.env.H2H_OUT ?? '/app/h2h-out';
const JUDGE_MAX_TOKENS = 768;
const CONCURRENCY = 3;
const SAVE_ANSWERS = process.env.H2H_SAVE_ANSWERS !== '0';
const answers = [];
if (!KEY) throw new Error('POTION_API_KEY is required');
if (!OR_KEY) throw new Error('OPENROUTER_API_KEY is required');

const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);

// ---- prices, providers, judge (the platform's own) ----
const handle = await createDb();
let prices = await loadModelRegistry(handle.db).catch(() => null);
if (!prices) prices = loadPrices('/app/prices.json').table;
const providers = createProviders({ prices });
// The platform's live judge: registry filtered to REACHABLE live providers
// (the mock provider and any provider without a key are not candidates —
// resolveEvalJudge does exactly this; without the filter the dry run picked
// mock-judge and every judged item was scored by a fake).
const ENV_BY_PROVIDER = { openrouter: 'OPENROUTER_API_KEY', openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', google: 'GOOGLE_API_KEY' };
const reachable = (p) => p !== 'mock' && Boolean(process.env[ENV_BY_PROVIDER[p] ?? ''] && process.env[ENV_BY_PROVIDER[p] ?? ''].trim());
const judge = classRepresentative(buildRegistry(prices).filter((e) => reachable(e.provider)), 'judge');
const judgeAlias = judge?.alias;
if (!judgeAlias) throw new Error('no judge in the registry');
const judgeEntry = prices.entries.find((e) => e.alias === judgeAlias);
const pricesLabel = prices.version.length > 48 ? `${prices.version.slice(0, 48)}… (+${prices.version.length - 48} chars)` : prices.version;
log(`prices ${pricesLabel} (${prices.entries.length} entries); judge ${judgeAlias} (${judgeEntry?.model})`);

// ---- items ----
function loadSuite(kind, suiteId) {
  const path = kind === 'v1' ? `/app/packages/harness/suites/${suiteId}.jsonl` : `/app/packages/harness/suites/v2/${suiteId}/items.jsonl`;
  const items = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('//')).map((l) => JSON.parse(l));
  items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return items.slice(0, PER_CLUSTER).map((it) => {
    // The platform overrides a suite's placeholder judge with its live judge.
    if (it.scoring?.kind === 'llm-judge' && (!it.scoring.judgeModel || /^mock/.test(it.scoring.judgeModel))) {
      return { ...it, scoring: { ...it.scoring, judgeModel: judgeAlias } };
    }
    return it;
  });
}
const clusters = Object.keys(PLATFORM_SUITE_BY_CLUSTER);
const items = [];
for (const c of clusters) {
  const m = PLATFORM_SUITE_BY_CLUSTER[c];
  for (const it of loadSuite(m.kind, m.suiteId)) items.push({ ...it, clusterId: it.clusterId ?? c, suiteId: m.suiteId, labelCluster: c });
}
log(`${items.length} items across ${clusters.length} kinds of work (${PER_CLUSTER}/cluster max)`);

// ---- spend belt ----
let spent = 0;
function charge(usd, what) {
  spent += usd;
  if (spent > CAP_USD) throw new Error(`cap reached: $${spent.toFixed(4)} > $${CAP_USD} (${what})`);
}

// ---- the arms ----
const usageCostFromPrices = (entry, u) => entry ? ((u.inputTokens ?? 0) * entry.inputPer1M + (u.outputTokens ?? 0) * entry.outputPer1M) / 1e6 : 0;

async function callPotion(item) {
  const body = { model: 'potion-auto', messages: item.prompt, max_tokens: MAX_TOKENS, temperature: 0, ...(item.tools ? { tools: item.tools } : {}) };
  const t0 = Date.now();
  const res = await fetch(`${API}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', 'x-potion-policy': POLICY },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  const latencyMs = Date.now() - t0;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, status: res.status, error: json?.error?.message ?? `HTTP ${res.status}`, latencyMs, costUsd: 0 };
  const msg = json.choices?.[0]?.message ?? {};
  const routing = json.potion ?? {};
  return {
    ok: true, latencyMs,
    answer: msg.content ?? '',
    toolCalls: msg.tool_calls ?? undefined,
    costUsd: typeof routing.cost_usd === 'number' ? routing.cost_usd : 0,
    model: routing.model ?? null,
    resolvedCluster: routing.resolved_cluster ?? null,
    fallback: routing.fallback === true,
    fallbackReason: routing.fallback_reason ?? null,
    trace: res.headers.get('x-frontier-trace'),
  };
}

async function callOpenRouter(item, model) {
  const body = { model, messages: item.prompt, max_tokens: MAX_TOKENS, temperature: 0, usage: { include: true }, ...(item.tools ? { tools: item.tools } : {}) };
  const t0 = Date.now();
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${OR_KEY}`, 'content-type': 'application/json', 'HTTP-Referer': 'https://withpotion.com', 'X-Title': 'potion head-to-head' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  const latencyMs = Date.now() - t0;
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) return { ok: false, status: res.status, error: json?.error?.message ?? `HTTP ${res.status}`, latencyMs, costUsd: 0 };
  const msg = json.choices?.[0]?.message ?? {};
  return {
    ok: true, latencyMs,
    answer: msg.content ?? '',
    toolCalls: msg.tool_calls ?? undefined,
    costUsd: typeof json.usage?.cost === 'number' ? json.usage.cost : 0,
    model: json.model ?? model,
  };
}

async function score(item, arm) {
  if (!arm.ok) return { quality: 0, scorer: 'unanswered', judgeCostUsd: 0 };
  try {
    const out = await scoreAnswer(item, arm.answer, { providers, prices }, JUDGE_MAX_TOKENS, arm.toolCalls);
    const judgeCostUsd = out.scorerUsage ? usageCostFromPrices(judgeEntry, out.scorerUsage) : 0;
    return { quality: out.quality, scorer: out.scorer, judgeCostUsd };
  } catch (e) {
    return { quality: null, scorer: `unscorable: ${String(e.message ?? e).slice(0, 120)}`, judgeCostUsd: 0 };
  }
}

// ---- run ----
const rows = [];
let idx = 0;
async function worker() {
  for (;;) {
    const i = idx++;
    if (i >= items.length) return;
    const item = items[i];
    const row = { id: item.id, cluster: item.labelCluster, suiteId: item.suiteId, scoring: item.scoring.kind, arms: {} };
    try {
      const [p, a, s] = await Promise.all([callPotion(item), callOpenRouter(item, 'openrouter/auto'), callOpenRouter(item, INCUMBENT)]);
      for (const [name, arm] of [['potion', p], ['auto', a], ['incumbent', s]]) {
        charge(arm.costUsd, `${name} ${item.id}`);
        const sc = await score(item, arm);
        charge(sc.judgeCostUsd, `judge ${name} ${item.id}`);
        // Sidecar: the answer text itself, so a SECOND judge (e.g. Jev) can be
        // run over exactly these answers later without re-spending on models.
        if (SAVE_ANSWERS) answers.push({ id: item.id, cluster: item.labelCluster, arm: name, answer: arm.answer ?? null, toolCalls: arm.toolCalls ?? null, quality: sc.quality, scorer: sc.scorer });
        row.arms[name] = { ok: arm.ok, error: arm.error ?? null, costUsd: arm.costUsd, latencyMs: arm.latencyMs, model: arm.model ?? null, quality: sc.quality, scorer: sc.scorer, judgeCostUsd: sc.judgeCostUsd,
          ...(name === 'potion' ? { resolvedCluster: arm.resolvedCluster ?? null, fallback: arm.fallback ?? null, fallbackReason: arm.fallbackReason ?? null, trace: arm.trace ?? null } : {}) };
      }
    } catch (e) {
      row.error = String(e.message ?? e);
      rows.push(row);
      if (/cap reached/.test(row.error)) throw e;
      continue;
    }
    rows.push(row);
    if (rows.length % 10 === 0) log(`${rows.length}/${items.length} items, spent $${spent.toFixed(3)}`);
  }
}
let stopped = null;
try {
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
} catch (e) {
  stopped = String(e.message ?? e);
  log('STOPPED:', stopped);
}

// ---- stats ----
const arms = ['potion', 'auto', 'incumbent'];
const scored = rows.filter((r) => !r.error && arms.every((a) => r.arms[a] && r.arms[a].quality !== null));
function summarize(subset) {
  const out = {};
  for (const a of arms) {
    const qs = subset.map((r) => r.arms[a].quality);
    const cs = subset.map((r) => r.arms[a].costUsd);
    out[a] = { n: subset.length, quality: mean(qs), costUsd: sum(cs), answered: subset.filter((r) => r.arms[a].ok).length };
  }
  out.ratio = { potionVsAuto: ratioCi(subset, 'potion', 'auto'), potionVsIncumbent: ratioCi(subset, 'potion', 'incumbent') };
  return out;
}
function mean(xs) { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null; }
function sum(xs) { return xs.reduce((s, x) => s + x, 0); }
function ratioCi(subset, a, b, resamples = 2000) {
  if (subset.length === 0) return null;
  const point = sum(subset.map((r) => r.arms[a].costUsd)) / Math.max(1e-12, sum(subset.map((r) => r.arms[b].costUsd)));
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const rs = [];
  for (let k = 0; k < resamples; k++) {
    let na = 0, nb = 0;
    for (let j = 0; j < subset.length; j++) { const r = subset[Math.floor(rnd() * subset.length)]; na += r.arms[a].costUsd; nb += r.arms[b].costUsd; }
    rs.push(na / Math.max(1e-12, nb));
  }
  rs.sort((x, y) => x - y);
  return { point, ci95: [rs[Math.floor(0.025 * rs.length)], rs[Math.floor(0.975 * rs.length)]] };
}
const byCluster = {};
for (const c of clusters) byCluster[c] = summarize(scored.filter((r) => r.cluster === c));
const overall = summarize(scored);
const deciders = [...scored].sort((x, y) => y.arms.potion.costUsd - x.arms.potion.costUsd).slice(0, 5).map((r) => ({ id: r.id, cluster: r.cluster, resolvedCluster: r.arms.potion.resolvedCluster, potionCostUsd: r.arms.potion.costUsd, autoCostUsd: r.arms.auto.costUsd, model: r.arms.potion.model }));
const fallbackRate = scored.length ? scored.filter((r) => r.arms.potion.fallback).length / scored.length : null;
const misrouted = scored.filter((r) => r.arms.potion.resolvedCluster && r.arms.potion.resolvedCluster !== r.cluster).length;
const autoPicks = {};
for (const r of scored) autoPicks[r.arms.auto.model] = (autoPicks[r.arms.auto.model] ?? 0) + 1;

const result = {
  ranAt: new Date().toISOString(), api: API, policy: POLICY, incumbent: INCUMBENT, judge: judgeAlias, judgeModel: judgeEntry?.model ?? null, pricesVersion: prices.version,
  perCluster: PER_CLUSTER, maxTokens: MAX_TOKENS, capUsd: CAP_USD, spentUsd: spent, stopped,
  items: items.length, scored: scored.length, errored: rows.filter((r) => r.error).length,
  overall, byCluster, potionFallbackRate: fallbackRate, potionResolvedOffLabel: misrouted, autoPicks, headlineDeciders: deciders, rows,
};
mkdirSync(OUT, { recursive: true });
const stamp = result.ranAt.slice(0, 10);
writeFileSync(join(OUT, `${stamp}.json`), JSON.stringify(result, null, 2));
if (SAVE_ANSWERS) writeFileSync(join(OUT, `${stamp}.answers.json`), JSON.stringify({ ranAt: result.ranAt, policy: POLICY, judge: judgeAlias, answers }, null, 0));

const f4 = (x) => (x === null || x === undefined ? '—' : `$${x.toFixed(4)}`);
const q = (x) => (x === null || x === undefined ? '—' : x.toFixed(3));
const ci = (r) => (r ? `${r.point.toFixed(2)}x [${r.ci95[0].toFixed(2)}–${r.ci95[1].toFixed(2)}]` : '—');
let md = `# Head-to-head — ${stamp}\n\n`;
md += `Potion (\`potion-auto\`, policy \`${POLICY}\`) vs \`openrouter/auto\` vs \`${INCUMBENT}\`, ${scored.length} scored items across ${clusters.length} kinds of work (${PER_CLUSTER}/cluster max), max_tokens ${MAX_TOKENS}, judge ${judgeAlias}, prices ${pricesLabel}. Spent $${spent.toFixed(2)} of a $${CAP_USD} cap${stopped ? ` — STOPPED: ${stopped}` : ''}.\n\n`;
md += `| | Potion | auto | incumbent |\n|---|---|---|---|\n`;
md += `| quality (mean) | ${q(overall.potion.quality)} | ${q(overall.auto.quality)} | ${q(overall.incumbent.quality)} |\n`;
md += `| cost (total) | ${f4(overall.potion.costUsd)} | ${f4(overall.auto.costUsd)} | ${f4(overall.incumbent.costUsd)} |\n`;
md += `| answered | ${overall.potion.answered}/${overall.potion.n} | ${overall.auto.answered}/${overall.auto.n} | ${overall.incumbent.answered}/${overall.incumbent.n} |\n\n`;
md += `**Cost ratio, Potion ÷ auto: ${ci(overall.ratio.potionVsAuto)}. Potion ÷ incumbent: ${ci(overall.ratio.potionVsIncumbent)}.** Potion fallback rate ${fallbackRate === null ? '—' : (fallbackRate * 100).toFixed(1) + '%'}; resolved off the suite's label on ${misrouted} item(s).\n\n`;
md += `## Per kind of work\n\n| kind of work | n | Potion q | auto q | incumbent q | Potion $ | auto $ | incumbent $ | Potion÷auto | Potion÷incumbent |\n|---|---|---|---|---|---|---|---|---|---|\n`;
for (const c of clusters) { const s = byCluster[c]; if (!s.potion.n) continue; md += `| ${c} | ${s.potion.n} | ${q(s.potion.quality)} | ${q(s.auto.quality)} | ${q(s.incumbent.quality)} | ${f4(s.potion.costUsd)} | ${f4(s.auto.costUsd)} | ${f4(s.incumbent.costUsd)} | ${ci(s.ratio.potionVsAuto)} | ${ci(s.ratio.potionVsIncumbent)} |\n`; }
md += `\n## What decided the headline (Potion's five costliest items)\n\n| item | label | resolved | Potion $ | auto $ | served |\n|---|---|---|---|---|---|\n`;
for (const d of deciders) md += `| ${d.id} | ${d.cluster} | ${d.resolvedCluster ?? '—'} | ${f4(d.potionCostUsd)} | ${f4(d.autoCostUsd)} | ${d.model ?? '—'} |\n`;
md += `\n## What the auto-router picked\n\n` + Object.entries(autoPicks).sort((a, b) => b[1] - a[1]).map(([m, n]) => `- ${m}: ${n}`).join('\n') + '\n';
if (result.errored) md += `\n${result.errored} item(s) errored and are excluded from every number above.\n`;
writeFileSync(join(OUT, `${stamp}.md`), md);
log(`done: ${scored.length} scored, spent $${spent.toFixed(3)}; wrote ${OUT}/${stamp}.{json,md}`);
await handle.close().catch(() => {});
process.exit(0);
