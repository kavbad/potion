// "WHAT ARE YOU BUILDING?" — the from-scratch front door (SERVING-ROADMAP S2).
//
// THE CASE THIS SERVES, which is the hard one. Everything else in the product
// assumes a workload: upload prompts, cluster your traffic, watch your
// frontier improve. Someone starting from nothing has none of that, and the
// honest answer to "which model should I use" cannot be "send us traffic
// first" — that is the answer they came here to avoid.
//
// What they DO have is a sentence about what they are building. That sentence
// goes through the same cluster assigner every request goes through, lands on
// the same taxonomy cluster, and reads the same platform frontier the serving
// path would read for that cluster. So the recommendation is not a new kind
// of claim: it is the routing decision they would get, shown before they
// commit rather than after.
//
// THREE HONESTY RULES, each closing a way this could flatter itself:
//
//   1. THE BASIS IS NAMED. `basis: 'platform-measured'` — this is Potion's
//      measurement on the taxonomy, NOT a measurement of their workload,
//      which does not exist yet. A number whose provenance is unstated will
//      be read as stronger than it is, and this one is a genuinely weaker
//      claim than the org-frontier numbers elsewhere in the product.
//
//   2. THE ALTERNATIVES ARE SHOWN. Classification from one sentence is the
//      weakest link in the whole flow, so `rank` returns the runner-up and
//      the margin. A near tie must be visible as a near tie, and a weak best
//      must be visible as weak — silently acting on a bad guess is how this
//      surface would quietly mis-serve someone for months.
//
//   3. NOTHING IS RECOMMENDED THAT IS NOT MEASURED. Each policy shape is
//      offered with the point it would ACTUALLY select today, evaluated by
//      `selectPoint` — the serving path's own selector. A policy shape with
//      no feasible point is returned as infeasible WITH THE REASON, never
//      hidden and never quietly widened to make an option appear available.
//      This is the dial-honesty decision applied to a sales surface, which is
//      exactly where it is most tempting to skip.
//
// READ-ONLY. This creates nothing. Applying a choice goes through the
// existing POST /api/policies, so there is one mutation path for policies and
// keys, not a second one that happens to live behind a nicer page.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  selectPoint,
  qualityLowerBound,
  type FrontierPoint,
  type LatencyEvidence,
  type Policy,
  type StrategyConfig,
} from '@potion/core';
import { loadTaxonomy } from '@potion/cluster';
import { loadCurrentFrontier } from '@potion/pareto';
import { clusterEvidenceCounts } from '@potion/db';
import { openAiError } from '../auth.js';
import { bindServingLatency } from '../latency-policy.js';
import type { PotionContext } from '../context.js';
import { guardFrontierProvenance } from './chat.js';
import { describeStrategyBrief } from './reports.js';
import { describePolicy } from './connection.js';

/** Cap on how much text we embed per plan — a bound on cost and on abuse. */
const MAX_DESCRIPTION_CHARS = 4000;
const MAX_SAMPLES = 10;

/** Per-strategyHash latency provenance, as `resolveLatency` reports it. */
export type LatencyEvidenceMap = Record<string, LatencyEvidence>;

/** Placeholder on an option that has no policy to offer at all. Never
 *  applied — `infeasible` is non-null on exactly these, and the surfaces
 *  render the reason instead of a button. */
const NO_POLICY: Policy = { type: 'min_cost', qualityFloor: 0.8 };

const PlanBodySchema = z.object({
  /** Plain language: "a customer support triage bot", "I'm summarizing
   *  earnings calls into bullets". */
  description: z.string().min(3).max(MAX_DESCRIPTION_CHARS),
  /** Optional real prompts. Two or three sharpen the classification far more
   *  than a longer description does, because they are the actual traffic. */
  samples: z.array(z.string().min(1).max(MAX_DESCRIPTION_CHARS)).max(MAX_SAMPLES).optional(),
});

