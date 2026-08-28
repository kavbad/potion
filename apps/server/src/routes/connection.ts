// CONNECT & AUTO-ROUTE — the two reads a customer needs to actually use
// Potion, and the two the product did not have.
//
// The gap this closes. Everything needed to connect already existed in the
// database and nothing could retrieve it: the serving key was displayed once,
// transiently, in the policy picker and never again; the bound policy was
// legible only as raw JSON; the base URL was re-derived per surface (wrongly,
// behind a proxy — see ../public-url.ts); and whether the auto-switch had
// done anything was knowable only by reading a response header at the moment
// it came back. A customer who closed the tab had no way back in.
//
//   GET /api/connection       — where do I point traffic, with what key,
//                               under what policy, and is routing actually
//                               ready for my kind of work?
//   GET /api/routing-activity — did it route MY requests, or default them?
//
// THE HONESTY RULE, which shapes both. `routed` is never inferred from
// something weaker than the decision itself: it is read back out of the
// trace string we handed the caller on `x-frontier-trace`, and requires BOTH
// a real frontier and a policy-selected point (traceWasRouted). Anything
// unknown — a row with no trace, an unrecognised token — counts as not
// proven, never as routed. A dashboard that renders "auto-routing: on" while
// every request rides the default strategy is the exact failure this product
// exists to make impossible, and it would be the easiest one to ship.
import type { FastifyInstance } from 'fastify';
import type { Policy } from '@potion/core';
import { PolicySchema } from '@potion/core';
import { getOrgById, listApiKeys, listRequestLogs, listServingPolicies } from '@potion/db';
import { loadTaxonomy } from '@potion/cluster';
import { loadCurrentFrontier } from '@potion/pareto';
import type { PotionContext } from '../context.js';
import { publicBaseUrl } from '../public-url.js';
import { guardFrontierProvenance, parseTraceHeader, traceWasRouted } from './chat.js';
import { compileAndMintRouter, routerVersionForRequest } from '../routing/compile-router.js';
import { routerModelName } from '../routing/router-slug.js';
import { buildEndpointSnippets } from './dashboard.js';

/**
 * The policy, in a sentence a person can check against their intent.
 *
 * Raw policy JSON is precise and unreadable; a sentence is readable and can
 * drift from the JSON. So this renders FROM the policy object on every read
 * rather than being stored, and the numbers in the sentence are the numbers
 * in the object — there is nothing to fall out of sync with.
 */
export function describePolicy(policy: Policy): string {
  switch (policy.type) {
    case 'min_cost':
      return (
        `Cheapest option that keeps measured quality at or above ` +
        `${policy.qualityFloor.toFixed(2)}.`
      );
    case 'max_quality':
      // "per 1K tokens" was WRONG and made every cost read ~1000x too high:
      // FrontierPoint.costPer1K is USD per 1000 REQUESTS (core types.ts).
      return (
        `Highest measured quality available under ` +
        `$${policy.costCeilingPer1K.toFixed(4)} per 1,000 requests.`
      );
    case 'latency_bound':
      return `Best quality that holds p95 latency under ${policy.p95Ms} ms.`;
    case 'compound':
      return (
        `Cheapest option that keeps measured quality at or above ` +
        `${policy.qualityFloor.toFixed(2)} AND holds p95 latency under ${policy.p95Ms} ms.`
      );
  }
}

export interface ClusterReadiness {
  clusterId: string;
  /** Taxonomy name + description — the kind of work this cluster covers. */
  name: string;
  description: string;
  /** A frontier exists AND survives the provenance guard for this server. */
  ready: boolean;
  frontierVersion: number | null;
  pointCount: number;
  /** Exactly what the serving path would report for this cluster today. */
  provenance: 'live' | 'mock' | 'blocked';
}

/**
 * Per-cluster routing readiness, computed by the SAME two functions the serve
 * path uses — `loadCurrentFrontier` (org-preferred, platform fallback) then
 * `guardFrontierProvenance` against this server's real provider mode.
 *
 * Deliberately not a cheaper approximation (e.g. "does a frontier row
 * exist"). A mock-provenance frontier under live providers is discarded at
 * serve time, so counting the row would report readiness for a cluster that
 * will fall back on the very next request. If this number and the serving
 * path can disagree, the number is decoration.
 */
export async function clusterReadiness(
  ctx: PotionContext,
  orgId: string,
): Promise<ClusterReadiness[]> {
  const taxonomy = loadTaxonomy();
  const out: ClusterReadiness[] = [];
  for (const cluster of taxonomy.clusters) {
    const loaded = await loadCurrentFrontier(ctx.db.db, cluster.id, orgId);
    const guarded = guardFrontierProvenance(loaded, ctx.providerMode);
    const frontier = guarded.frontier;
    out.push({
      clusterId: cluster.id,
      name: cluster.name,
      description: cluster.description,
      ready: frontier !== null && frontier.points.length > 0,
      frontierVersion: frontier?.version ?? null,
      pointCount: frontier?.points.length ?? 0,
      provenance: guarded.provenance,
    });
  }
  return out;
}

