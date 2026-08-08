// Seeded statistics primitives (G0.3): the platform's ONE implementation of
// the seeded PRNG + percentile-bootstrap-of-the-mean used wherever a
// statistical decision must be pinned and reproducible:
//   · researcher promotion gate (SPEC §15.4 — gate.ts delegates here)
//   · guarantee breach decisions (SPEC §12.5, G0.3 — evaluateGuarantee)
// Every verdict is reproducible from (values, seed, resamples); seeds derive
// from the evidence itself via seedFromString and are stored alongside the
// decision (incident detail / promotion verdict).
import { sha256 } from './hash.js';

/**
 * mulberry32 — tiny seeded PRNG (SPEC §15.4 pins THIS variant; moved
 * verbatim from packages/researcher/src/rng.ts, which now re-exports it —
 * bit-identical sequences). 32-bit state, fast, exactly reproducible across
 * platforms (all arithmetic is uint32 / Math.imul — no float drift).
 * NOTE: the mock provider's RNG (packages/providers mock/rng.ts) is a
 * different, independently-pinned variant — do not unify.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bootstrap resamples pinned by contract (SPEC §15.4). */
export const BOOTSTRAP_RESAMPLES = 1000;

/**
 * Nearest-rank quantile: sort ascending, take element ceil(p/100 · n) − 1.
 *
 * THIS estimator, not an interpolating one. It is the ceil(p/100·n)-th order
 * statistic, which makes it provably the same quantity Postgres computes with
 * `percentile_disc` — so a p95 read from SQL and a p95 computed here are the
 * same number by construction, not by coincidence. (`percentile_cont`
 * interpolates between order statistics and is a DIFFERENT estimator; do not
 * substitute it.) G2.6 relies on that parity to compare serving-grade latency
 * against harness-grade latency without an estimator confound.
 *
 * Moved here from harness/aggregate.ts percentileNearestRank, which now
 * re-exports it — its existing tests are the bit-identity proof (the
 * mulberry32 precedent).
 */
export function quantileNearestRank(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1]!;
}

/**
 * Percentile bootstrap 95% CI on an arbitrary STATISTIC of `values` (seeded,
 * reproducible). The resampling loop is the exact math previously pinned in
 * researcher gate.ts pairedBootstrapCi; `stat` generalizes it from the mean to
 * any function of a resample (a p95, a median, …) so that every CI the
 * platform reports comes from ONE pinned bootstrap and stays re-derivable from
 * (values, seed, resamples). Callers guarantee values.length > 0.
 */
export function bootstrapCi(
  values: number[],
  stat: (xs: number[]) => number,
  seed: number,
  resamples: number = BOOTSTRAP_RESAMPLES,
): { estimate: number; ci95: [number, number] } {
  const n = values.length;
  const estimate = stat(values);
  const rand = mulberry32(seed);
  const stats: number[] = new Array<number>(resamples);
  const buf: number[] = new Array<number>(n);
  for (let r = 0; r < resamples; r++) {
    for (let i = 0; i < n; i++) buf[i] = values[Math.floor(rand() * n)]!;
    stats[r] = stat(buf);
  }
  stats.sort((a, b) => a - b);
  const lo = stats[Math.max(0, Math.floor(0.025 * (resamples - 1)))]!;
  const hi = stats[Math.min(resamples - 1, Math.ceil(0.975 * (resamples - 1)))]!;
  return { estimate, ci95: [lo, hi] };
}

/**
 * Percentile bootstrap 95% CI on the MEAN — the original G0.3 entry point,
 * kept as the name every existing caller uses. Delegates to bootstrapCi, and
 * a fixed-vector test pins that the delegation is BIT-IDENTICAL: G0.3 breach
 * verdicts are re-derivable from (values, seed, resamples), so a refactor that
 * shifted a single float would silently invalidate stored incident evidence.
 */
export function bootstrapMeanCi(
  values: number[],
  seed: number,
  resamples: number = BOOTSTRAP_RESAMPLES,
): { mean: number; ci95: [number, number] } {
  const { estimate, ci95 } = bootstrapCi(
    values,
    (xs) => xs.reduce((s, d) => s + d, 0) / xs.length,
    seed,
    resamples,
  );
  return { mean: estimate, ci95 };
}

/**
 * Deterministic uint32 seed from a string (first 8 hex chars of sha256).
 * Used to derive audit-reproducible bootstrap seeds from the evidence
 * itself, e.g. seedFromString(`${org}|${policy}|${cluster}|${strategy}|` +
 * `${n}|${sha256(JSON.stringify(values))}`).
 */
export function seedFromString(s: string): number {
  return parseInt(sha256(s).slice(0, 8), 16) >>> 0;
}
