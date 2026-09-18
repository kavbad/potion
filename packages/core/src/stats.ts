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
  /** Two-sided significance level. 0.05 reproduces the original percentiles
   *  EXACTLY — floor(0.025·(r−1)) and ceil(0.975·(r−1)) — so every existing
   *  caller is bit-identical and stored G0.3 breach evidence stays
   *  re-derivable. A smaller alpha widens the interval, which is what a
   *  family-wise correction needs (P1-1). */
  alpha: number = 0.05,
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
  const lo = stats[Math.max(0, Math.floor((alpha / 2) * (resamples - 1)))]!;
  const hi = stats[Math.min(resamples - 1, Math.ceil((1 - alpha / 2) * (resamples - 1)))]!;
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
  alpha: number = 0.05,
): { mean: number; ci95: [number, number] } {
  const { estimate, ci95 } = bootstrapCi(
    values,
    (xs) => xs.reduce((s, d) => s + d, 0) / xs.length,
    seed,
    resamples,
    alpha,
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

// ---------------------------------------------------------------------------
// Bounded-score uncertainty (eval-review adoption, 2026-08-25)

/** Lanczos log-gamma (g=7, n=9) — standard coefficients, |err| < 1e-13. */
function logGamma(z: number): number {
  const g = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    // reflection
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  }
  const x = z - 1;
  let a = 0.99999999999980993;
  for (let i = 0; i < g.length; i++) a += g[i]! / (x + i + 1);
  const t = x + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Continued fraction for the regularized incomplete beta (Lentz method). */
function betaContinuedFraction(x: number, a: number, b: number): number {
  const TINY = 1e-30;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-15) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b) — the Beta(a, b) CDF at x. */
export function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lnFront =
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x);
  const front = Math.exp(lnFront);
  // Use the CF on the side where it converges fast.
  if (x < (a + 1) / (a + b + 2)) return (front * betaContinuedFraction(x, a, b)) / a;
  return 1 - (front * betaContinuedFraction(1 - x, b, a)) / b;
}

/** Inverse Beta(a, b) CDF by bisection — monotone, so plain bisection is
 *  exact enough (90 halvings ≈ 1e-27 interval) and cannot diverge. */