/** How far ahead the winner is. Small margin = a near tie the user must see. */
export function assignmentMargin(ranked: Array<{ confidence: number }>): number {
  const first = ranked[0];
  const second = ranked[1];
  if (!first) return 0;
  return Math.round((first.confidence - (second?.confidence ?? 0)) * 1000) / 1000;
}

export interface PolicyOption {
  /** What the customer is optimizing for, in their words, not ours. */
  priority: 'cost' | 'quality' | 'speed';
  policy: Policy;
  description: string;
  /** The point selectPoint returns for this policy on this frontier TODAY. */
  point: {
    strategyHash: string;
    strategy: string;
    quality: number;
    costPer1K: number;
    latencyP95: number;
    /**
     * G2.6's standing decision, carried onto this surface: latency evidence
     * is either SERVING-grade (measured on real requests, end-to-end) or
     * HARNESS-grade (measured during evaluation, strategy-only span) — and
     * harness-grade is PROVISIONAL and must say so. A from-scratch customer
     * has no serving evidence by definition, so every number they see here
     * is provisional; presenting it flat as "p95 latency" would state a fact
     * about their production traffic that nobody has measured.
     */
    latencySource: 'serving' | 'harness';
    latencyProvisional: boolean;
    latencySpan: 'end-to-end' | 'strategy-only';
    providerMode: string;
    /** Sample count behind the quality number; null on pre-evidence points. */
    n: number | null;
    qualityCi95: number | null;
    /**
     * Cost relative to the highest-quality measured strategy — the honest
     * counterfactual for "what if I just always used the best model", and the
     * same comparison request logging records per served request.
     *
     * Null on the best-quality option itself (comparing it to itself says
     * nothing) and whenever the comparison is undefined. A fraction, not a
     * percentage, so the surface decides how to render it.
     */
    savedVsBestQuality: number | null;
  } | null;
  /** Present exactly when point is null. Never hidden, never worked around. */
  infeasible: string | null;
}

/**
 * The cost ceiling to offer for "make it good", DERIVED from this cluster's
 * own measurements rather than fixed.
 *
 * The fixed $1.00 that used to sit here had the same defect as the fixed
 * 1000ms latency bound, and it shipped anyway because I fixed one and left
 * the other. `costPer1K` is USD per 1000 REQUESTS, so $1.00 means a tenth of
 * a cent per request — below which almost no real workload lands. Agentic
 * tool use measures $6.72–$8.81 per 1000 requests, so EVERY strategy blew
 * the ceiling and "Make it good" rendered permanently unavailable: a dial
 * with nothing behind it, on the card a customer is most likely to want.
 *
 * As with latency, the fix is not a bigger arbitrary number. It is to state
 * the bound the evidence supports: the most expensive strategy actually
 * measured for this workload. max_quality then means what the card promises —
 * the best measured quality among things we have measured — and it is
 * available exactly when evidence exists.
 */
export function derivedCostCeilingUsd(points: FrontierPoint[]): number | null {
  const measured = points.map((p) => p.costPer1K).filter((n) => Number.isFinite(n) && n > 0);
  if (measured.length === 0) return null;
  // Round UP so the ceiling can never exclude the point it came from.
  return Math.ceil(Math.max(...measured) * 10000) / 10000;
}

/**
 * The latency bound to offer for "make it fast", DERIVED from this cluster's
 * own measurements rather than fixed.
 *
 * The fixed 1000ms default that used to sit here was tuned in the mock era
 * and is unreachable on live evidence: the Step 5 sweep measured p95 between
 * 3.2s and 54s across the taxonomy, so ZERO of 29 measured points cleared it
 * and "make it fast" was permanently unavailable on every workload — a dial
 * with nothing behind it, which is precisely what the dial-honesty decision
 * forbids.
 *
 * The fix is NOT to pick a looser number until an option appears; that is the
 * quiet-widening this file refuses to do elsewhere. It is to state the bound
 * the evidence supports: the fastest p95 we have actually measured for this
 * workload. The resulting policy is meaningful ("no slower than the fastest
 * thing we measured for you") and, being an exact measured value, it always
 * admits at least that point — so the option is available exactly when
 * measurements exist, and infeasible exactly when they do not.
 */
