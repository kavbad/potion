import type { Frontier, FrontierPoint, Policy, PriceTable } from './types.js';
import { strategyModels } from './coverage.js';

/**
 * Policy evaluation against a frontier. Returns null when no point is feasible
 * (the serving layer then falls back to the highest-quality point).
 *
 * - max_quality: feasible = costPer1K <= ceiling; pick max quality, tie -> lower cost.
 * - min_cost:    feasible = quality >= floor;   pick min cost,   tie -> higher quality.
 * - latency_bound: feasible = latencyP95 <= p95Ms; pick max quality, tie -> lower cost.
 * - compound: feasible = quality >= floor AND latencyP95 <= p95Ms (a HARD
 *   intersect — the bound excludes, it never trades off); pick min cost,
 *   tie -> higher quality. Both constraints are stated by the customer, so
 *   cost is the only remaining objective; the comparator is min_cost's.
 *
 * The selector is PURE over FrontierPoint coordinates. Serving-grade latency
 * (G2.6) is substituted into the points BEFORE this call, never read inside
 * it — that keeps policy evaluation a function of its inputs and keeps the
 * "which latency did we bind against" question answerable at one seam.
 */
/**
 * THE QUALITY LOWER BOUND (2026-09-01, external core-API review P0 —
 * "statistically good enough, not point-estimate good enough", the
 * shadow-evidence doctrine promoted into the selector itself).
 *
 * A quality FLOOR is a promise to the customer, so FEASIBILITY tests it
 * against the evidence interval's lower bound: a point whose mean clears
 * the floor but whose interval does not has not PROVEN the floor.
 * RANKINGS (max_quality picks, tie-breaks, highestQualityPoint, dominance
 * construction) stay mean-based — ordering among qualifiers is
 * optimization, not a promise.
 *
 * Fallbacks mirror the latency axis's provisional discipline
 * (SERVING_LATENCY_MIN_SAMPLES): a point with no usable interval — legacy
 * rows, or the degenerate qualityCi95=0 of pre-Jeffreys perfection — is
 * judged by its mean, exactly as before. Only evidence-bearing points
 * near floors change behavior, which is precisely the honest set.
 */
export function qualityLowerBound(p: FrontierPoint): number {
  const ci = p.evidence?.qualityCi;
  if (ci !== undefined && ci.length === 2 && ci[0] >= 0) return ci[0];
  const half = p.evidence?.qualityCi95;
  if (half !== undefined && half > 0) return p.quality - half;
  return p.quality;
}

/**
 * THE COST OF A POINT AT THE SIZE THE CUSTOMER ACTUALLY SENDS (2026-09-06).
 *
 * `costPer1K` is a scalar mean measured on the suite's items. A strategy that
 * prefixes or rewrites the prompt carries a FIXED input overhead, and a fixed
 * overhead is a different fraction of a 24-token request than of a 125-token
 * suite item — +267% versus +51% for the same 64 tokens. So the scalar ranks
 * points for the suite's prompt length, not the caller's, and a `min_cost`
 * policy can select the most expensive option a customer has.
 *
 * The correction needs one anchor the scalar does not carry: how much input
 * each point consumed when measured. Given that, the frontier's LEAST
 * transforming point stands in for the untransformed prompt, every other
 * point's excess over it is its additive overhead, and cost can be re-formed
 * at the request's real size:
 *
 *   overhead_i     = inputMean_i − min_j(inputMean_j)
 *   expectedInput  = requestInputTokens + overhead_i
 *   expectedCost   = expectedInput × inputPrice + outputMean_i × outputPrice
 *
 * WHY A MULTIPLICATIVE MODEL WOULD BE USELESS HERE: a strategy that doubles
 * the prompt doubles it at every size, so its ratio to the others never
 * moves and the scalar already ranks it correctly. Only the additive part
 * distorts with size, and only the additive part is reconstructed here.
 *
 * HONESTY RULES, both load-bearing:
 *  · If ANY point lacks a token profile the whole frontier falls back to the
 *    measured scalar. Mixing a reconstructed cost with a measured one would
 *    rank points on two different bases and silently favour whichever
 *    happened to carry evidence.
 *  · A multi-model strategy is priced on the MEAN of its models' prices. It
 *    is an approximation and it is labelled as one — but it is an
 *    approximation of the right quantity, where the scalar is an exact
 *    measurement of the wrong one.
 */
