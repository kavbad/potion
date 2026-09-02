// G2 rung 1 — discovered org workloads (migration 0087).
//
//   GET  /api/workloads/discovered  viewer — the org's observed structure
//   POST /api/workloads/discover    admin  — refresh the snapshot (enqueue)
//
// Discovery is OBSERVED-only: the rows describe what the org's consented
// samples reveal inside each serving cluster; nothing routes by them yet
// (routing adoption is a later, explicit rung). Centroids stay internal —
// the DTO carries the human-weighable facts: counts, cohesion, the
// (redacted) exemplar.
import type { FastifyInstance } from 'fastify';
import { listOrgWorkloads } from '@potion/db';
import type { PotionQueue } from '@potion/queue';
import { openAiError, requireRole } from '../auth.js';
import type { PotionContext } from '../context.js';

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
}