export function derivedLatencyBoundMs(points: FrontierPoint[]): number | null {
  const measured = points.map((p) => p.latencyP95).filter((n) => Number.isFinite(n) && n > 0);
  if (measured.length === 0) return null;
  return Math.ceil(Math.min(...measured));
}

/**
 * The three single-constraint policy shapes, each with the point it would
 * actually select. Quality and cost keep the platform defaults used
 * everywhere else (min_cost @ 0.8, max_quality @ $1/1K) so a customer
 * arriving here and one arriving through the policy picker get the same
 * thing; the latency bound is derived per cluster — see above for why a
 * fixed default was a dial with nothing behind it.
 */
/**
 * One row of the measured frontier, as a surface should show it.
 *
 * The three policy cards this replaced could — and on real data regularly did
 * — collapse onto the SAME point: min_cost above a floor and max_quality under
 * a ceiling pick the same strategy whenever the frontier is short. Two cards
 * showing identical numbers reads as a bug, and worse, it hides the actual
 * trade-off space the measurement bought. Every non-dominated point is
 * offered, and `selectedBy` says which priorities land on it.
 */
export interface FrontierRow {
  strategyHash: string;
  strategy: string;
  quality: number;
  qualityCi95: number | null;
  costPer1K: number;
  latencyP95: number;
  latencyProvisional: boolean;
  n: number | null;
  providerMode: string;
  savedVsBestQuality: number | null;
  /** Which of the offered priorities selects this row today. */
  selectedBy: Array<'cost' | 'quality' | 'speed'>;
  /**
   * The policy that binds THIS row — DERIVED, then VERIFIED.
   *
   * Deriving a rule instead of pinning a model id keeps the product's actual
   * promise: you choose a RULE, and if something better gets measured later
   * the rule moves you to it without a code change.
   *
   * The obvious derivation is min_cost at the row's own quality, and I
   * shipped it on the reasoning that frontier points are non-dominated so
   * nothing with quality >= this row's can cost less. That reasoning is
   * WRONG, and a test caught it: the frontier is non-dominated in THREE
   * dimensions. Real data — or-gpt-full (q 0.640, $0.1477) beats
   * or-gemini-flash (q 0.620, $0.1509) on both quality and cost; flash
   * survives only because it is faster (2110ms vs 3052ms). min_cost ignores
   * latency, so picking the flash row would have bound a policy that serves
   * FULL while the button said "Applied ✓" on flash.
   *
   * So the policy is CHECKED against the serving path's own selector, and
   * falls back to a compound rule (quality floor AND latency bound) when
   * min_cost cannot isolate the row. Null when neither can — an honest
   * "cannot bind this one" beats a button that silently serves something
   * else.
   */
  policy: Policy | null;
}

/**
 * A policy that provably selects `target` on `frontier`, or null.
 *
 * Tries the simplest rule first and VERIFIES it with `selectPoint` — the
 * serving path's own selector — rather than trusting an argument about what
 * it should do. If min_cost lands elsewhere (the three-dimensional frontier
 * case), a compound rule adds the latency bound that isolates the row.
 *
 * THE FLOOR IS THE LOWER BOUND, NOT THE MEAN (2026-09-06). `selectPoint`
 * filters min_cost and compound on `qualityLowerBound(p) >= qualityFloor` —
 * the conservative end of the interval, because a floor is a promise and a
 * mean is not evidence that the promise holds. Minting the floor from
 * `target.quality` therefore set a bar the selector tests the target against
 * and the target fails: for any point carrying real evidence the mean sits
 * ABOVE its own lower bound, so the row became unbindable (null), and the
 * only rows that ever bound were the CI-less ones — where mean == bound and
 * the verification below passed vacuously.
 *
 * That is not a cosmetic mismatch. A floor minted from a mean is
 * unsatisfiable on every OTHER cluster too, whose points all carry intervals.
 * In production one such policy (floor 0.978543771043771, minted from a
 * CI-less point) put 7 of 10 clusters onto `fallback=1` for a design
 * partner — every request served the highest-quality point because nothing
 * cleared the bar — which also made their `min_cost` arm the most expensive
 * one in their own study. One row of data, two headline findings.
 *
 * Deriving the floor with the selector's own function makes the target
 * satisfy its own filter by construction. The verification below still
 * decides whether the rule ISOLATES the row; this only stops it from
 * excluding the row it was built for.
 */