export function betaInvCdf(p: number, a: number, b: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 90; i++) {
    const mid = (lo + hi) / 2;
    if (regularizedIncompleteBeta(mid, a, b) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * 95% interval for a mean of BOUNDED [0, 1] scores — the generalized
 * Jeffreys interval: posterior Beta(s + ½, n − s + ½) with s = Σ scores,
 * quantiles at 2.5% / 97.5%. For binary scores this is exactly the Jeffreys
 * binomial interval; fractional scores are treated as partial successes
 * (quasi-binomial).
 *
 * WHY (eval-review finding, verified in code 2026-08-25): the normal-theory
 * half-width 1.96·σ/√n collapses to ±0.000 on a constant sample, so a 42/42
 * champion was reported as CERTAIN quality 1.000 — but 42/42 means "no
 * failures observed among 42 tasks", a ≥-bound. Our own doctrine said so in
 * prose while this module said otherwise in numbers. Jeffreys keeps honest
 * width at the boundary (x = n → lower bound < 1, upper pinned to 1) and its
 * boundary conventions are standard: x = 0 pins lo = 0, x = n pins hi = 1.
 *
 * Deterministic by construction — no resampling, so no seed to store.
 *
 * IT ASSUMES THE n OBSERVATIONS ARE INDEPENDENT, and it cannot tell when they
 * are not. Measured (stats.test.ts, 3000 seeded trials at true p = 0.90):
 *
 *   60 independent items          coverage 95.1%   width 0.148
 *   6 items seen 10 times each    coverage 90.8%   width 0.148
 *   2 groups x 50 observations    coverage 72.5%   width 0.113
 *
 * The width is the tell: it is IDENTICAL for 60 independent items and for 6
 * items seen ten times, because nothing in the input says which it is. The
 * lower bound — the number every floor, graduation and qualification decision
 * in this repo actually reads — overclaims 14.7% of the time in that last row
 * against a nominal 2.5%.
 *
 * Where grouping metadata exists, use `clusteredQualityCi` instead. Where it
 * does not, this is the right interval and the limit is real: see
 * packages/pareto/src/outcome-evidence.ts, whose rows carry no customer or
 * session id to group by.
 */
export function jeffreysCi(scores: number[]): [number, number] {
  const n = scores.length;
  if (n === 0) return [0, 1];
  const s = scores.reduce((acc, q) => acc + Math.min(1, Math.max(0, q)), 0);
  const a = s + 0.5;
  const b = n - s + 0.5;
  const lo = s <= 0 ? 0 : betaInvCdf(0.025, a, b);
  const hi = s >= n ? 1 : betaInvCdf(0.975, a, b);
  return [lo, hi];
}

/**
 * The 95% interval on a quality MEAN that matches the scores it is given
 * (2026-09-18).
 *
 * `jeffreysCi` is the Jeffreys BINOMIAL interval: exactly right when every
 * score is 0 or 1 (exact, code-exec, tool-call scorers), and a worst-case
 * bound otherwise — it treats a rubric score of 0.9 as "90% of a success",
 * i.e. as if the item's variance were Bernoulli p(1−p), which is 5–10x the
 * variance judge scores actually show. Measured on 2026-09-18 across three
 * clusters (n = 28–54): the Jeffreys lower bound sat 0.09–0.13 BELOW the
 * bootstrap lower bound on the same rows. That gap is what made every cheap
 * point unprovable at a 0.82 floor on a 28-item suite (solar-pro4 on
 * rewrite-edit: mean 0.906, Jeffreys lower 0.770, bootstrap lower 0.859) —
 * the floor was refusing a point the evidence supported.
 *
 * RULE: all-binary scores → Jeffreys (unchanged, boundary-honest at 0 and
 * n). Any fractional score → percentile bootstrap of the mean over ITEMS,
 * seeded from the scores themselves so the interval is re-derivable from the
 * stored evidence; a constant sample (zero spread) falls back to Jeffreys,
 * because "every item scored 0.9" is evidence about the mean, not a licence
 * to claim it to three decimals — the 42/42 lesson in continuous form.
 * Independence caveat identical to jeffreysCi.
 */
export function qualityIntervalCi(scores: number[]): [number, number] {
  const n = scores.length;
  if (n === 0) return [0, 1];
  const clamped = scores.map((q) => Math.min(1, Math.max(0, q)));
  const binary = clamped.every((q) => q === 0 || q === 1);
  if (binary) return jeffreysCi(clamped);
  const m = clamped.reduce((a, q) => a + q, 0) / n;
  const spread = clamped.some((q) => Math.abs(q - m) > 1e-9);
  if (!spread) return jeffreysCi(clamped);
  const seed = seedFromString(`quality|${n}|${sha256(JSON.stringify(clamped))}`);
  const { ci95 } = bootstrapMeanCi(clamped, seed);
  return [Math.max(0, ci95[0]), Math.min(1, ci95[1])];
}

/**
 * The same boundary-honest interval, for scores that are NOT independent —
 * the task-family bootstrap `jeffreysCi` names as its own missing follow-up.
 *
 * `groups[i]` labels the source of `scores[i]`: the task family, the situation
 * fingerprint, the item. Ten runs of one situation are ONE unit of evidence
 * about the world and ten observations to `jeffreysCi`, which is why its
 * interval does not widen when the same work is repeated.
 *
 * METHOD. Resample GROUPS with replacement (the cluster bootstrap — the
 * standard treatment, and the only resampling that preserves within-group
 * correlation), take the mean of the resulting pooled observations, read
 * percentiles. Groups are resampled, never observations inside them.
 *
 * THE UNION WITH JEFFREYS IS DELIBERATE. A cluster bootstrap over an all-ones
 * sample returns [1, 1] — precisely the ±0.000 certainty that `jeffreysCi`
 * exists to refuse. So the result is the WIDER of the two bounds on each
 * side: the bootstrap contributes what it knows about clustering, Jeffreys
 * contributes what it knows about the boundary, and neither can quietly
 * narrow the other. On singleton groups the bootstrap has nothing extra to
 * say and the result is `jeffreysCi` unchanged.
 *
 * THE UNION ALSO MEANS THIS IS NEVER NARROWER, so improved coverage is not by
 * itself evidence that clustering is modeled — a bootstrap that ignored the
 * groups entirely would raise coverage too, and did, and passed the first
 * version of the test written for this. The property that actually shows the
 * method is width RESPONDING to group size at fixed n (stats.test.ts, 'THE
 * DISCRIMINATOR'): 60 observations in 30 groups vs in 3 groups measure
 * 0.163 and 0.181, while `jeffreysCi` reads 0.149 for both.
 *
 * IT CANNOT RESCUE A TINY NUMBER OF GROUPS. With two groups there are three
 * distinct resamples in the world; coverage measured 72% -> 76%. That is not
 * a defect of the estimator, it is two units of evidence. The remedy is to
 * REPORT the group count, not to widen an interval until it hides the fact.
 *
 * REPRODUCIBLE WITHOUT A STORED SEED. `jeffreysCi` needed none; this does, so
 * the seed is DERIVED from the evidence itself via seedFromString. Same
 * scores and same groups give the same interval forever, and a verdict stays
 * re-derivable from what it was computed over.
 */
export function clusteredQualityCi(
  scores: number[],
  groups: readonly string[],
  resamples: number = BOOTSTRAP_RESAMPLES,
  alpha: number = 0.05,
): [number, number] {
  if (scores.length !== groups.length) {
    throw new Error(
      `clusteredQualityCi: ${scores.length} scores but ${groups.length} group labels — ` +
        `a score whose source is unknown cannot be grouped, and silently dropping it would ` +
        `narrow the interval it was meant to widen`,
    );
  }
  const [jLo, jHi] = jeffreysCi(scores);
  if (scores.length === 0) return [jLo, jHi];

  const byGroup = new Map<string, number[]>();
  for (let i = 0; i < scores.length; i++) {
    const g = groups[i]!;
    const arr = byGroup.get(g);
    if (arr) arr.push(scores[i]!);
    else byGroup.set(g, [scores[i]!]);
  }
  const clusters = [...byGroup.values()];
  // Every observation its own group: there is no clustering to model, and the
  // bootstrap would only add resampling noise to an exact interval.
  if (clusters.length === scores.length) return [jLo, jHi];

  const seed = seedFromString(
    `clustered|${scores.length}|${[...byGroup.keys()].sort().join(',')}|${sha256(JSON.stringify(scores))}`,
  );
  const rand = mulberry32(seed);
  const means: number[] = new Array<number>(resamples);
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    let count = 0;
    for (let c = 0; c < clusters.length; c++) {
      const picked = clusters[Math.floor(rand() * clusters.length)]!;
      for (const v of picked) {
        sum += Math.min(1, Math.max(0, v));
        count++;
      }
    }
    means[r] = count === 0 ? 0 : sum / count;
  }
  means.sort((a, b) => a - b);
  const bLo = means[Math.max(0, Math.floor((alpha / 2) * (resamples - 1)))]!;
  const bHi = means[Math.min(resamples - 1, Math.ceil((1 - alpha / 2) * (resamples - 1)))]!;
  return [Math.min(jLo, bLo), Math.max(jHi, bHi)];
}
