// G1 Outcome API (SPEC §16, migration 0083, review critical path
// "outcomes → customer evidence → …").
//
//   POST /v1/outcomes   api-key — report what ACTUALLY happened after a
//                       served response, keyed by the chat completion id
//                       every response already carries. The application is
//                       the measurement instrument: validator results,
//                       human accept/edit/reject, fixed labels, scores.
//
// Contracts:
//   · STRICT body — unknown fields 400, never silently stripped. A brand-
//     new surface must not inherit the Chat Completions subset's silent-
//     strip behavior (external review §27): a customer sending a signal we
//     do not understand must hear that, not lose it.
//   · Attribution AT INGEST: the served request is looked up by
//     (org, completion_id, status='ok') and its cluster/strategy/
//     router_version are copied onto the outcome row — evidence reads never
//     join, and attribution survives log retention. An unknown request_id
//     is a 404 (an outcome must attach to a request Potion actually
//     served — org-scoped, so one org can never annotate another's
//     traffic).
//   · At least one signal is required — an empty outcome is not evidence.
//   · Append-only: a request may accumulate several signal rows over time
//     (validator now, human later). The aggregation
//     (@potion/pareto outcome-evidence) takes the LATEST signal of each
//     kind per request, so a correction is one more POST, never an edit.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { insertOutcome, servedRequestRouting } from '@potion/db';
import { authenticate, bearerToken, openAiError } from '../auth.js';
import type { PotionContext } from '../context.js';

export const OUTCOME_HUMAN_SIGNALS = ['accepted', 'edited', 'rejected', 'regenerated'] as const;

const OutcomeBody = z
  .object({
    request_id: z.string().min(1).max(200),
    success: z.boolean().optional(),
    /** Customer-defined score, bounded to [0,1] so the evidence scale is
     * honest by construction. */
    score: z.number().min(0).max(1).optional(),
    validator: z.string().min(1).max(200).optional(),
    label: z.string().min(1).max(2000).optional(),
    human: z.enum(OUTCOME_HUMAN_SIGNALS).optional(),
    failure_reason: z.string().min(1).max(2000).optional(),
  })
  .strict()
  .refine(
    (b) =>
      b.success !== undefined ||
      b.score !== undefined ||
      b.label !== undefined ||
      b.human !== undefined ||
      b.failure_reason !== undefined,
    { message: 'at least one signal is required (success, score, label, human, failure_reason)' },
  );

export function registerOutcomeRoutes(app: FastifyInstance, ctx: PotionContext): void {
  const db = ctx.db.db;

  app.post('/v1/outcomes', async (req: FastifyRequest, reply) => {
    const auth = await authenticate(db, bearerToken(req.headers.authorization));
    if (!auth) {
      return reply
        .code(401)
        .send(openAiError('missing or invalid api key', 'invalid_request_error', 'invalid_api_key'));
    }
    const parsed = OutcomeBody.safeParse(req.body);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return reply.code(400).send(openAiError(message, 'invalid_request_error', 'invalid_outcome'));
    }
    const b = parsed.data;
    const routing = await servedRequestRouting(db, auth.org.orgId, b.request_id);
    if (routing === null) {
      return reply
        .code(404)
        .send(
          openAiError(
            `no served request '${b.request_id}' for this org — outcomes attach to requests Potion served`,
            'invalid_request_error',
            'unknown_request',
          ),
        );
    }
    const id = await insertOutcome(db, {
      orgId: auth.org.orgId,
      requestId: b.request_id,
      clusterId: routing.clusterId,
      strategyHash: routing.strategyHash,
      routerVersion: routing.routerVersion,
      success: b.success ?? null,
      score: b.score ?? null,
      validator: b.validator ?? null,
      label: b.label ?? null,
      human: b.human ?? null,
      failureReason: b.failure_reason ?? null,
    });
    return reply.code(201).send({
      id,
      request_id: b.request_id,
      attached: {
        cluster: routing.clusterId,
        strategy: routing.strategyHash === null ? null : routing.strategyHash.slice(0, 8),
        router_version: routing.routerVersion,
      },
    });
  });
}