export function policyBinding(target: FrontierPoint, points: FrontierPoint[]): Policy | null {
  const frontier = {
    id: 'binding',
    clusterId: target.clusterId,
    version: 0,
    parentId: null,
    trigger: 'manual' as const,
    points,
    pricesVersion: 'binding',
    createdAt: new Date(0).toISOString(),
  };
  const floor = qualityLowerBound(target);
  const candidates: Policy[] = [
    { type: 'min_cost', qualityFloor: floor },
    { type: 'compound', qualityFloor: floor, p95Ms: Math.ceil(target.latencyP95) },
  ];
  for (const policy of candidates) {
    if (selectPoint(policy, frontier)?.strategyHash === target.strategyHash) return policy;
  }
  return null;
}

/** The most expensive measured point — the "just use the best model" baseline. */
function bestQualityCost(points: FrontierPoint[]): number | null {
  let best: FrontierPoint | null = null;
  for (const p of points) {
    if (best === null || p.quality > best.quality || (p.quality === best.quality && p.costPer1K < best.costPer1K)) {
      best = p;
    }
  }
  return best && best.costPer1K > 0 ? best.costPer1K : null;
}

export function policyOptionsFor(points: FrontierPoint[], evidence: LatencyEvidenceMap = {}): PolicyOption[] {
  const boundMs = derivedLatencyBoundMs(points);
  const ceilingUsd = derivedCostCeilingUsd(points);
  const baselineCost = bestQualityCost(points);
  const shapes: Array<{ priority: PolicyOption['priority']; policy: Policy | null; infeasibleWhy: string }> = [
    {
      priority: 'cost',
      policy: { type: 'min_cost', qualityFloor: 0.8 },
      infeasibleWhy: 'no measured strategy for this workload reaches quality 0.80',
    },
    {
      priority: 'quality',
      policy: ceilingUsd === null ? null : { type: 'max_quality', costCeilingPer1K: ceilingUsd },
      infeasibleWhy: 'nothing has been measured for this workload, so there is no cost to bound',
    },
    {
      priority: 'speed',
      policy: boundMs === null ? null : { type: 'latency_bound', p95Ms: boundMs },
      infeasibleWhy: 'nothing has been measured for this workload, so there is no latency to bound',
    },
  ];

  return shapes.map(({ priority, policy, infeasibleWhy }) => {
    if (policy === null) {
      return { priority, policy: NO_POLICY, description: '', point: null, infeasible: infeasibleWhy };
    }
    // The SERVING path's selector, not a reimplementation — if these could
    // differ, the page would be promising a point the endpoint would not pick.
    const selected = selectPoint(policy, {
      id: 'plan',
      clusterId: points[0]?.clusterId ?? 'general',
      version: 0,
      parentId: null,
      trigger: 'manual',
      points,
      pricesVersion: 'plan',
      createdAt: new Date(0).toISOString(),
    });
    const latency = selected ? evidence[selected.strategyHash] : undefined;
    return {
      priority,
      policy,
      description: describePolicy(policy),
      point: selected
        ? {
            strategyHash: selected.strategyHash,
            strategy: describeStrategyBrief(selected.strategyConfig as StrategyConfig),
            quality: selected.quality,
            costPer1K: selected.costPer1K,
            latencyP95: selected.latencyP95,
            // Absent evidence is reported as the WEAKER case, never the
            // stronger one: an unknown provenance is harness-grade and
            // provisional until something proves otherwise.
            latencySource: latency?.source ?? 'harness',
            latencyProvisional: latency?.provisional ?? true,
            latencySpan: latency?.span ?? 'strategy-only',
            providerMode: selected.providerMode ?? 'unknown',
            n: selected.evidence?.n ?? null,
            qualityCi95: selected.evidence?.qualityCi95 ?? null,
            savedVsBestQuality:
              baselineCost !== null && baselineCost > 0 && selected.costPer1K < baselineCost
                ? (baselineCost - selected.costPer1K) / baselineCost
                : null,
          }
        : null,
      infeasible: selected ? null : infeasibleWhy,
    };
  });
}

