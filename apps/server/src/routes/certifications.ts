// Suite-certification routes (post-capstone item 3, Decision 2).
//
//   POST /api/certifications/run   admin — enqueue suite:certify for ONE of
//                                  the caller's clusters (capped, metered;
//                                  cross-org cluster ids 404 — no existence
//                                  oracle). Optional suiteId addresses a
//                                  specific suite generation (the
//                                  session-vs-step comparability leg).
//   GET  /api/certifications       viewer+ — org-scoped list. OWNER RULE:
//                                  every certification attempt is visible
//                                  with status + evidence — certified,
//                                  failed (the self-retention number in the
//                                  reason), refused (evidence.refused:
//                                  REFUSED, NOT MEASURED), superseded.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getClusterByIdForOrg, listSuiteCertifications } from '@potion/db';
import type { PotionQueue } from '@potion/queue';
import type { SuiteCertifyPayload } from '@potion/workers';
import { openAiError, roleAtLeast } from '../auth.js';
import type { PotionContext } from '../context.js';

export interface CertificationRoutesOptions {
  queue: PotionQueue;
}

export function registerCertificationRoutes(
  app: FastifyInstance,
  ctx: PotionContext,
  opts: CertificationRoutesOptions,
): void {
  const db = ctx.db.db;

  // ---- POST /api/certifications/run (admin) ----
  app.post('/api/certifications/run', async (req: FastifyRequest, reply) => {
    const org = req.potionOrg!;
    if (!roleAtLeast(org.role, 'admin')) {
      return reply
        .code(403)
        .send(
          openAiError(
            `role '${org.role}' may not run certifications — requires 'admin'`,
            'invalid_request_error',
            'insufficient_role',
          ),
        );
    }
    const body = z
      .object({
        clusterId: z.string().min(1),
        suiteId: z.string().min(1).optional(),
        capUsd: z.number().positive().max(50).optional(),
      })
      .safeParse(req.body ?? {});
    if (!body.success) {
      return reply.code(400).send({
        error: 'invalid_body',
        message: body.error.issues.map((i) => i.message).join('; '),
      });
    }
    // Cluster ownership: another org's cluster id gets the SAME 404 as a
    // nonexistent one (no existence oracle) — the job re-verifies too.
    const cluster = await getClusterByIdForOrg(db, body.data.clusterId, org.orgId);
    if (!cluster) {
      return reply
        .code(404)
        .send(openAiError('cluster not found', 'invalid_request_error', 'cluster_not_found'));
    }
    const payload: SuiteCertifyPayload = {
      orgId: org.orgId,
      clusterId: body.data.clusterId,
      ...(body.data.suiteId !== undefined ? { suiteId: body.data.suiteId } : {}),
      ...(body.data.capUsd !== undefined ? { capUsd: body.data.capUsd } : {}),
    };
    const jobId = await opts.queue.enqueue('suite:certify', payload);
    return reply.code(202).send({ jobId });
  });

  // ---- GET /api/certifications (viewer+) ----
  app.get('/api/certifications', async (req: FastifyRequest, reply) => {
    const org = req.potionOrg!;
    const rows = await listSuiteCertifications(db, org.orgId);
    return reply.send({
      certifications: rows.map((r) => {
        const evidence = (r.evidence ?? {}) as Record<string, unknown>;
        return {
          id: r.id,
          clusterId: r.clusterId,
          suiteId: r.suiteId,
          suiteVersion: r.suiteVersion,
          incumbentHash: r.incumbentHash,
          status: r.status,
          // Only 'certified' vouches for the suite — clients must render
          // everything else unmistakably as NOT CERTIFIED, and refusals
          // (evidence.refused) as NOT MEASURED.
          active: r.status === 'certified',
          refused: evidence.refused === true,
          statusReason: r.statusReason,
          selfRetentionMean:
            typeof evidence.selfRetentionMean === 'number' ? evidence.selfRetentionMean : null,
          floor: typeof evidence.floor === 'number' ? evidence.floor : null,
          items: typeof evidence.items === 'number' ? evidence.items : null,
          providerMode: r.providerMode,
          spendUsd: r.spendUsd,
          createdAt: r.createdAt,
          reviewedAt: r.reviewedAt,
        };
      }),
    });
  });
}
