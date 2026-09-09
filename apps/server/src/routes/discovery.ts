// G2 rungs 1–3 — discovered org workloads (migrations 0087–0089).
//
//   GET  /api/workloads/discovered   viewer — the org's observed structure
//   POST /api/workloads/discover     admin  — refresh the snapshot (enqueue)
//   POST /api/workloads/:id/adopt    admin  — route on a MEASURED workload
//   POST /api/workloads/:id/retire   admin  — hand routing back to the parent
//
// Discovery is OBSERVED-only: the rows describe what the org's consented
// samples reveal inside each serving cluster, and nothing routes by them
// until an admin ADOPTS one. Adopt is the challenger-apply mechanism at
// workload grain: it does not pin anything — it aggregates the workload's
// own org measurements into an org frontier AT THE WORKLOAD ID, and the
// serve path's sub-assignment (routing/workload-assignment.ts) re-addresses
// matching requests there. Selection still runs the lower-bound law over
// the measured points, so a workload whose measured quality cannot clear
// the floor simply does not serve differently. Retire reverses it — the
// adopted row returns to 'measured' and the very next request serves the
// parent as before (the minted frontier stays, inert, for re-adoption).
// Centroids stay internal — the DTO carries the human-weighable facts:
// counts, cohesion, the (redacted) exemplar, the measurement.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { PolicySchema, strategyHash, type Policy, type StrategyConfig } from '@potion/core';
import {
  listOrgWorkloads,
  listServingPolicies,
  setWorkloadStatus,
  strategiesMeasuredAt,
} from '@potion/db';
import {
  DEFAULT_ORG_POLICY,
  aggregatesFromEvalResults,
  computeFrontier,
  saveFrontier,
  servingDecisionFor,
} from '@potion/pareto';
import type { PotionQueue } from '@potion/queue';
import { openAiError, requireRole } from '../auth.js';
import type { PotionContext } from '../context.js';
import { bustWorkloadRoutingCache } from '../routing/workload-assignment.js';
import { strategyModelLabel } from './chat.js';