export function expectedCostPer1K(
  point: FrontierPoint,
  requestInputTokens: number,
  prices: PriceTable,
  baselineInputTokens: number,
): number {
  const tokens = point.evidence?.tokens;
  if (tokens === undefined) return point.costPer1K;
  const models = strategyModels(point.strategyConfig);
  const entries = models
    .map((m) => prices.entries.find((e) => e.alias === m || e.model === m))
    .filter((e): e is NonNullable<typeof e> => e !== undefined);
  // Nothing priceable: the measured scalar is the only honest number left.
  if (entries.length === 0) return point.costPer1K;
  const inPer1M = entries.reduce((a, e) => a + e.inputPer1M, 0) / entries.length;
  const outPer1M = entries.reduce((a, e) => a + e.outputPer1M, 0) / entries.length;
  const overhead = Math.max(0, tokens.inputMean - baselineInputTokens);
  const expectedInput = Math.max(0, requestInputTokens) + overhead;
  const perRequestUsd = (expectedInput * inPer1M + tokens.outputMean * outPer1M) / 1_000_000;
  const reconstructed = perRequestUsd * 1000;
  if (models.length <= 1) return reconstructed;
  // ANCHORED TO THE MEASUREMENT (2026-09-08, the first cascade served).
  //
  // For a single model the mean above IS the model's price, and the
  // reconstruction agrees with the measured scalar at the suite's size. For
  // a mixture it is not: a cascade that runs its cheap stage 75% of the time
  // was priced as a half-price model run 100% of the time, and min_cost
  // served gpt-full instead on every request under ~114 input tokens —
  // three of five code-review items, at 4x the cost of the two the cascade
  // answered. The catalogue cannot tell us a mixture's blended price; the
  // measurement can. So the reconstruction is rescaled to reproduce the
  // measured scalar at the suite's own request size, and the additive
  // request-size correction is applied AROUND that level. Exact where the
  // measurement exists, an approximation only in how it extrapolates —
  // which is the honest ordering of the two sources.
  const atSuite = (tokens.inputMean * inPer1M + tokens.outputMean * outPer1M) / 1_000_000 * 1000;
  if (!(atSuite > 0) || !(point.costPer1K > 0)) return reconstructed;
  return reconstructed * (point.costPer1K / atSuite);
}

/**
 * The frontier's least-transforming point, in input tokens — the stand-in for
 * "what the raw prompt cost to send". Null when any point is missing its
 * profile, which is the signal to price the whole frontier on the scalar.
 */
export function baselineInputTokens(points: FrontierPoint[]): number | null {
  if (points.length === 0) return null;
  let min = Infinity;
  for (const p of points) {
    const t = p.evidence?.tokens;
    if (t === undefined) return null;
    if (t.inputMean < min) min = t.inputMean;
  }
  return Number.isFinite(min) ? min : null;
}

/** Cost comparator for a selection: request-aware when the evidence supports
 *  it, the measured scalar when it does not. */
function costOf(
  point: FrontierPoint,
  ctx: { requestInputTokens: number; prices: PriceTable; baseline: number } | null,
): number {
  return ctx === null
    ? point.costPer1K
    : expectedCostPer1K(point, ctx.requestInputTokens, ctx.prices, ctx.baseline);
}

/** Optional request context. Absent → the pre-2026-09-06 scalar behaviour,
 *  which every existing caller and test still gets unchanged. */
export interface SelectionContext {
  requestInputTokens: number;
  prices: PriceTable;
  /**
   * The caller's output budget (`max_tokens`), when they set one.
   *
   * A strategy that averages 300 output tokens when measured unconstrained
   * cannot answer inside a 64-token budget: it spends the allowance on
   * preamble and is cut off before the answer. Measured against a fixed
   * incumbent on identical items, a routed model wrote ~200 characters of
   * "Let's break this down…" and never arrived, while the incumbent wrote
   * three characters and was right. The platform already RECORDS answer
   * shape after the fact (routing/task-shape.ts answerShapeOf) and has never
   * SELECTED on it.
   *
   * Quality was measured without regard to whether the answer fits the
   * caller's budget — the same blind spot the cost model had about the
   * request's size. Absent → no budget filtering, exactly as before.
   */
  maxOutputTokens?: number | undefined;
}

/**
 * Points excluded by INTERVAL WIDTH rather than by measured quality.
 *
 * A floor is tested against qualityLowerBound — correctly, because a floor is
 * a promise. But that makes two very different states look identical from the
 * outside: "this model is not good enough" and "we have not measured it
 * enough to say". They call for opposite responses — replace the model, or
 * measure more — and today the second is invisible.
 *
 * It is not hypothetical. On 2026-09-07 a re-measurement moved
 * or-gemini-flash on classification to a MEAN of 0.950 with a lower bound of
 * 0.849 — missing an 0.85 floor by one thousandth, on 40 suite items whose
 * Jeffreys interval is ±0.10. Every point under $0.05/1K was excluded the
 * same way, min_cost was forced onto a point 19x dearer, and nothing in the
 * receipt, the logs or the dashboard said why. The customer's routing got 5x
 * more expensive because a confidence interval was wide.
 *
 * Counting them does not tighten anything — only more distinct items do that
 * (~80 for a 0.95 rate to clear 0.85 with margin). It makes the cause
 * legible, so "underpowered evidence" is never again mistaken for "the cheap
 * models are not good enough".
 */
