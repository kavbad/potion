// G1 holdout settings (0086).
//
//   GET /api/holdout  viewer — state + eligibility (and WHY not, in words)
//   PUT /api/holdout  admin  — consent + rate (capped at HOLDOUT_MAX_RATE)
//
// Consent is EXPLICIT and reversible; the rate is bounded so "a small
// slice" stays true by construction; enabling without a servable priced
// incumbent is a 409 (a holdout with no baseline model is theater). Writes
// bust the serving-path config cache so the toggle binds within the minute.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getOrgIncumbents, setHoldoutConfig } from '@potion/db';
import { openAiError, requireRole } from '../auth.js';
import { HOLDOUT_MAX_RATE, bustHoldoutCache, eligibleIncumbent } from '../routing/holdout.js';
import type { PotionContext } from '../context.js';

const Body = z
  .object({
    enabled: z.boolean(),
    rate: z.number().min(0.005).max(HOLDOUT_MAX_RATE).optional(),
  })
  .strict();

export function registerHoldoutRoutes(app: FastifyInstance, ctx: PotionContext): void {
  const db = ctx.db.db;

  app.get('/api/holdout', async (req, reply) => {
    const orgId = req.potionOrg!.orgId;
    const inc = await getOrgIncumbents(db, orgId);
    const eligible = inc === null ? { model: null as string | null, why: 'no incumbent designated' } : eligibleIncumbent(inc.models, ctx.prices, ctx.providerMode);
    return reply.send({
      enabled: inc?.holdoutConsent ?? false,
      rate: inc?.holdoutRate ?? 0.02,
      maxRate: HOLDOUT_MAX_RATE,
      incumbentModel: eligible.model,
      eligible: eligible.model !== null,
      ...(eligible.model === null ? { why: (eligible as { why: string }).why } : {}),
    });
  });

  app.put('/api/holdout', { preHandler: [requireRole('admin')] }, async (req, reply) => {
    const orgId = req.potionOrg!.orgId;
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      const message = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      return reply.code(400).send(openAiError(message, 'invalid_request_error'));
    }
    const inc = await getOrgIncumbents(db, orgId);
    if (parsed.data.enabled) {
      const eligible = inc === null ? { model: null as string | null } : eligibleIncumbent(inc.models, ctx.prices, ctx.providerMode);
      if (eligible.model === null) {
        return reply
          .code(409)
          .send(openAiError('holdout needs a designated incumbent that resolves to a servable priced model', 'invalid_request_error', 'no_incumbent'));
      }
    }
    const rate = parsed.data.rate ?? inc?.holdoutRate ?? 0.02;
    const ok = await setHoldoutConfig(db, orgId, { consent: parsed.data.enabled, rate });
    if (!ok) {
      return reply.code(409).send(openAiError('designate an incumbent before configuring the holdout', 'invalid_request_error', 'no_incumbent'));
    }
    bustHoldoutCache(orgId);
    return reply.send({ enabled: parsed.data.enabled, rate });
  });
}