export function registerDiscoveryRoutes(
  app: FastifyInstance,
  ctx: PotionContext,
  opts: { queue?: PotionQueue } = {},
): void {
  const db = ctx.db.db;

  app.get('/api/workloads/discovered', async (req, reply) => {
    const orgId = req.potionOrg!.orgId;
    const rows = await listOrgWorkloads(db, orgId);
    return reply.send({
      workloads: rows.map((w) => ({
        id: w.id,
        parentCluster: w.parentCluster,
        sampleCount: w.sampleCount,
        cohesion: w.cohesion,
        exemplarText: w.exemplarText,
        status: w.status,
        windowDays: w.windowDays,
        /** G2 rung 2: serving-vs-incumbent measured on THIS workload's own
         * items; null until measured (and after re-discovery — the old
         * measurement described the old grouping). */
        measurement: w.measurement ?? null,
        createdAt: w.createdAt.toISOString(),
      })),
    });
  });

  app.post('/api/workloads/discover', { preHandler: [requireRole('admin')] }, async (req, reply) => {
    const org = req.potionOrg!;
    if (!opts.queue) return reply.code(503).send(openAiError('no job queue on this server', 'server_error'));
    const jobId = await opts.queue.enqueue('workloads:discover', { orgId: org.orgId });
    return reply.code(202).send({ jobId });
  });

  // ---- POST /api/workloads/:id/adopt (admin) ----
  app.post('/api/workloads/:id/adopt', { preHandler: [requireRole('admin')] }, async (req, reply) => {
    const orgId = req.potionOrg!.orgId;
    const { id } = req.params as { id: string };
    const w = (await listOrgWorkloads(db, orgId)).find((r) => r.id === id);
    if (w === undefined) return reply.code(404).send(openAiError(`unknown workload '${id}'`, 'invalid_request_error', 'not_found'));
    if (w.status !== 'measured') {
      return reply.code(409).send(
        openAiError(
          w.status === 'adopted' ? 'workload is already adopted' : `workload is '${w.status}' — only a measured workload can be adopted`,
          'invalid_request_error',
          'workload_not_measured',
        ),
      );
    }

    // The frontier aggregates the workload's OWN org measurements — the
    // rows rung 2 landed at the workload-id coordinate. Same purity gates
    // as challenger apply (org-scoped, current prices, this server's
    // provider mode, one instrument); the list helper and the aggregation
    // share those gates by construction.
    const measured = await strategiesMeasuredAt(db, {
      clusterId: id,
      orgId,
      pricesVersion: ctx.prices.version,
      providerMode: ctx.providerMode,
    });
    const strategies = measured.map((m) => m.strategyConfig as StrategyConfig);
    if (strategies.length === 0) {
      return reply.code(409).send(
        openAiError(
          `no org-scoped ${ctx.providerMode} measurements for this workload at prices ${ctx.prices.version} — re-run discovery before adopting`,
          'invalid_request_error',
          'evidence_missing',
        ),
      );
    }
    const aggregates = await aggregatesFromEvalResults(db, id, strategies, ctx.prices.version, {
      orgId,
      providerMode: ctx.providerMode,
    });
    const points = computeFrontier(aggregates);
    if (points.length === 0) {
      return reply.code(409).send(
        openAiError('measurements aggregate to an empty frontier — nothing servable to adopt', 'invalid_request_error', 'evidence_missing'),
      );
    }
    const saved = await saveFrontier(db, id, points, 'recompute', ctx.prices.version, {
      orgId,
      provenance: { suiteId: `learn-${id}-v1` },
    });
    // Frontier first, status second: a minted frontier under a still-
    // 'measured' row is inert (sub-assignment consults adopted rows only),
    // while an adopted row with no frontier would fail open per request.
    const flipped = await setWorkloadStatus(db, orgId, id, 'measured', 'adopted');
    if (!flipped) return reply.code(409).send(openAiError('workload changed concurrently — re-read and retry', 'invalid_request_error', 'workload_not_measured'));
    bustWorkloadRoutingCache(orgId);

    // What the workload NOW serves, through the one resolver — the honest
    // answer to "adopt" is what a matching request will get next.
    const firstPolicy = (await listServingPolicies(db, orgId))[0];
    const parsed = firstPolicy !== undefined ? PolicySchema.safeParse(firstPolicy.config) : null;
    const policy: Policy = parsed?.success ? parsed.data : DEFAULT_ORG_POLICY;
    const d = await servingDecisionFor(db, {
      orgId,
      clusterId: id,
      policy,
      providerMode: ctx.providerMode,
      prices: ctx.prices,
    });
    return reply.send({
      adopted: true,
      frontierId: saved.id,
      frontierVersion: saved.version,
      points: points.length,
      nowServes:
        d.op.config === null
          ? null
          : {
              model: strategyModelLabel(d.op.config),
              strategy: strategyHash(d.op.config).slice(0, 8),
              fallback: d.op.fallback,
              ...(d.op.fallbackReason !== undefined ? { fallbackReason: d.op.fallbackReason } : {}),
            },
      requestId: `adopt-${randomUUID().slice(0, 8)}`,
    });
  });

  // ---- POST /api/workloads/:id/retire (admin) ----
  app.post('/api/workloads/:id/retire', { preHandler: [requireRole('admin')] }, async (req, reply) => {
    const orgId = req.potionOrg!.orgId;
    const { id } = req.params as { id: string };
    const w = (await listOrgWorkloads(db, orgId)).find((r) => r.id === id);
    if (w === undefined) return reply.code(404).send(openAiError(`unknown workload '${id}'`, 'invalid_request_error', 'not_found'));
    if (w.status !== 'adopted') {
      return reply.code(409).send(openAiError(`workload is '${w.status}', not adopted`, 'invalid_request_error', 'workload_not_adopted'));
    }
    const flipped = await setWorkloadStatus(db, orgId, id, 'adopted', 'measured');
    if (!flipped) return reply.code(409).send(openAiError('workload changed concurrently — re-read and retry', 'invalid_request_error', 'workload_not_adopted'));
    bustWorkloadRoutingCache(orgId);
    return reply.send({ retired: true, parentCluster: w.parentCluster, requestId: `retire-${randomUUID().slice(0, 8)}` });
  });
}
