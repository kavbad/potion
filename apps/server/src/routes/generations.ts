// G2 rung 4 — ROUTER GENERATIONS (migration 0092).
//
//   GET  /api/router/generations             viewer — the lineage
//   POST /api/router/generations             admin  — stage what serves NOW
//   POST /api/router/generations/:id/promote admin  — make it the router
//   POST /api/router/generations/:id/rollback admin — put a previous one back
//
// WHY THIS EXISTS. A router VERSION was descriptive: the compiler minted one
// whenever the decision inputs changed, and it was live the moment it
// existed, because serving recomputes from whatever frontiers are current.
// There was no way to stage a routing change and no way to put one back —
// the only undo was a per-cluster pin, applied by hand, one cluster at a
// time, with nothing recording that the set belonged together.
//
// A GENERATION is that decision made durable: the whole routing surface
// captured as frontier ids, promoted atomically, reversible in one call.
// Serving needs no new concept — getServingFrontier already honours a pin —
// so promote writes the pin set and rollback writes the previous one's.
//
// Staging captures the routing the CURRENT EVIDENCE implies — the same
// frontier resolution serving uses, minus the pins a previous generation
// wrote, and behind the same provenance guard. Reading through those pins
// would make every generation capture its predecessor.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { PolicySchema, type Policy } from '@potion/core';
import {
  getServingFrontier,
  getRouterGeneration,
  insertRouterGeneration,
  listRouterGenerations,
  listServingPolicies,
  promoteGeneration,
  rollbackCandidates,
  rollbackTo,
  servingGeneration,
  setCanaryRate,
  generationEvidence,
  noteGenerationOverride as noteOverride,
  type GenerationPin,
} from '@potion/db';
import {
  DEFAULT_ORG_POLICY,
  fallbackStrategyFor,
  guardFrontierProvenance,
  policyForCluster,
  resolveOperatingPoint,
} from '@potion/pareto';
import { loadTaxonomy } from '@potion/cluster';
import { listClusters } from '@potion/db';
import { openAiError, requireRole } from '../auth.js';
import type { PotionContext } from '../context.js';
import { compileAndMintRouter } from '../routing/compile-router.js';
import { bustCanaryCache } from '../routing/canary.js';
import { generationVerdict } from '../routing/generation-verdict.js';

/** The org's bound policy, resolved exactly as the compiler resolves it. */
async function orgPolicy(ctx: PotionContext, orgId: string): Promise<Policy> {
  const first = (await listServingPolicies(ctx.db.db, orgId))[0];
  const parsed = first !== undefined ? PolicySchema.safeParse(first.config) : null;
  return parsed?.success ? parsed.data : DEFAULT_ORG_POLICY;
}

/**
 * The routing surface as it stands: every cluster that resolves to a real
 * frontier, with the exact frontier id serving it. Clusters with no frontier
 * are omitted rather than recorded as null — a generation names what it
 * pins, and a cluster it does not name is one it does not freeze.
 */
export async function captureServingPins(
  ctx: PotionContext,
  orgId: string,
): Promise<Record<string, GenerationPin>> {
  const policy = await orgPolicy(ctx, orgId);
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const c of loadTaxonomy().clusters) if (!seen.has(c.id)) { seen.add(c.id); ids.push(c.id); }
  for (const c of await listClusters(ctx.db.db, { orgId })) if (!seen.has(c.id)) { seen.add(c.id); ids.push(c.id); }

  const pins: Record<string, GenerationPin> = {};
  for (const clusterId of ids.sort()) {
    // ignorePins: a generation describes the routing the CURRENT EVIDENCE
    // implies, not the routing a previous generation froze. Reading through
    // the pin here would make every generation after the first capture its
    // predecessor, so promoting could never advance — caught by the e2e's
    // "a NEW generation captures the newer frontier" case.
    const loaded = await getServingFrontier(ctx.db.db, clusterId, orgId, 'default', { ignorePins: true });
    // The same provenance guard serving applies: a mock-provenance frontier
    // under live providers is not servable, so it is never pinned into a
    // generation either.
    const guarded = guardFrontierProvenance(loaded, ctx.providerMode);
    if (guarded.frontier === null || guarded.frontier.points.length === 0) continue;
    // The policy still has to RESOLVE against it — a frontier no operating
    // point can be chosen from is not routing anyone anywhere.
    const point = resolveOperatingPoint(
      policyForCluster(policy, clusterId),
      guarded.frontier,
      fallbackStrategyFor(ctx.providerMode, ctx.prices),
      {},
    );
    if (point.config === null) continue;
    pins[clusterId] = {
      frontierId: guarded.frontier.id,
      frontierVersion: guarded.frontier.version,
      instrument: (guarded.frontier.instrument ?? 'default') as GenerationPin['instrument'],
    };
  }
  return pins;
}

const dto = (g: Awaited<ReturnType<typeof listRouterGenerations>>[number]) => ({
  id: g.id,
  status: g.status,
  clusters: Object.keys(g.pins as Record<string, GenerationPin>).length,
  routerVersion: g.routerVersion,
  canaryRate: g.canaryRate,
  note: g.note,
  createdAt: g.createdAt.toISOString(),
  promotedAt: g.promotedAt?.toISOString() ?? null,
  endedAt: g.endedAt?.toISOString() ?? null,
});

