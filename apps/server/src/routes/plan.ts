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
import { selectPoint, type FrontierPoint, type Policy, type StrategyConfig } from '@potion/core';
import { loadTaxonomy } from '@potion/cluster';
import { loadCurrentFrontier } from '@potion/pareto';
import { openAiError } from '../auth.js';
import type { PotionContext } from '../context.js';
import { guardFrontierProvenance } from './chat.js';
import { describeStrategyBrief } from './reports.js';
import { describePolicy } from './connection.js';

/** Cap on how much text we embed per plan — a bound on cost and on abuse. */
const MAX_DESCRIPTION_CHARS = 4000;
const MAX_SAMPLES = 10;

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
    providerMode: string;
    /** Sample count behind the quality number; null on pre-evidence points. */
    n: number | null;
    qualityCi95: number | null;
  } | null;
  /** Present exactly when point is null. Never hidden, never worked around. */
  infeasible: string | null;
}

/**
 * The three single-constraint policy shapes, each with the point it would
 * actually select. The defaults are the platform defaults used everywhere
 * else (min_cost @ 0.8, max_quality @ $1/1K, latency_bound @ 1000ms) so a
 * customer arriving here and a customer arriving through the policy picker
 * get the same thing.
 */
export function policyOptionsFor(points: FrontierPoint[]): PolicyOption[] {
  const shapes: Array<{ priority: PolicyOption['priority']; policy: Policy; infeasibleWhy: string }> = [
    {
      priority: 'cost',
      policy: { type: 'min_cost', qualityFloor: 0.8 },
      infeasibleWhy: 'no measured strategy for this workload reaches quality 0.80',
    },
    {
      priority: 'quality',
      policy: { type: 'max_quality', costCeilingPer1K: 1.0 },
      infeasibleWhy: 'every measured strategy for this workload costs more than $1.0000 per 1K tokens',
    },
    {
      priority: 'speed',
      policy: { type: 'latency_bound', p95Ms: 1000 },
      infeasibleWhy: 'no measured strategy for this workload holds p95 latency under 1000 ms',
    },
  ];

  return shapes.map(({ priority, policy, infeasibleWhy }) => {
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
            providerMode: selected.providerMode ?? 'unknown',
            n: selected.evidence?.n ?? null,
            qualityCi95: selected.evidence?.qualityCi95 ?? null,
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
    const points = guarded.frontier?.points ?? [];

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
        frontierVersion: guarded.frontier?.version ?? null,
        provenance: guarded.provenance,
        pointCount: points.length,
      },
      options: policyOptionsFor(points),
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
