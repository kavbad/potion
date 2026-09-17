// JEV TRIAL (2026-09-17): does TypeSafe's Jev earn a place as Potion's
// classifier, and as a second judge? Two experiments, both offline, both on
// Potion's own labelled data — never on serving.
//
//   node scripts/jev-trial.mjs classify   # accuracy + calibration vs the labels
//   node scripts/jev-trial.mjs judge <answers.json>   # agreement with the Sonnet judge
//
// CLASSIFY: every item in packages/cluster/data/heldout.jsonl (200, labelled,
// independently authored) and every platform-suite item the head-to-head
// used (182, labelled by suite). One `choice` over the ten taxonomy clusters
// with the taxonomy's own descriptions as criteria. Reports accuracy, the
// confusion pairs, and — the claim nobody has verified — CALIBRATION:
// accuracy binned by Jev's returned confidence. A calibrated classifier's
// 0.9-confidence bin is right ~90% of the time; an overconfident one is not.
//
// JUDGE: the head-to-head's answers sidecar (scripts/head-to-head.mjs with
// H2H_SAVE_ANSWERS) holds every answer with the Sonnet judge's score. Jev
// scores the same answers with the same rubric as a `score` question whose
// levels are the rubric scale; report agreement (Pearson, mean |Δ|) per
// kind of work and per scorer kind. This is the instrument-change question:
// where Jev agrees with the judge every frontier was measured with, it can
// carry volume; where it does not, it cannot.
//
// Env: TYPESAFE_API_KEY (read from ~/.typesafe-key when unset), JEV_MODEL
// (jev-latest), JEV_CONCURRENCY (4), JEV_OUT (artifacts/jev-trial).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KEY = (process.env.TYPESAFE_API_KEY ?? readFileSync(join(homedir(), '.typesafe-key'), 'utf8')).trim();
const MODEL = process.env.JEV_MODEL ?? 'jev-latest';
const CONCURRENCY = Number(process.env.JEV_CONCURRENCY ?? 4);
const OUT = process.env.JEV_OUT ?? join(ROOT, 'artifacts', 'jev-trial');
const mode = process.argv[2];
if (!['classify', 'judge'].includes(mode)) { console.error('usage: jev-trial.mjs classify | judge <answers.json>'); process.exit(2); }

const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);
let inputTokens = 0, calls = 0;