export function registerConnectionRoutes(app: FastifyInstance, ctx: PotionContext): void {
  const db = ctx.db.db;

  // ---- GET /api/connection (viewer) ----
  // One read that answers "how do I use this", so the connect surface is a
  // page you can come back to rather than a moment you had to catch.
  app.get('/api/connection', async (req, reply) => {
    const orgId = req.potionOrg!.orgId;
    const baseUrl = publicBaseUrl(req);

    // The org's bound policy. listPolicies is creation-ordered; the first is
    // what a self-serve signup bound, and it is what /api/endpoint-snippet
    // falls back to, so both surfaces name the same policy.
    const connOrg = await getOrgById(db, orgId);
    const policies = await listServingPolicies(db, orgId);
    const firstPolicy = policies[0];
    let policy: Policy | null = null;
    if (firstPolicy) {
      const parsed = PolicySchema.safeParse(firstPolicy.config);
      if (parsed.success) policy = parsed.data;
    }

    // Serving keys: metadata only. The raw key exists in no readable form —
    // only its sha256 is stored — so this cannot show it, and the page says
    // so rather than implying the key is recoverable.
    const keyRows = await listApiKeys(db, orgId);
    const servingKeys = keyRows.map((k) => ({
      id: k.id,
      name: k.name,
      scopes: k.scopes,
      env: k.env,
      policyId: k.policyId,
      createdAt: k.createdAt,
      expiresAt: k.expiresAt,
      revokedAt: k.revokedAt,
    }));

    // Who pays for this org's traffic, per provider. `byokProviders` are
    // served from the org's own custodied keys; everything else is on
    // Potion's platform keys. This is a statement about SERVING, not about
    // billing — nothing yet records which of the two paid for a given
    // request (S3 of docs/SERVING-ROADMAP.md), and this must not be read as
    // if it did.
    const orgProviders = await ctx.providersForOrg(orgId);
    const byokProviders = [...orgProviders.byokProviders].sort();
    const byokSet = new Set<string>(byokProviders);
    const platformProviders = Object.keys(orgProviders.providers)
      .filter((p) => !byokSet.has(p))
      .sort();

    const readiness = await clusterReadiness(ctx, orgId);

    return reply.send({
      baseUrl,
      endpoint: `${baseUrl}/v1/chat/completions`,
      /** true when the operator pinned POTION_PUBLIC_URL; false = derived
       *  from this request, which is only trustworthy without a proxy. */
      baseUrlConfigured: process.env.POTION_PUBLIC_URL !== undefined
        && process.env.POTION_PUBLIC_URL.trim() !== '',
      policy: policy
        ? {
            id: firstPolicy!.id,
            name: firstPolicy!.name,
            config: policy,
            description: describePolicy(policy),
          }
        : null,
      router: { name: routerModelName(connOrg?.name ?? 'org') },
      snippets: policy ? buildEndpointSnippets(baseUrl, policy, routerModelName(connOrg?.name ?? 'org')) : null,
      servingKeys,
      serving: {
        providerMode: ctx.providerMode,
        byok: orgProviders.byok,
        byokProviders,
        platformProviders,
      },
      autoRouting: {
        ready: readiness.filter((c) => c.ready).length,
        total: readiness.length,
        clusters: readiness,
      },
    });
  });

  // ---- GET /api/routing-activity (viewer) ----
  // The proof half: recent requests with the routing decision each one got,
  // quoted from what we told the caller at the time.
  app.get('/api/routing-activity', async (req, reply) => {
    const orgId = req.potionOrg!.orgId;
    const { limit: rawLimit } = req.query as { limit?: string };
    const parsedLimit = Number(rawLimit);
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(Math.trunc(parsedLimit), 1), 200)
      : 50;

    const rows = await listRequestLogs(db, orgId, limit);
    // R2: compile-and-mint FIRST, so a frontier bump that moved routing this
    // morning is minted as the next version before any receipt names one —
    // then attribute each request to the version whose recorded assignment
    // it actually rode (content match, never timestamp guesswork).
    const compiled = await compileAndMintRouter(ctx, db, orgId, (m) => app.log.warn(m));
    const requests = rows.map((r) => {
      const t = parseTraceHeader(r.trace);
      const usage = r.usage as { costUsd?: number; totalTokens?: number } | null;
      return {
        ts: r.ts,
        status: r.status,
        model: r.model,
        servedModel: r.servedModel ?? null,
        latencyMs: r.latencyMs,
        costUsd: usage?.costUsd ?? null,
        baselineCostUsd: r.baselineCostUsd ?? null,
        clusterId: t.clusterId,
        strategy: t.strategyHash8,
        frontierVersion: t.frontierVersion,
        policyType: t.policyType,
        fallback: t.fallback,
        provenance: t.provenance,
        /** The whole claim, in one field — see traceWasRouted. */
        routed: traceWasRouted(t),
        /** R2: the router version this request's routing is recorded in;
         * null = never minted (or no routing decision). */
        routerVersion: routerVersionForRequest(compiled.history, {
          clusterId: t.clusterId,
          strategy8: t.strategyHash8,
          frontierVersion: t.frontierVersion,
        }),
      };
    });

    // Counted over rows that CARRY a routing decision. Non-serving rows
    // (auth_failed, no_policy, budget refusals) have no trace and are not
    // requests the switch could have routed; folding them into the
    // denominator would make a broken key look like a routing failure, and
    // dropping them from the list would hide the actual problem — so they
    // stay visible above and stay out of the ratio.
    const decided = requests.filter((r) => r.fallback !== null);
    const routed = decided.filter((r) => r.routed);
    const byCluster: Record<string, number> = {};
    for (const r of routed) {
      if (r.clusterId) byCluster[r.clusterId] = (byCluster[r.clusterId] ?? 0) + 1;
    }

    return reply.send({
      requests,
      router: { name: compiled.name, version: compiled.version },
      summary: {
        returned: requests.length,
        withRoutingDecision: decided.length,
        routed: routed.length,
        defaulted: decided.length - routed.length,
        clustersSeen: Object.keys(byCluster).sort(),
        byCluster,
      },
    });
  });
}
