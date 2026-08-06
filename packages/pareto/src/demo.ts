// Gate-4 demo (SPEC §6): Pareto frontier computation + new-model-release
// recompute, end to end with zero network and zero services
// (PGlite + memory queue + mock provider).
//
//   Part 1 — eval a fixed strategy set on the code-gen suite, INCLUDING one
//     deliberately dominated strategy (choice documented): a real, evaled
//     `ensemble(cheap-class ×3, fusion concat-rank)`. concat-rank fusion
//     CONCATENATES the three candidates in confidence order — nonsense for a
//     code task (broken syntax → ~0 quality) at 3× the cost of one cheap
//     call. It is dominated by a plain single(gpt-mini-class): higher
//     quality, an order of magnitude cheaper, same p95. We eval it for real
//     (rather than hand-inserting an aggregate row) so the exclusion is
//     demonstrated by the actual pipeline. The mock corpus also produces two
//     emergent exclusions the demo prints honestly: legacy cheap-class and
//     sonnet-class are strictly worse-priced same/latency-class versions of
//     gpt-mini-class, and the cascade loses to the judge-picked ensemble.
//   Part 2 — compute the frontier, print all candidates, which were excluded
//     as dominated (and by what), and the frontier table; persist frontier v1.
//   Part 3 — NEW MODEL RELEASE: register `mock-new-x` in a prices COPY
//     (the corpus accepts arbitrary mock aliases — the mock provider answers
//     any model string; the entry only needs to exist for costing. We map
//     alias mock-new-x → provider mock / model mock-mid: the mock treats
//     unknown alias names as mid-class corruption (0.25) with mid latency,
//     and we price it BELOW the mid class ($0.3/$1.2 vs sonnet-class $3/$15
//     per 1M tokens) — "quality between mid and frontier once composed into
//     the planned best-of-n / cascades, cost below mid").
//     runRecompute evals the planned shortlist, saves frontier v2, and prints
//     the FrontierDiff with its full buyer-readable narrative.
//
// Run: pnpm --filter @potion/pareto demo
import { fileURLToPath } from 'node:url';
import type { FrontierPoint, PriceEntry, StrategyConfig } from '@potion/core';
import { createDb, migrate } from '@potion/db';
import { runEval } from '@potion/harness';
import { loadPrices } from '@potion/providers';
import { createQueue } from '@potion/queue';
import {
  computeFrontier,
  describeStrategy,
  diffFrontiers,
  isDominated,
  runRecompute,
  saveFrontier,
} from './index.js';

const PRICES_PATH = fileURLToPath(new URL('../../../prices.json', import.meta.url));

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function printPointTable(title: string, rows: Array<{ point: FrontierPoint; note: string }>): void {
  console.log(`\n${title}`);
  console.log(
    pad('  strategy', 46) + pad('quality', 9) + pad('$/1K', 10) + pad('p95 ms', 9) + 'note',
  );
  console.log('  ' + '-'.repeat(92));
  for (const { point, note } of rows) {
    console.log(
      pad(`  ${describeStrategy(point.strategyConfig)}`, 46) +
        pad(point.quality.toFixed(3), 9) +
        pad(`$${point.costPer1K.toFixed(3)}`, 10) +
        pad(String(Math.round(point.latencyP95)), 9) +
        note,
    );
  }
}