export function underpoweredExclusions(policy: Policy, frontier: Frontier): number {
  if (policy.type !== 'min_cost' && policy.type !== 'compound') return 0;
  const floor = policy.qualityFloor;
  return frontier.points.filter((p) => p.quality >= floor && qualityLowerBound(p) < floor).length;
}

export function selectPoint(
  policy: Policy,
  frontier: Frontier,
  request?: SelectionContext,
): FrontierPoint | null {
  const pts = frontier.points;
  if (pts.length === 0) return null;

  // Request-aware costing only when the caller supplied a request AND every
  // point carries a token profile — otherwise the whole frontier is priced on
  // the measured scalar, so two bases are never compared against each other.
  const base = request === undefined ? null : baselineInputTokens(pts);
  const ctx =
    request !== undefined && base !== null
      ? { requestInputTokens: request.requestInputTokens, prices: request.prices, baseline: base }
      : null;
  const cost = (p: FrontierPoint): number => costOf(p, ctx);

  // OUTPUT-BUDGET FEASIBILITY. Same discipline as request-aware cost: it
  // applies only when the caller stated a budget AND every point carries a
  // measured profile (ctx non-null encodes that), so a frontier with mixed
  // evidence is never judged on a signal only some of it has. A point whose
  // MEAN output exceeds the budget truncates for most requests — serving it
  // is knowingly returning a cut-off answer.
  //
  // Emptying the set is a legitimate outcome: selectPoint returns null and
  // the serving layer falls back, which is the honest reading — nothing
  // measured can answer this request within the budget it was given.
  const budget = request?.maxOutputTokens;
  const pool =
    ctx !== null && budget !== undefined
      ? pts.filter((p) => {
          const out = p.evidence?.tokens?.outputMean;
          return out === undefined || out <= budget;
        })
      : pts;
  if (pool.length === 0) return null;

  switch (policy.type) {
    case 'max_quality': {
      const feasible = pool.filter((p) => cost(p) <= policy.costCeilingPer1K);
      return pickBest(feasible, (a, b) => b.quality - a.quality || cost(a) - cost(b));
    }
    case 'min_cost': {
      const feasible = pool.filter((p) => qualityLowerBound(p) >= policy.qualityFloor);
      return pickBest(feasible, (a, b) => cost(a) - cost(b) || b.quality - a.quality);
    }
    case 'latency_bound': {
      const feasible = pool.filter((p) => p.latencyP95 <= policy.p95Ms);
      return pickBest(feasible, (a, b) => b.quality - a.quality || cost(a) - cost(b));
    }
    case 'compound': {
      const feasible = pool.filter(
        (p) => qualityLowerBound(p) >= policy.qualityFloor && p.latencyP95 <= policy.p95Ms,
      );
      return pickBest(feasible, (a, b) => cost(a) - cost(b) || b.quality - a.quality);
    }
  }
}

/**
 * The QUALITY-only survivors of a compound policy — the fallback set for the
 * latency-infeasible case (G2.6). When no point clears the latency bound, the
 * serving layer serves the FASTEST point that still meets the quality floor
 * and labels the violation: violate the customer-observable dimension
 * (latency), never the customer-invisible one (quality) — detecting quality
 * degradation is the product itself.
 *
 * Ties on latency break to lower cost, then higher quality, so the choice is
 * total and reproducible.
 */
export function fastestQualityQualifyingPoint(
  points: FrontierPoint[],
  qualityFloor: number,
): FrontierPoint | null {
  const qualifying = points.filter((p) => qualityLowerBound(p) >= qualityFloor);
  return pickBest(
    qualifying,
    (a, b) => a.latencyP95 - b.latencyP95 || a.costPer1K - b.costPer1K || b.quality - a.quality,
  );
}

function pickBest(
  pts: FrontierPoint[],
  cmp: (a: FrontierPoint, b: FrontierPoint) => number,
): FrontierPoint | null {
  if (pts.length === 0) return null;
  return [...pts].sort(cmp)[0] ?? null;
}

/** Policy-free incumbent: the max-quality point (ties → cheaper). Used as
 * the serving fallback when selectPoint returns null (§8) AND as the
 * promotion gate's incumbent operating point (SPEC §15.4). */
export function highestQualityPoint(points: FrontierPoint[]): FrontierPoint | null {
  if (points.length === 0) return null;
  return [...points].sort((a, b) => b.quality - a.quality || a.costPer1K - b.costPer1K)[0] ?? null;
}