export function registerPlanRoutes(app: FastifyInstance, ctx: PotionContext): void {
  app.post('/api/plan', async (req, reply) => {
    const parsed = PlanBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return reply.code(400).send(openAiError(message, 'invalid_request_error'));
    }
    const { description, samples } = parsed.data;
    const orgId = req.potionOrg!.orgId;

    // Classify. Samples, when given, are REAL traffic and outrank a
    // description of it, so they decide the cluster and the description only
    // breaks ties — someone describing "a support bot" whose prompts are all
    // extraction should be routed as extraction.
    const ranked = await ctx.assigner.rank(description);
    let winner = ranked[0]!;
    let sampleBreakdown: Record<string, number> | null = null;
    if (samples && samples.length > 0) {
      const assignments = await ctx.assigner.assignBatch(samples);
      const counts: Record<string, number> = {};
      for (const a of assignments) counts[a.clusterId] = (counts[a.clusterId] ?? 0) + 1;
      sampleBreakdown = counts;
      // Plurality of the samples wins; ties break toward the description's
      // pick so the answer stays deterministic.
      const best = Object.entries(counts).sort(
        (a, b) => b[1] - a[1] || (a[0] === winner.clusterId ? -1 : b[0] === winner.clusterId ? 1 : a[0].localeCompare(b[0])),
      )[0];
      if (best) {
        const fromRanking = ranked.find((r) => r.clusterId === best[0]);
        winner = fromRanking ?? { clusterId: best[0] as typeof winner.clusterId, confidence: 0 };
      }
    }

    const taxonomy = loadTaxonomy();
    const meta = (id: string) => taxonomy.clusters.find((c) => c.id === id);
    const winnerMeta = meta(winner.clusterId);

    // The evidence: the SAME frontier the serving path would use for this
    // cluster (org-preferred, platform fallback) through the SAME provenance
    // guard, so a mock-provenance frontier under live providers reports
    // unmeasured here exactly as it would fall back there.
    const loaded = await loadCurrentFrontier(ctx.db.db, winner.clusterId, orgId);
    const guarded = guardFrontierProvenance(loaded, ctx.providerMode);

    // G2.6's seam, not a shortcut around it. Serving-grade p95 replaces the
    // harness number wherever this org has enough real requests for this
    // cluster; a from-scratch org has none, so everything stays harness-grade
    // and PROVISIONAL — which is the honest label, and the one the serving
    // path would apply to the very same points. Using the raw frontier
    // latency here (as this route first did) states a fact about production
    // traffic that nobody has measured.
    const bound = await bindServingLatency(
      ctx,
      { type: 'latency_bound', p95Ms: Number.MAX_SAFE_INTEGER },
      guarded.frontier,
      orgId,
      winner.clusterId,
      (msg) => app.log.warn(msg),
    );
    const points = bound.frontier?.points ?? [];
    const latencyEvidence: LatencyEvidenceMap = bound.evidence ?? {};
    // How much measurement stands behind this frontier.
    //
    // Prefer the eval_results row counts, which include candidates that were
    // measured and then DOMINATED — the honest total campaign effort. But a
    // fresh deployment imports the committed baseline, which ships frontiers
    // and points and NOT the eval rows behind them, so those counts are zero
    // there. Falling back to the points' own evidence keeps the claim true on
    // every deployment; it just becomes a FLOOR (survivors only), and
    // `dominatedAway` is reported as unknown rather than guessed at zero.
    const rowCounts = await clusterEvidenceCounts(ctx.db.db, winner.clusterId, orgId);
    const fromPoints = {
      evaluations: points.reduce((sum, p) => sum + (p.evidence?.n ?? 0), 0),
      strategies: points.length,
      items: points.reduce((max, p) => Math.max(max, p.evidence?.n ?? 0), 0),
    };
    const haveRows = rowCounts.evaluations > 0;
    const counts = haveRows ? rowCounts : fromPoints;
    const options = policyOptionsFor(points, latencyEvidence);
    const baselineForRows = bestQualityCost(points);

    return reply.send({
      intent: {
        description,
        cluster: {
          clusterId: winner.clusterId,
          name: winnerMeta?.name ?? winner.clusterId,
          description: winnerMeta?.description ?? '',
          confidence: Math.round(winner.confidence * 1000) / 1000,
        },
        /** How far clear the winner is. Near zero = a coin flip, and the
         *  surface above must say so rather than presenting a confident pick. */
        margin: assignmentMargin(ranked),
        /** Runner-ups, so a wrong classification is visible and correctable. */
        alternatives: ranked
          .filter((r) => r.clusterId !== winner.clusterId)
          .slice(0, 3)
          .map((r) => ({
            clusterId: r.clusterId,
            name: meta(r.clusterId)?.name ?? r.clusterId,
            confidence: Math.round(r.confidence * 1000) / 1000,
          })),
        /** Which way each supplied sample actually classified (null = none). */
        sampleBreakdown,
        sampleCount: samples?.length ?? 0,
      },
      evidence: {
        measured: points.length > 0,
        /** How much measurement stands behind this frontier — distinct
         *  strategies tried, items tried on, and total evaluations. Real row
         *  counts, so the surface can show what produced the numbers rather
         *  than asking the reader to take three cards on faith. */
        ...counts,
        /** Strategies measured and then beaten outright. NULL when the eval
         *  rows are absent (a baseline-only deployment), because "we
         *  discarded 0" and "we cannot see how many we discarded" are
         *  different statements and only one of them is true. */
        dominatedAway: haveRows ? Math.max(0, rowCounts.strategies - points.length) : null,
        /** false = counts are a floor derived from surviving points only. */
        countsAreComplete: haveRows,
        frontierVersion: guarded.frontier?.version ?? null,
        provenance: guarded.provenance,
        pointCount: points.length,
        /** 'harness' until this org has real serving traffic for this
         *  cluster — which, for the customer this page exists for, is
         *  always. Per-option provenance rides on each point. */
        latencySource: bound.source,
      },
      options,
      /** EVERY measured strategy, not just the three a policy shape happens
       *  to select. Sorted best-quality first; the surface re-sorts. */
      frontier: points
        .map((pt): FrontierRow => {
          const lat = latencyEvidence[pt.strategyHash];
          const selectedBy = options
            .filter((o) => o.point?.strategyHash === pt.strategyHash)
            .map((o) => o.priority);
          return {
            strategyHash: pt.strategyHash,
            strategy: describeStrategyBrief(pt.strategyConfig as StrategyConfig),
            quality: pt.quality,
            qualityCi95: pt.evidence?.qualityCi95 ?? null,
            costPer1K: pt.costPer1K,
            latencyP95: pt.latencyP95,
            latencyProvisional: lat?.provisional ?? true,
            n: pt.evidence?.n ?? null,
            providerMode: pt.providerMode ?? 'unknown',
            savedVsBestQuality:
              baselineForRows !== null && baselineForRows > 0 && pt.costPer1K < baselineForRows
                ? (baselineForRows - pt.costPer1K) / baselineForRows
                : null,
            selectedBy,
            policy: policyBinding(pt, points),
          };
        })
        .sort((a, b) => b.quality - a.quality || a.costPer1K - b.costPer1K),
      /**
       * WHAT THESE NUMBERS ARE. Potion's own measurement of this workload
       * type across providers — not a measurement of the caller's traffic,
       * which does not exist yet. Stated as a field rather than left to the
       * page's prose so it cannot be dropped by a redesign.
       */
      basis: points.length > 0 ? 'platform-measured' : 'unmeasured',
    });
  });
}
