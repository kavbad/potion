// Per-strategy aggregation (SPEC §5 StrategyAggregate):
//   qualityMean / qualityCi95 = 1.96·σ/√n (σ = SAMPLE stdev, n−1; n<2 → 0)
//   costPer1K   = mean(usage.costUsd) × 1000
//   latencyP50/P95 = nearest-rank percentiles over per-item usage.latencyMs.
import {
  BOOTSTRAP_RESAMPLES,
  bootstrapCi,
  quantileNearestRank,
  seedFromString,
  sha256,
  type ClusterId,
  type EvalResult,
  type ProviderMode,
  type StrategyAggregate,
  type StrategyConfig,
} from '@potion/core';

/**
 * Nearest-rank percentile. G2.6 moved the implementation to @potion/core
 * (quantileNearestRank) so ONE estimator backs both the harness aggregate and
 * the serving-grade SQL rollup — see that function's comment for why the
 * discrete/interpolating distinction is load-bearing. Re-exported under the
 * original name; the tests below are the bit-identity proof.
 */
export const percentileNearestRank = quantileNearestRank;

export function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, x) => a + x, 0) / values.length;
}

/** Sample standard deviation (n−1 denominator); 0 for n < 2. */
export function sampleStd(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((a, x) => a + (x - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export function aggregateResults(
  clusterId: ClusterId,
  strategyHash: string,
  strategyConfig: StrategyConfig,
  results: EvalResult[],
  pricesVersion: string,
  providerMode?: ProviderMode,
): StrategyAggregate {
  const n = results.length;
  const qualities = results.map((r) => r.quality);
  const latencies = results.map((r) => r.usage.latencyMs);
  const sd = sampleStd(qualities);
  // G2.6 provenance parity: a latency-driven selection must be as auditable as
  // a quality-driven one, so the p95 ships with its own n, CI and seed rather
  // than as a bare scalar. Seeded from the evidence itself (same shape as the
  // guarantee evaluator's seed) so the interval is re-derivable from the
  // stored row. Reuses the platform's ONE pinned bootstrap.
  const latencySeed =
    n > 0
      ? seedFromString(
          `latency|${clusterId}|${strategyHash}|${n}|${sha256(JSON.stringify(latencies))}`,
        )
      : 0;
  const latencyCi =
    n > 0
      ? bootstrapCi(latencies, (xs) => quantileNearestRank(xs, 95), latencySeed, BOOTSTRAP_RESAMPLES)
      : null;
  return {
    clusterId,
    strategyHash,
    strategyConfig,
    qualityMean: mean(qualities),
    qualityCi95: n > 1 ? (1.96 * sd) / Math.sqrt(n) : 0,
    n,
    costPer1K: mean(results.map((r) => r.usage.costUsd)) * 1000,
    latencyP50: percentileNearestRank(latencies, 50),
    latencyP95: percentileNearestRank(latencies, 95),
    pricesVersion,
    // G1.6 schema-level provenance (owner rule): the aggregate remembers the
    // exact evidence rows it was computed from — cacheKeys are the
    // content-addressed eval_results ids; the pareto projection carries this
    // onto the frontier point verbatim.
    ...(n > 0
      ? {
          evidence: {
            cacheKeys: results.map((r) => r.cacheKey),
            runIds: [...new Set(results.map((r) => r.runId))],
            n,
            qualityCi95: n > 1 ? (1.96 * sd) / Math.sqrt(n) : 0,
            latencyN: n,
            latencyP95Ci95: latencyCi!.ci95,
            latencySeed,
            // MIXING M3: every cell was scored as a tool call → the point was
            // measured on items that carried tools.
            ...(results.every((r) => r.scorer === 'tool-call') ? { toolsMeasured: true } : {}),
          },
        }
      : {}),
    // Provenance: explicit param wins; otherwise inherit only when EVERY
    // input row agrees on one recorded mode (mixed/unknown → absent).
    ...(providerMode !== undefined
      ? { providerMode }
      : results.length > 0 &&
          results.every((r) => r.providerMode !== undefined && r.providerMode === results[0]!.providerMode)
        ? { providerMode: results[0]!.providerMode }
        : {}),
  };
}