export function registerGenerationRoutes(app: FastifyInstance, ctx: PotionContext): void {
  const db = ctx.db.db;

  app.get('/api/router/generations', async (req, reply) => {
    const orgId = req.potionOrg!.orgId;
    const [all, serving, canRollback] = await Promise.all([
      listRouterGenerations(db, orgId),
      servingGeneration(db, orgId),
      rollbackCandidates(db, orgId),
    ]);
    return reply.send({
      generations: all.map(dto),
      servingId: serving?.id ?? null,
      rollbackTo: canRollback.map(dto),
    });
  });

  app.post('/api/router/generations', { preHandler: [requireRole('admin')] }, async (req, reply) => {
    const orgId = req.potionOrg!.orgId;
    const { note } = (req.body ?? {}) as { note?: string };
    const pins = await captureServingPins(ctx, orgId);
    if (Object.keys(pins).length === 0) {
      return reply
        .code(409)
        .send(openAiError('nothing is serving yet — there is no routing to capture', 'invalid_request_error', 'nothing_to_capture'));
    }
    // The artifact and the pins are captured together so a reader can tie
    // "what the compiler said" to "what it froze".
    const compiled = await compileAndMintRouter(ctx, db, orgId, (m) => app.log.warn(m));
    const row = await insertRouterGeneration(db, {
      id: `gen-${randomUUID().slice(0, 8)}`,
      orgId,
      pins,
      routerVersion: compiled.version,
      note: typeof note === 'string' && note.trim() !== '' ? note.trim().slice(0, 200) : null,
    });
    return reply.code(201).send({ generation: dto(row), pins });
  });

  // Start, adjust or stop a canary. Rate 0 stops it; the generation stays a
  // candidate either way — canarying is not a status, it is a dial.
  app.post('/api/router/generations/:id/canary', { preHandler: [requireRole('admin')] }, async (req, reply) => {
    const orgId = req.potionOrg!.orgId;
    const { id } = req.params as { id: string };
    const { rate } = (req.body ?? {}) as { rate?: unknown };
    if (typeof rate !== 'number') {
      return reply.code(400).send(openAiError('rate must be a number between 0 and 0.5', 'invalid_request_error', 'invalid_rate'));
    }
    const res = await setCanaryRate(db, orgId, id, rate);
    if (!res.ok) {
      const code = res.reason === 'unknown generation' ? 404 : 409;
      return reply.code(code).send(openAiError(res.reason!, 'invalid_request_error', code === 404 ? 'not_found' : 'canary_refused'));
    }
    // In-process, so the next request binds the change rather than waiting
    // out the cache — the same courtesy the holdout settings route pays.
    bustCanaryCache(orgId);
    return reply.send({ generation: dto(res.generation!), canaryRate: res.generation!.canaryRate });
  });

  // What this candidate's canary has proved so far, on the org's own traffic.
  app.get('/api/router/generations/:id/evidence', async (req, reply) => {
    const orgId = req.potionOrg!.orgId;
    const { id } = req.params as { id: string };
    const gen = await getRouterGeneration(db, orgId, id);
    if (gen === null) {
      return reply.code(404).send(openAiError(`unknown generation '${id}'`, 'invalid_request_error', 'not_found'));
    }
    const verdict = generationVerdict(await generationEvidence(db, orgId, id), id);
    return reply.send({ generation: dto(gen), verdict });
  });

  app.post('/api/router/generations/:id/promote', { preHandler: [requireRole('admin')] }, async (req, reply) => {
    const orgId = req.potionOrg!.orgId;
    const { id } = req.params as { id: string };
    const { acceptDegradation } = (req.body ?? {}) as { acceptDegradation?: unknown };
    // THE GATE. Refuse only what the org's OWN traffic condemns: a candidate
    // its canary measured as confidently worse. Thin or merely unconvincing
    // evidence does not block — promoting a never-canaried generation is an
    // ordinary act, so punishing an operator for gathering evidence would be
    // backwards. The override exists because a human may know something the
    // measurement does not, and it is RECORDED on the row rather than
    // silently honoured.
    const verdict = generationVerdict(await generationEvidence(db, orgId, id), id);
    if (verdict.adverse && acceptDegradation !== true) {
      return reply.code(409).send(
        openAiError(
          `your own traffic says this generation is worse — ${verdict.reasons.join(' ')} ` +
            'Send acceptDegradation: true to promote it anyway; the override is recorded on the generation.',
          'invalid_request_error',
          'generation_evidence_adverse',
        ),
      );
    }
    if (verdict.adverse && acceptDegradation === true) {
      await noteOverride(db, orgId, id, verdict.reasons.join(' '));
    }
    const res = await promoteGeneration(db, orgId, id);
    if (!res.ok) {
      const code = res.reason === 'unknown generation' ? 404 : 409;
      return reply.code(code).send(openAiError(res.reason!, 'invalid_request_error', code === 404 ? 'not_found' : 'generation_not_promotable'));
    }
    return reply.send({
      promoted: true,
      verdict,
      generation: dto(res.generation!),
      supersededId: res.previous?.id ?? null,
      requestId: `promote-${randomUUID().slice(0, 8)}`,
    });
  });

  app.post('/api/router/generations/:id/rollback', { preHandler: [requireRole('admin')] }, async (req, reply) => {
    const orgId = req.potionOrg!.orgId;
    const { id } = req.params as { id: string };
    const target = await getRouterGeneration(db, orgId, id);
    if (target === null) {
      return reply.code(404).send(openAiError(`unknown generation '${id}'`, 'invalid_request_error', 'not_found'));
    }
    const res = await rollbackTo(db, orgId, id);
    if (!res.ok) {
      return reply.code(409).send(openAiError(res.reason!, 'invalid_request_error', 'generation_not_rollbackable'));
    }
    return reply.send({
      rolledBack: true,
      generation: dto(res.generation!),
      rolledBackFromId: res.previous?.id ?? null,
      requestId: `rollback-${randomUUID().slice(0, 8)}`,
    });
  });
}
