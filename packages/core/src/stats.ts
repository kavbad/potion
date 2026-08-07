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
 * Percentile bootstrap 95% CI on the mean of `values` (seeded,
 * reproducible). The exact math previously pinned in researcher
 * gate.ts pairedBootstrapCi — generic over any value array (paired deltas,
 * quality samples, …). Callers guarantee values.length > 0.
 */
export function bootstrapMeanCi(
  values: number[],
  seed: number,
  resamples: number = BOOTSTRAP_RESAMPLES,
): { mean: number; ci95: [number, number] } {
  const n = values.length;
  const mean = values.reduce((s, d) => s + d, 0) / n;
  const rand = mulberry32(seed);
  const means: number[] = new Array<number>(resamples);
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += values[Math.floor(rand() * n)]!;
    means[r] = sum / n;
  }
  means.sort((a, b) => a - b);
  const lo = means[Math.max(0, Math.floor(0.025 * (resamples - 1)))]!;
  const hi = means[Math.min(resamples - 1, Math.ceil(0.975 * (resamples - 1)))]!;
  return { mean, ci95: [lo, hi] };
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
