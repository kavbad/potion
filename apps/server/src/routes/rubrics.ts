// Rubric review routes (G1.5, SPEC §14).
//
//   POST /api/rubrics/generate     admin — enqueue rubric:generate for ONE of
//                                  the caller's clusters (capped, metered;
//                                  cross-org cluster ids 404 — no existence
//                                  oracle).
//   GET  /api/rubrics              viewer+ — org-scoped list. OWNER RULE:
//                                  customers see EVERYTHING derived from
//                                  their data, always paired with status +
//                                  evidence. Every row carries the full
//                                  rubric text, its lifecycle status (only
//                                  'approved' is IN FORCE), status_reason,
//                                  and the probe-calibration verdict (or the
//                                  uncalibrated reason). Rejected rubrics
//                                  stay listed with WHY — never hidden.
//   POST /api/rubrics/:id/approve  admin — approve a PENDING rubric: demotes
//                                  the cluster's prior approved rubric to
//                                  'superseded' and restamps the suite's
//                                  items (transactional).
//   POST /api/rubrics/:id/reject   admin — reject a PENDING rubric with a
//                                  required reason (recorded, displayed).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  approveClusterRubric,
  getClusterRubric,
  getClusterByIdForOrg,
  listClusterRubrics,
  rejectClusterRubric,
} from '@potion/db';
import type { PotionQueue } from '@potion/queue';
import type { RubricGeneratePayload } from '@potion/workers';
import { openAiError, roleAtLeast } from '../auth.js';
import type { PotionContext } from '../context.js';

export interface RubricRoutesOptions {
  queue: PotionQueue;
}

function forbidden(role: string, action: string) {
  return openAiError(
    `role '${role}' may not ${action} — requires 'admin'`,
    'invalid_request_error',
    'insufficient_role',
  );
}

const notFound = openAiError('rubric not found', 'invalid_request_error', 'rubric_not_found');

export function registerRubricRoutes(
  app: FastifyInstance,
  ctx: PotionContext,
  opts: RubricRoutesOptions,
): void {
  const db = ctx.db.db;

  // ---- POST /api/rubrics/generate (admin) ----
  app.post('/api/rubrics/generate', async (req: FastifyRequest, reply) => {
    const org = req.potionOrg!;
    if (!roleAtLeast(org.role, 'admin')) {
      return reply.code(403).send(forbidden(org.role, 'generate rubrics'));
    }
    const body = z
      .object({
        clusterId: z.string().min(1),
        capUsd: z.number().positive().max(50).optional(),
        seed: z.number().int().optional(),
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
    const payload: RubricGeneratePayload = {
      orgId: org.orgId,
      clusterId: body.data.clusterId,
      ...(body.data.capUsd !== undefined ? { capUsd: body.data.capUsd } : {}),
      ...(body.data.seed !== undefined ? { seed: body.data.seed } : {}),
    };
    const jobId = await opts.queue.enqueue('rubric:generate', payload);
    return reply.code(202).send({ jobId });
  });

  // ---- GET /api/rubrics (viewer+) ----
  app.get('/api/rubrics', async (req: FastifyRequest, reply) => {
    const org = req.potionOrg!;
    const rows = await listClusterRubrics(db, org.orgId);
    return reply.send({
      rubrics: rows.map(({ rubric, calibration }) => ({
        id: rubric.id,
        clusterId: rubric.clusterId,
        suiteId: rubric.suiteId,
        rubricText: rubric.rubricText,
        rubricHash: rubric.rubricHash,
        status: rubric.status,
        // Only 'approved' is the operative contract — clients must render
        // everything else unmistakably as NOT IN FORCE.
        inForce: rubric.status === 'approved',
        statusReason: rubric.statusReason,
        reviewedAt: rubric.reviewedAt,
        generatorModel: rubric.generatorModel,
        providerMode: rubric.providerMode,
        exemplarCount: rubric.exemplarCount,
        spendUsd: rubric.spendUsd,
        createdAt: rubric.createdAt,
        calibration:
          calibration === null
            ? null
            : {
                pearsonVsTruth: calibration.pearsonVsTruth,
                spearmanVsTruth: calibration.spearmanVsTruth,
                meanAbsErr: calibration.meanAbsErr,
                flagged: calibration.flagged,
                n: calibration.n,
                providerMode: calibration.providerMode,
              },
      })),
    });
  });

  // ---- POST /api/rubrics/:id/approve | /reject (admin) ----
  const loadOwnPending = async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f-]{36}$/.test(id)) return { error: 404 as const };
    const rubric = await getClusterRubric(db, id);
    // Cross-org and nonexistent are the same 404 (no oracle).
    if (!rubric || rubric.orgId !== req.potionOrg!.orgId) return { error: 404 as const };
    if (rubric.status !== 'pending') return { error: 409 as const, status: rubric.status };
    return { rubric };
  };

  app.post('/api/rubrics/:id/approve', async (req: FastifyRequest, reply) => {
    const org = req.potionOrg!;
    if (!roleAtLeast(org.role, 'admin')) {
      return reply.code(403).send(forbidden(org.role, 'approve rubrics'));
    }
    const loaded = await loadOwnPending(req);
    if ('error' in loaded) {
      if (loaded.error === 404) return reply.code(404).send(notFound);
      return reply
        .code(409)
        .send(
          openAiError(
            `rubric is '${loaded.status}' — only pending rubrics can be approved`,
            'invalid_request_error',
            'rubric_not_pending',
          ),
        );
    }
    const restampedItems = await approveClusterRubric(db, loaded.rubric.id);
    return reply.send({ id: loaded.rubric.id, status: 'approved', restampedItems });
  });

  app.post('/api/rubrics/:id/reject', async (req: FastifyRequest, reply) => {
    const org = req.potionOrg!;
    if (!roleAtLeast(org.role, 'admin')) {
      return reply.code(403).send(forbidden(org.role, 'reject rubrics'));
    }
    const body = z.object({ reason: z.string().min(3).max(500) }).safeParse(req.body ?? {});
    if (!body.success) {
      return reply.code(400).send({
        error: 'invalid_body',
        message: 'a reason is required — rejected rubrics stay visible WITH their reason',
      });
    }
    const loaded = await loadOwnPending(req);
    if ('error' in loaded) {
      if (loaded.error === 404) return reply.code(404).send(notFound);
      return reply
        .code(409)
        .send(
          openAiError(
            `rubric is '${loaded.status}' — only pending rubrics can be rejected`,
            'invalid_request_error',
            'rubric_not_pending',
          ),
        );
    }
    await rejectClusterRubric(db, loaded.rubric.id, body.data.reason);
    return reply.send({ id: loaded.rubric.id, status: 'rejected', statusReason: body.data.reason });
  });
}