async function jev(state, questions) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch('https://api.typesafe.ai/v1/systemone', {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, state, questions }),
      signal: AbortSignal.timeout(60_000),
    });
    if (res.status === 429 || res.status === 529) { await new Promise((r) => setTimeout(r, 500 * 2 ** attempt)); continue; }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`jev ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
    calls += 1; inputTokens += json.usage?.input_tokens ?? 0;
    return json;
  }
  throw new Error('jev: rate-limited five times');
}

async function pool(items, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => { for (;;) { const k = i++; if (k >= items.length) return; out[k] = await fn(items[k], k); if ((k + 1) % 25 === 0) log(`${k + 1}/${items.length}`); } }));
  return out;
}

const taxonomy = JSON.parse(readFileSync(join(ROOT, 'packages/cluster/data/taxonomy.json'), 'utf8'));
const CLUSTERS = taxonomy.clusters.map((c) => c.id);
const CRITERIA = Object.fromEntries(taxonomy.clusters.map((c) => [c.id, c.description]));
const pricePerMTok = 0.042;

// ---------------- classify ----------------
if (mode === 'classify') {
  const heldout = readFileSync(join(ROOT, 'packages/cluster/data/heldout.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((it) => ({ id: it.id, label: it.clusterId, text: it.text, source: 'heldout' }));
  // the same suite items the head-to-head used, labelled by their suite
  const { PLATFORM_SUITE_BY_CLUSTER } = await import(join(ROOT, 'packages/workers/dist/handlers.js')).catch(() => ({ PLATFORM_SUITE_BY_CLUSTER: null }));
  const suiteItems = [];
  if (PLATFORM_SUITE_BY_CLUSTER) {
    for (const [cluster, m] of Object.entries(PLATFORM_SUITE_BY_CLUSTER)) {
      const path = m.kind === 'v1' ? join(ROOT, `packages/harness/suites/${m.suiteId}.jsonl`) : join(ROOT, `packages/harness/suites/v2/${m.suiteId}/items.jsonl`);
      if (!existsSync(path)) continue;
      const items = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('//')).map((l) => JSON.parse(l)).sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, 20);
      for (const it of items) suiteItems.push({ id: it.id, label: cluster, text: it.prompt.map((m) => `${m.role}: ${m.content}`).join('\n'), source: 'suite' });
    }
  }
  const items = [...heldout, ...suiteItems];
  log(`${items.length} items (${heldout.length} held-out + ${suiteItems.length} suite)`);
  const rows = await pool(items, async (it) => {
    const t0 = Date.now();
    try {
      const r = await jev({ request: it.text }, {
        kind_of_work: { type: 'choice', instructions: 'Which kind of work is this request asking a language model to do? Pick the single best-fitting kind.', criteria: CRITERIA },
        needs_tools: { type: 'noul', instructions: 'Completing this request well requires calling external tools or APIs, not just writing text or code.' },
      });
      const a = r.answers.kind_of_work;
      const probs = a.probabilities ?? {};
      const ranked = Object.entries(probs).sort((x, y) => y[1] - x[1]);
      return { ...it, pred: a.choice, confidence: a.confidence ?? null, p1: ranked[0]?.[1] ?? null, runnerUp: ranked[1]?.[0] ?? null, p2: ranked[1]?.[1] ?? null, needsTools: r.answers.needs_tools?.noul ?? null, ms: Date.now() - t0 };
    } catch (e) { return { ...it, error: String(e.message ?? e), ms: Date.now() - t0 }; }
  });
  const ok = rows.filter((r) => !r.error);
  const acc = (rs) => rs.length ? rs.filter((r) => r.pred === r.label).length / rs.length : null;
  const byCluster = {}; for (const c of CLUSTERS) { const rs = ok.filter((r) => r.label === c); byCluster[c] = { n: rs.length, accuracy: acc(rs) }; }
  const confusions = {}; for (const r of ok.filter((r) => r.pred !== r.label)) { const k = `${r.label}→${r.pred}`; confusions[k] = (confusions[k] ?? 0) + 1; }
  // calibration: bin by returned confidence (and by top probability)
  const bins = [[0, 0.5], [0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 1.01]];
  const calib = (field) => bins.map(([lo, hi]) => { const rs = ok.filter((r) => r[field] !== null && r[field] >= lo && r[field] < hi); return { bin: `${lo}–${Math.min(hi, 1)}`, n: rs.length, accuracy: acc(rs), meanConf: rs.length ? rs.reduce((s, r) => s + r[field], 0) / rs.length : null }; });
  const ece = (field) => { let e = 0; for (const b of calib(field)) if (b.n) e += (b.n / ok.length) * Math.abs(b.accuracy - b.meanConf); return e; };
  const ms = ok.map((r) => r.ms).sort((a, b) => a - b);
  const result = { ranAt: new Date().toISOString(), model: MODEL, items: items.length, scored: ok.length, errored: rows.length - ok.length, calls, inputTokens, costUsd: inputTokens / 1e6 * pricePerMTok,
    accuracy: { all: acc(ok), heldout: acc(ok.filter((r) => r.source === 'heldout')), suite: acc(ok.filter((r) => r.source === 'suite')) },
    latencyMs: { p50: ms[Math.floor(ms.length * 0.5)], p95: ms[Math.floor(ms.length * 0.95)] },
    byCluster, confusions: Object.fromEntries(Object.entries(confusions).sort((a, b) => b[1] - a[1])),
    calibration: { byConfidence: calib('confidence'), byTopProbability: calib('p1'), eceConfidence: ece('confidence'), eceTopProbability: ece('p1') },
    rows };
  mkdirSync(OUT, { recursive: true });
  const stamp = result.ranAt.slice(0, 10);
  writeFileSync(join(OUT, `${stamp}-classify.json`), JSON.stringify(result, null, 2));
  const pct = (x) => (x === null ? '—' : `${(x * 100).toFixed(1)}%`);
  let md = `# Jev classifier trial — ${stamp}\n\n${MODEL}; ${ok.length} items (${result.accuracy.heldout === null ? 0 : heldout.length} held-out, ${suiteItems.length} suite), ${calls} calls, ${inputTokens} input tokens, $${result.costUsd.toFixed(4)}. Latency p50 ${result.latencyMs.p50} ms, p95 ${result.latencyMs.p95} ms.\n\n`;
  md += `| set | accuracy |\n|---|---|\n| held-out (200, independently authored) | ${pct(result.accuracy.heldout)} |\n| suite items (the head-to-head's 182) | ${pct(result.accuracy.suite)} |\n| all | ${pct(result.accuracy.all)} |\n\nPotion's centroid classifier: 96.0% on the same held-out set (192/200); 15% off-label on the suite items in today's head-to-head.\n\n`;
  md += `## Per kind of work\n\n| kind of work | n | accuracy |\n|---|---|---|\n` + CLUSTERS.map((c) => `| ${c} | ${byCluster[c].n} | ${pct(byCluster[c].accuracy)} |`).join('\n') + '\n\n';
  md += `## Calibration (accuracy binned by returned confidence)\n\nECE by confidence ${result.calibration.eceConfidence.toFixed(3)}; by top probability ${result.calibration.eceTopProbability.toFixed(3)}. A calibrated model's accuracy in each bin ≈ its mean confidence.\n\n| confidence bin | n | accuracy | mean confidence |\n|---|---|---|---|\n` + result.calibration.byConfidence.map((b) => `| ${b.bin} | ${b.n} | ${pct(b.accuracy)} | ${b.meanConf === null ? '—' : b.meanConf.toFixed(3)} |`).join('\n') + '\n\n';
  md += `## Confusions\n\n` + Object.entries(result.confusions).slice(0, 12).map(([k, n]) => `- ${k}: ${n}`).join('\n') + '\n';
  writeFileSync(join(OUT, `${stamp}-classify.md`), md);
  log(`done: accuracy all ${pct(result.accuracy.all)}, ECE ${result.calibration.eceConfidence.toFixed(3)}, $${result.costUsd.toFixed(4)}; wrote ${OUT}/${stamp}-classify.{md,json}`);
}

