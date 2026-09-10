// Per-strategy aggregation (SPEC §5 StrategyAggregate):
//   qualityMean; qualityCi = generalized-Jeffreys 95% [lo, hi] (honest at the
//   [0,1] boundary — a constant 42/42 sample is a ≥-bound, not certainty);
//   qualityCi95 = the conservative half-width max(mean−lo, hi−mean)
//   costPer1K   = mean(usage.costUsd) × 1000
//   latencyP50/P95 = nearest-rank percentiles over per-item usage.latencyMs.
import {
  BOOTSTRAP_RESAMPLES,
  bootstrapCi,
  jeffreysCi,
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
  /** BOUNDARY SUITE (2026-09-08): the parent slice of an item, when the suite
   *  is a union. With ≥2 slices present the point's quality is the WEAKEST
   *  slice's — "clears the floor on both kinds of item" is a statement about
   *  each kind, not their average — and every slice is recorded in evidence. */
  sliceOf?: (itemId: string) => string | undefined,
): StrategyAggregate {
  const n = results.length;
  const qualities = results.map((r) => r.quality);
  const latencies = results.map((r) => r.usage.latencyMs);
  const bySlice = new Map<string, number[]>();
  if (sliceOf !== undefined) {
    for (const r of results) {
      const s = sliceOf(r.itemId);
      if (s === undefined) continue;
      bySlice.set(s, [...(bySlice.get(s) ?? []), r.quality]);
    }
  }
  const sliced = bySlice.size >= 2;
  const sliceStats = sliced
    ? [...bySlice.entries()].map(([name, qs]) => {
        const ci = jeffreysCi(qs);
        const m = mean(qs);
        return { name, n: qs.length, quality: m, ci, half: Math.max(m - ci[0], ci[1] - m) };
      })
    : [];
  const weakest = sliced ? sliceStats.reduce((a, b) => (b.quality < a.quality ? b : a)) : null;
  const qCi = weakest ? weakest.ci : jeffreysCi(qualities);
  const qMean = weakest ? weakest.quality : mean(qualities);
  const qHalf = n > 0 ? Math.max(qMean - qCi[0], qCi[1] - qMean) : 0;
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
    qualityMean: qMean,
    qualityCi95: qHalf,
    ...(n > 0 ? { qualityCi: qCi } : {}),
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
            qualityCi95: qHalf,
            qualityCi: qCi,
            // The tokens this strategy actually consumed (2026-09-06). Cost
            // is stored as a scalar measured at THIS suite's prompt size; a
            // strategy carrying a fixed input overhead is mispriced for any
            // caller whose prompts are a different length. Recording the
            // profile lets the selector re-form cost at the request's real
            // size — see core/select.ts expectedCostPer1K.
            tokens: {
              inputMean: mean(results.map((r) => r.usage.inputTokens)),
              outputMean: mean(results.map((r) => r.usage.outputTokens)),
            },
            latencyN: n,
            latencyP95Ci95: latencyCi!.ci95,
            latencySeed,
            ...(weakest
              ? { slices: Object.fromEntries(sliceStats.map((s) => [s.name, { n: s.n, quality: s.quality, qualityCi95: s.half }])) }
              : {}),
            // MIXING M3: every cell is TOOLS-instrument evidence → the point
            // was measured on items that carried tools. Keyed on the cell's
            // effective instrument, not its scorer (2026-09-01): the tools
            // suite now mixes tool-call items with grounded-continuation
            // items scored field-contains, and both kinds carry tools. Rows
            // without an instrument keep the legacy scorer derivation
            // (tool-call ⇒ tools), matching the db-boundary fallback.
            ...(results.every(
              (r) => (r.instrument ?? (r.scorer === 'tool-call' ? 'tools' : 'default')) === 'tools',
            )
              ? { toolsMeasured: true }
              : {}),
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