async function main(): Promise<void> {
  console.log('═'.repeat(96));
  console.log('Potion Gate-4 demo — Pareto frontier + new-model-release recompute (mock world, zero services)');
  console.log('═'.repeat(96));

  const handle = await createDb('pglite://');
  await migrate(handle.db);
  const prices = loadPrices(PRICES_PATH).table;
  console.log(`\nprices.json v${prices.version} (${prices.entries.length} entries) · suite: code-gen (30 items)`);

  // ---- Part 1: baseline eval incl. one deliberately dominated strategy ----
  const strategies: StrategyConfig[] = [
    { type: 'single', model: 'cheap-class' }, // legacy cheap tier (emergent exclusion)
    { type: 'single', model: 'gpt-mini-class' }, // modern cheap tier
    { type: 'single', model: 'sonnet-class' }, // mid tier (emergent exclusion)
    { type: 'single', model: 'frontier-class' }, // top tier
    {
      type: 'cascade',
      stages: [
        { model: 'cheap-class', escalateIf: { confidenceBelow: 0.7 } },
        { model: 'frontier-class' },
      ],
      confidenceMethod: 'self-report-calibrated',
    },
    {
      type: 'ensemble',
      models: ['cheap-class', 'cheap-class'],
      fusion: { method: 'judge-pick', judge: { model: 'judge-class' } },
    },
    {
      // DELIBERATELY DOMINATED (see header): 3 cheap calls concatenated by a
      // confidence heuristic — 3× the cost of one cheap call for broken code.
      type: 'ensemble',
      models: ['cheap-class', 'cheap-class', 'cheap-class'],
      fusion: { method: 'concat-rank' },
    },
  ];

  console.log('\n[1/4] Evaluating 7 candidate strategies on code-gen (mock provider)…');
  // M1a quarantine: code-gen resolves under suites/simulated/ (mock-corpus-
  // derived). This demo is a CI simulation — opt in explicitly.
  const summary = await runEval(
    { suiteIds: ['code-gen'], strategies, budgetCapUsd: 5, provider: 'mock', simulatedOk: true },
    { db: handle, pricesPath: PRICES_PATH },
  );
  console.log(
    `    run ${summary.runId}: ${summary.executed} item-evals, spend $${summary.spendUsd.toFixed(4)} ` +
      `(projected $${summary.projectedSpendUsd.toFixed(4)})`,
  );

  // ---- Part 2: dominance analysis + frontier ----
  const aggs = summary.aggregates;
  const pool = aggs.map((a) => ({
    clusterId: a.clusterId,
    strategyHash: a.strategyHash,
    strategyConfig: a.strategyConfig,
    quality: a.qualityMean,
    costPer1K: a.costPer1K,
    latencyP95: a.latencyP95,
  }));
  const frontierPoints = computeFrontier(aggs);
  const onFrontier = new Set(frontierPoints.map((p) => p.strategyHash));

  console.log('\n[2/4] Dominance analysis over all candidates:');
  printPointTable(
    '  ALL CANDIDATES (excluded = dominated):',
    pool.map((p) => {
      const dominator = isDominated(p, pool);
      const note = dominator
        ? `EXCLUDED — dominated by ${describeStrategy(dominator.strategyConfig)}`
        : onFrontier.has(p.strategyHash)
          ? 'FRONTIER'
          : 'EXCLUDED — duplicate';
      return { point: p, note };
    }),
  );
  printPointTable(
    '  FRONTIER (non-dominated, sorted by $/1K asc):',
    frontierPoints.map((p) => ({ point: p, note: '' })),
  );

  const v1 = await saveFrontier(handle.db, 'code-gen', frontierPoints, 'manual', prices.version);
  console.log(`\n    saved frontier ${v1.id} as v${v1.version} (${frontierPoints.length} points)`);

  // ---- Part 3: NEW MODEL RELEASE ----
  const newModel: PriceEntry = {
    alias: 'mock-new-x',
    provider: 'mock',
    model: 'mock-mid', // alias → existing mock model mapping (documented above)
    inputPer1M: 0.3, // priced BELOW mid class (sonnet-class: $3/$15) and even
    outputPer1M: 1.2, // below the cheapest existing alias (gpt-mini: $0.4/$1.6)
  };
  console.log('\n[3/4] NEW MODEL RELEASE: mock-new-x — mid-class quality, priced below mid');
  console.log(`    ${JSON.stringify(newModel)}`);
  console.log('    running recompute (plan → eval jobs → frontier recompute + diff)…');

  const queue = createQueue('memory');
  const result = await runRecompute({
    db: handle,
    queue,
    newModel,
    clusterIds: ['code-gen'],
    pricesPath: PRICES_PATH,
    budgetCapUsd: 5,
  });
  await queue.close();

  console.log(`\n    planned shortlist (${result.plan.length} strategies, cap 6):`);
  for (const s of result.plan) console.log(`      · ${describeStrategy(s)}`);
  console.log(
    `    jobs: eval=[${result.evalJobIds.join(', ')}] recompute-frontier=${result.recomputeJobId} ` +
      `· prices v${result.pricesVersion}`,
  );
  const v2 = result.frontiers[0]!;
  console.log(`    saved frontier ${v2.id} as v${v2.version} (parent ${v2.parentId})`);
  printPointTable(
    '  NEW FRONTIER v' + v2.version + ':',
    v2.points.map((p) => ({ point: p, note: '' })),
  );

  // ---- Part 4: the diff ----
  const diff = result.diffs[0]!;
  // (recompute via the standalone diffFrontiers too, to show the persisted v1 ↔ v2 chain)
  const persistedDiff = diffFrontiers(v1, v2);
  console.log('\n[4/4] FRONTIER DIFF (v' + diff.fromVersion + ' → v' + diff.toVersion + ')');
  console.log(`    appeared:    ${diff.appeared.map((p) => describeStrategy(p.strategyConfig)).join('; ') || '—'}`);
  console.log(`    vanished:    ${diff.vanished.map((p) => describeStrategy(p.strategyConfig)).join('; ') || '—'}`);
  console.log(
    `    dominatedBy: ${
      diff.dominatedBy
        .map(
          ({ point, dominatedBy }) =>
            `${describeStrategy(point.strategyConfig)} ← ${describeStrategy(dominatedBy.strategyConfig)}`,
        )
        .join('; ') || '—'
    }`,
  );
  console.log('\n    NARRATIVE (buyer-readable):');
  for (const line of persistedDiff.narrative) console.log(`      • ${line}`);
  console.log('\n' + '═'.repeat(96));
  console.log('Gate-4 demo complete: dominated strategy excluded, new-model release diffed end to end.');
  console.log('═'.repeat(96));

  await handle.close();
}

await main();
