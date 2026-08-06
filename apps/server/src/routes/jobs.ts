// Jobs routes (M3 #28, SPEC §12.2): enqueue eval jobs + poll job status.
//
//   POST /api/evals      member+ (dashboard hook). Enqueue an eval:run job
//                        onto the server's PotionQueue → 202 { jobId }.
//                        Strategies may be given inline (`strategies`) — they
//                        are content-hashed into strategy_configs and the job
//                        carries the hashes (the §12.2 payload form) — or by
//                        reference (`strategyHashes`).
//   GET  /api/jobs/:id   viewer+. { state, progress, result?, error? } from
//                        the driver. 404 for unknown ids AND for jobs owned
//                        by a different org (existence is not leaked).
//
// Org scoping: every enqueued job carries the resolved orgId (dashboard auth
// hook #14) in its payload; GET refuses cross-org reads.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { StrategyConfigSchema, strategyHash, type StrategyConfig } from '@potion/core';
import { strategyConfigs } from '@potion/db';
import type { PotionQueue } from '@potion/queue';
import type { EvalRunPayload } from '@potion/workers';
import type { PotionContext } from '../context.js';

const EnqueueEvalBody = z
  .object({
    suiteIds: z.array(z.string().min(1)).min(1),
    strategyHashes: z.array(z.string().min(1)).optional(),
    strategies: z.array(StrategyConfigSchema).optional(),
    capUsd: z.number().positive().optional(),
  })
  .refine((b) => (b.strategyHashes?.length ?? 0) > 0 || (b.strategies?.length ?? 0) > 0, {
    message: 'provide strategyHashes and/or strategies',
  });

export interface JobRoutesOptions {
  queue: PotionQueue;
}

export function registerJobRoutes(
  app: FastifyInstance,
  ctx: PotionContext,
  opts: JobRoutesOptions,
): void {
  app.post('/api/evals', async (req: FastifyRequest, reply) => {
    const parsed = EnqueueEvalBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_body',
        message: parsed.error.issues.map((i) => i.message).join('; '),
      });
    }
    const orgId = req.potionOrg!.orgId; // resolved by the dashboard auth hook
    const body = parsed.data;

    // Inline strategies: register content-addressed configs (idempotent),
    // then reference them by hash — the canonical §12.2 payload form.
    const hashes = [...(body.strategyHashes ?? [])];
    if (body.strategies) {
      for (const raw of body.strategies) {
        // Zod's output type widens optional fields to `| undefined`; the
        // validated shape is a StrategyConfig (schema is the zod twin).
        const config = raw as StrategyConfig;
        const hash = strategyHash(config);
        await ctx.db.db
          .insert(strategyConfigs)
          .values({ hash, config })
          .onConflictDoNothing();
        if (!hashes.includes(hash)) hashes.push(hash);
      }
    }

    const payload: EvalRunPayload = {
      suiteIds: body.suiteIds,
      strategyHashes: hashes,
      ...(body.capUsd !== undefined ? { capUsd: body.capUsd } : {}),
      orgId,
    };
    const jobId = await opts.queue.enqueue('eval:run', payload);
    return reply.code(202).send({ jobId });
  });

  app.get('/api/jobs/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const status = await opts.queue.getJob(req.params.id);
    if (!status) {
      return reply.code(404).send({ error: 'job_not_found' });
    }
    // Org scope: jobs carrying an orgId are only readable by that org.
    const payloadOrg = (status.payload as { orgId?: unknown } | null)?.orgId;
    if (typeof payloadOrg === 'string' && payloadOrg !== req.potionOrg!.orgId) {
      return reply.code(404).send({ error: 'job_not_found' });
    }
    return reply.send({
      id: status.id,
      name: status.name,
      state: status.state,
      progress: status.progress,
      ...(status.result !== undefined ? { result: status.result } : {}),
      ...(status.error !== undefined ? { error: status.error } : {}),
    });
  });
}
