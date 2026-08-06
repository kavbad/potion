// M1b domination regression (Phase 1, item 1): the preflight projection must
// DOMINATE recorded live actuals, or budget-cap refusal is theater.
//
// Evidence base: artifacts/m1b-sweep-2026-08-06T05-16-58-387Z.json — the real
// 2026-08-06 live sweep (8 authored suites × 6 strategies × 14 items = 672
// results, $3.373 actual on OpenRouter). The OLD estimator projected $1.44
// "worst case" for this sweep (2.3× under). This test replays the recorded
// data against the FIXED estimator and asserts projection ≥ actual at every
// granularity the estimator promises:
//   · per run (suite)
//   · per (suite × strategy) cell
//   · sweep total
//
// ITEM-level domination is deliberately NOT asserted: 16/672 recorded results
// were produced BEFORE max_tokens enforcement on the openai-shaped transport
// and exceeded today's DEFAULT_MAX_TOKENS ceiling (max observed: 1501 output
// tokens vs the enforced 1024). Those outputs are impossible to reproduce
// post-fix; suite/cell aggregates absorb them (verified margins ≥ 1.15×).
//
// If prices.json moves for the or-* aliases, this test still holds as long as
// projection math and recorded usage are priced consistently — it recomputes
// the projection from CURRENT prices but compares against RECORDED costUsd,
// so a large price DROP could break domination. That is the correct failure
// mode: it forces re-recording evidence rather than silently weakening the
// invariant. (Recorded pricesVersion is asserted to match as a guard.)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { StrategyConfig } from '@potion/core';
import { loadPrices } from '@potion/providers';
import { estimateItemCostUsd, projectRunCostUsd } from './estimate.js';
import { loadSuite, SUITE_OUTPUT_CEILINGS } from './suites.js';

const ROOT = new URL('../../../', import.meta.url);
const ARTIFACT_PATH = fileURLToPath(
  new URL('artifacts/m1b-sweep-2026-08-06T05-16-58-387Z.json', ROOT),
);
const PRICES_PATH = fileURLToPath(new URL('prices.json', ROOT));

interface RecordedResult {
  itemId: string;
  clusterId: string;
  strategyHash: string;
  strategyConfig: StrategyConfig;
  usage: { costUsd: number; inputTokens: number; outputTokens: number };
  pricesVersion: string;
}

interface RecordedSweep {
  projectedSweepUsd: number;
  totalSpendUsd: number;
  suitesRun: string[];
  runs: Array<{ spendUsd: number; results: RecordedResult[] }>;
}

const sweep = JSON.parse(readFileSync(ARTIFACT_PATH, 'utf8')) as RecordedSweep;
const prices = loadPrices(PRICES_PATH).table;

describe('M1b sweep domination regression (recorded live actuals)', () => {
  it('guards: artifact shape + prices version match the recorded run', () => {
    expect(sweep.runs).toHaveLength(8);
    expect(sweep.runs.flatMap((r) => r.results)).toHaveLength(672);
    // Every recorded result was priced with the version prices.json still
    // carries — if this fails, re-record evidence before touching margins.
    for (const r of sweep.runs.flatMap((run) => run.results)) {
      expect(r.pricesVersion).toBe(prices.version);
    }
    // The OLD estimator's recorded projection really did under-count (the
    // defect this fix removes) — pin it so the story stays auditable.
    expect(sweep.projectedSweepUsd).toBeLessThan(sweep.totalSpendUsd);
  });

  it('per-run (suite): projection ≥ recorded actual spend', () => {
    for (const run of sweep.runs) {
      const suiteId = run.results[0]!.clusterId;
      const items = loadSuite(suiteId);
      const strategies = uniqueStrategies(run.results);
      // Bound to the ceiling the suite is CONFIGURED to run with — for
      // agentic-tool-use that is 2048 (recorded answers reached 1501, so the
      // 1024 default would truncate; SUITE_OUTPUT_CEILINGS).
      const projected = projectRunCostUsd(strategies, items, prices, SUITE_OUTPUT_CEILINGS[suiteId]);
      const actual = run.results.reduce((a, r) => a + r.usage.costUsd, 0);
      expect(projected, `suite ${suiteId}`).toBeGreaterThanOrEqual(actual);
    }
  });

  it('per-(suite × strategy) cell: projection ≥ recorded actual spend', () => {
    for (const run of sweep.runs) {
      const suiteId = run.results[0]!.clusterId;
      const items = loadSuite(suiteId);
      const byId = new Map(items.map((i) => [i.id, i]));
      const cells = new Map<string, { config: StrategyConfig; actual: number; projected: number }>();
      for (const r of run.results) {
        const item = byId.get(r.itemId);
        expect(item, `item ${r.itemId} in suite ${suiteId}`).toBeDefined();
        const cell = cells.get(r.strategyHash) ?? { config: r.strategyConfig, actual: 0, projected: 0 };
        cell.actual += r.usage.costUsd;
        cell.projected += estimateItemCostUsd(r.strategyConfig, item!, prices, SUITE_OUTPUT_CEILINGS[suiteId]);
        cells.set(r.strategyHash, cell);
      }
      for (const [hash, cell] of cells) {
        expect(
          cell.projected,
          `suite ${suiteId} × strategy ${JSON.stringify(cell.config)} (${hash.slice(0, 8)})`,
        ).toBeGreaterThanOrEqual(cell.actual);
      }
    }
  });

  it('sweep total: projection ≥ $3.373 recorded actual (and covers the old deficit)', () => {
    let projected = 0;
    for (const run of sweep.runs) {
      const suiteId = run.results[0]!.clusterId;
      projected += projectRunCostUsd(
        uniqueStrategies(run.results),
        loadSuite(suiteId),
        prices,
        SUITE_OUTPUT_CEILINGS[suiteId],
      );
    }
    const actual = sweep.runs.reduce(
      (a, run) => a + run.results.reduce((s, r) => s + r.usage.costUsd, 0),
      0,
    );
    expect(actual).toBeCloseTo(sweep.totalSpendUsd, 6);
    expect(projected).toBeGreaterThanOrEqual(actual);
  });
});

function uniqueStrategies(results: RecordedResult[]): StrategyConfig[] {
  const seen = new Map<string, StrategyConfig>();
  for (const r of results) if (!seen.has(r.strategyHash)) seen.set(r.strategyHash, r.strategyConfig);
  return [...seen.values()];
}
