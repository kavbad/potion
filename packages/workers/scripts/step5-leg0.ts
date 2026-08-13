// Lab Step 5 — LEG 0 (pure, $0, no db, no network): re-derive the per-cluster
// spend projection with the repo's OWN estimator (G0.2 projectRunCostUsd) and
// hold it against the approved spec table. Drift >20% on any cluster → exit 1
// and the live legs do not start (review outcome 2).
//
//   PATH="$HOME/.local/bin:$PATH" pnpm --filter @potion/workers exec tsx scripts/step5-leg0.ts
//
// Assumes the operator minimum: OPENROUTER_API_KEY only — representatives are
// resolved from the openrouter-routed registry slice, exactly what the live
// legs will use. No key is read; this is arithmetic.
import { fileURLToPath } from 'node:url';
import type { EvalItem, StrategyConfig } from '@potion/core';
import { loadSuite, loadSuiteV2, projectRunCostUsd } from '@potion/harness';
import { loadPrices } from '@potion/providers';
import { buildRegistry, classRepresentative } from '@potion/researcher';
import {
  LIVE_SWEEP_ANSWER_MAX_TOKENS,
  LIVE_SWEEP_JUDGE_MAX_TOKENS,
  PLATFORM_SUITE_BY_CLUSTER,
  PLATFORM_SWEEP_CASCADE_CONFIDENCE_BELOW,
} from '../src/handlers.js';

const REPO_PRICES = fileURLToPath(new URL('../../../prices.json', import.meta.url));
const SAMPLE_N = 15;
const SUB_CAP_USD = 6;
// The approved spec's Tier B per-cluster CEILINGS (docs/specs/step-05:
// $5.54 at the assumed 15 items; deviation 1 measured the small suites at
// 14 items → their ceiling is 14/15 of that. The drift guard is against the
// APPROVED numbers, so the original ceiling is what we hold against).
const SPEC_CEILING_USD = 5.54;
const DRIFT_LIMIT = 0.2;

const { table: prices } = loadPrices(REPO_PRICES);
const registry = buildRegistry(prices).filter((e) => e.provider === 'openrouter');
const rep = (cls: 'cheap' | 'mid' | 'strong' | 'judge') => {
  const r = classRepresentative(registry, cls);
  if (!r) throw new Error(`no openrouter ${cls} representative`);
  return r;
};
const cheap = rep('cheap');
const mid = rep('mid');
const strong = rep('strong');
const judge = rep('judge');
const strategies: StrategyConfig[] = [
  { type: 'single', model: cheap.alias },
  { type: 'single', model: mid.alias },
  { type: 'single', model: strong.alias },
  {
    type: 'cascade',
    stages: [
      { model: cheap.alias, escalateIf: { confidenceBelow: PLATFORM_SWEEP_CASCADE_CONFIDENCE_BELOW } },
      { model: strong.alias },
    ],
    confidenceMethod: 'self-report-calibrated',
  },
];
console.log(
  `candidates: ${cheap.alias} / ${mid.alias} / ${strong.alias} + cascade(${cheap.alias}→${strong.alias}); judge ${judge.alias}`,
);
console.log(`sample ${SAMPLE_N}/cluster, answer cap ${LIVE_SWEEP_ANSWER_MAX_TOKENS}, judge cap ${LIVE_SWEEP_JUDGE_MAX_TOKENS}\n`);
console.log('cluster                | items | projected | spec ceiling | drift');
console.log('-----------------------|-------|-----------|--------------|------');

let total = 0;
let failed = false;
for (const [clusterId, mapped] of Object.entries(PLATFORM_SUITE_BY_CLUSTER)) {
  const all: EvalItem[] = mapped.kind === 'v1' ? loadSuite(mapped.suiteId) : loadSuiteV2(mapped.suiteId).items;
  const sampled = [...all]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, SAMPLE_N)
    // The handler's judgeModelOverride transform, mirrored so the
    // projection prices the judge the legs will actually use.
    .map((i) =>
      i.scoring.kind === 'llm-judge' ? { ...i, scoring: { ...i.scoring, judgeModel: judge.alias } } : i,
    );
  const projected = projectRunCostUsd(
    strategies,
    sampled,
    prices,
    LIVE_SWEEP_ANSWER_MAX_TOKENS,
    LIVE_SWEEP_JUDGE_MAX_TOKENS,
  );
  total += projected;
  const drift = projected / SPEC_CEILING_USD - 1;
  const flag = drift > DRIFT_LIMIT ? '  << DRIFT >20% — STOP' : '';
  if (drift > DRIFT_LIMIT) failed = true;
  if (projected > SUB_CAP_USD) {
    // The estimator projecting past the sub-cap means the leg's own
    // preflight would refuse — surface it here, not mid-campaign.
    console.log(`   note: projection exceeds the $${SUB_CAP_USD} sub-cap — the leg preflight would refuse`);
    failed = true;
  }
  console.log(
    `${clusterId.padEnd(22)} | ${String(sampled.length).padStart(5)} | ${('$' + projected.toFixed(4)).padStart(9)} | ${('$' + SPEC_CEILING_USD.toFixed(2)).padStart(12)} | ${(drift * 100).toFixed(0).padStart(4)}%${flag}`,
  );
}
console.log(`\nTOTAL projected (estimator, worst-case call plan): $${total.toFixed(2)} against the $60 approved cap`);
if (failed) {
  console.error('\nLEG 0 FAILED: drift guard tripped — stop for re-approval (review outcome 2).');
  process.exit(1);
}
console.log('LEG 0 OK: every cluster within the approved envelope.');