// ---------------- judge ----------------
if (mode === 'judge') {
  const src = process.argv[3];
  if (!src) { console.error('judge mode needs the answers sidecar path'); process.exit(2); }
  const sidecar = JSON.parse(readFileSync(src, 'utf8'));
  // rubric + scale per item id, from the suites
  const { PLATFORM_SUITE_BY_CLUSTER } = await import(join(ROOT, 'packages/workers/dist/handlers.js'));
  const byId = new Map();
  for (const [cluster, m] of Object.entries(PLATFORM_SUITE_BY_CLUSTER)) {
    const path = m.kind === 'v1' ? join(ROOT, `packages/harness/suites/${m.suiteId}.jsonl`) : join(ROOT, `packages/harness/suites/v2/${m.suiteId}/items.jsonl`);
    if (!existsSync(path)) continue;
    for (const l of readFileSync(path, 'utf8').split('\n')) { if (!l.trim() || l.startsWith('//')) continue; const it = JSON.parse(l); byId.set(it.id, { ...it, cluster }); }
  }
  const answers = sidecar.answers.filter((a) => a.answer && a.quality !== null && byId.has(a.id));
  log(`${answers.length} answers with a stored score and a known item`);
  const rows = await pool(answers, async (a) => {
    const it = byId.get(a.id); const sc = it.scoring; const t0 = Date.now();
    try {
      const task = it.prompt.map((m) => `${m.role}: ${m.content}`).join('\n');
      const state = { task, ...(it.reference !== undefined ? { reference: typeof it.reference === 'string' ? it.reference : JSON.stringify(it.reference) } : {}), answer: a.answer };
      let q;
      if (sc.kind === 'llm-judge') {
        const [lo, hi] = sc.scale; const levels = [];
        for (let v = lo; v <= hi; v++) levels.push(`${v} of ${hi}`);
        // 11 levels exceeds Jev's 10-level cap: fold 0..10 into 0,2,4,6,8,10 when needed
        const crit = levels.length > 10 ? [0, 2, 4, 6, 8, 10].map((v) => `${v} of ${hi}`) : levels;
        q = { grade: { type: 'score', instructions: { rubric: sc.rubric, task: 'Score the ANSWER to the TASK using the rubric. Higher is better.' }, criteria: crit } };
      } else {
        // deterministic scorers: ask Jev the binary question the scorer decides
        q = { correct: { type: 'noul', instructions: { question: 'The ANSWER correctly and completely does what the TASK asks (compare against REFERENCE when present).', scorer: sc.kind } } };
      }
      const r = await jev(state, q);
      let jevQuality;
      if (q.grade) { const [lo, hi] = sc.scale; jevQuality = Math.max(0, Math.min(1, (r.answers.grade.score * (q.grade.criteria.length > 6 ? 1 : 2) - lo) / (hi - lo))); }
      else jevQuality = r.answers.correct.noul;
      return { id: a.id, cluster: a.cluster, arm: a.arm, scorer: sc.kind, sonnet: a.quality, jev: jevQuality, confidence: r.answers.grade?.confidence ?? null, ms: Date.now() - t0 };
    } catch (e) { return { id: a.id, cluster: a.cluster, arm: a.arm, scorer: sc.kind, sonnet: a.quality, error: String(e.message ?? e), ms: Date.now() - t0 }; }
  });
  const ok = rows.filter((r) => !r.error);
  const pearson = (rs) => { if (rs.length < 3) return null; const mx = rs.reduce((s, r) => s + r.sonnet, 0) / rs.length, my = rs.reduce((s, r) => s + r.jev, 0) / rs.length; let sxy = 0, sxx = 0, syy = 0; for (const r of rs) { sxy += (r.sonnet - mx) * (r.jev - my); sxx += (r.sonnet - mx) ** 2; syy += (r.jev - my) ** 2; } return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null; };
  const mad = (rs) => rs.length ? rs.reduce((s, r) => s + Math.abs(r.sonnet - r.jev), 0) / rs.length : null;
  const agree = (rs) => ({ n: rs.length, pearson: pearson(rs), meanAbsDiff: mad(rs), sonnetMean: rs.length ? rs.reduce((s, r) => s + r.sonnet, 0) / rs.length : null, jevMean: rs.length ? rs.reduce((s, r) => s + r.jev, 0) / rs.length : null });
  const byCluster = {}; for (const c of CLUSTERS) byCluster[c] = agree(ok.filter((r) => r.cluster === c));
  const byScorer = {}; for (const k of [...new Set(ok.map((r) => r.scorer))]) byScorer[k] = agree(ok.filter((r) => r.scorer === k));
  // does Jev rank the ARMS the same way per item? (the head-to-head's question)
  const perItem = new Map(); for (const r of ok) { if (!perItem.has(r.id)) perItem.set(r.id, []); perItem.get(r.id).push(r); }
  let sameWinner = 0, decided = 0;
  for (const rs of perItem.values()) { if (rs.length < 2) continue; const bs = [...rs].sort((a, b) => b.sonnet - a.sonnet), bj = [...rs].sort((a, b) => b.jev - a.jev); if (bs[0].sonnet === bs[1].sonnet) continue; decided += 1; if (bs[0].arm === bj[0].arm) sameWinner += 1; }
  const result = { ranAt: new Date().toISOString(), model: MODEL, source: src, answers: answers.length, scored: ok.length, errored: rows.length - ok.length, calls, inputTokens, costUsd: inputTokens / 1e6 * pricePerMTok, overall: agree(ok), byCluster, byScorer, armWinnerAgreement: { decidedItems: decided, sameWinner, rate: decided ? sameWinner / decided : null }, rows };
  mkdirSync(OUT, { recursive: true });
  const stamp = result.ranAt.slice(0, 10);
  writeFileSync(join(OUT, `${stamp}-judge.json`), JSON.stringify(result, null, 2));
  const f = (x, d = 3) => (x === null || x === undefined ? '—' : x.toFixed(d));
  let md = `# Jev as a second judge — ${stamp}\n\n${MODEL} vs the Sonnet-class judge (${sidecar.judge}) over ${ok.length} answers from the head-to-head (${src.split('/').pop()}); ${calls} calls, $${result.costUsd.toFixed(4)}.\n\n`;
  md += `**Overall:** Pearson ${f(result.overall.pearson)}, mean |Δ| ${f(result.overall.meanAbsDiff)} (Sonnet mean ${f(result.overall.sonnetMean)}, Jev mean ${f(result.overall.jevMean)}). **Same winning arm per item:** ${result.armWinnerAgreement.sameWinner}/${result.armWinnerAgreement.decidedItems} (${result.armWinnerAgreement.rate === null ? '—' : (result.armWinnerAgreement.rate * 100).toFixed(0) + '%'}).\n\n`;
  md += `## Per kind of work\n\n| kind of work | n | Pearson | mean abs diff | Sonnet mean | Jev mean |\n|---|---|---|---|---|---|\n` + CLUSTERS.map((c) => { const s = byCluster[c]; return `| ${c} | ${s.n} | ${f(s.pearson)} | ${f(s.meanAbsDiff)} | ${f(s.sonnetMean)} | ${f(s.jevMean)} |`; }).join('\n') + '\n\n';
  md += `## Per scorer kind\n\n| scorer | n | Pearson | mean abs diff |\n|---|---|---|---|\n` + Object.entries(byScorer).map(([k, s]) => `| ${k} | ${s.n} | ${f(s.pearson)} | ${f(s.meanAbsDiff)} |`).join('\n') + '\n';
  writeFileSync(join(OUT, `${stamp}-judge.md`), md);
  log(`done: pearson ${f(result.overall.pearson)}, same-winner ${result.armWinnerAgreement.rate === null ? '—' : (result.armWinnerAgreement.rate * 100).toFixed(0) + '%'}, $${result.costUsd.toFixed(4)}; wrote ${OUT}/${stamp}-judge.{md,json}`);
}
