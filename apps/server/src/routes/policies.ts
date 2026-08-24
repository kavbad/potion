// GET/POST /v1/policies (SPEC §8) — per-key policy management.
//
// A policy is stored PER API KEY: every POST inserts a fresh policies row
// (validated against the core PolicySchema) and binds it to the
// authenticated key (api_keys.policy_id → policies.id). Keys never share
// policy rows, so one customer's re-bind can never affect another key.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PolicySchema } from '@potion/core';
import { insertPolicy, updateApiKeyPolicy, listPolicies } from '@potion/db';
import { authenticate, bearerToken, openAiError } from '../auth.js';
import type { PotionContext } from '../context.js';

/** Body: Policy fields + optional display name. Unknown fields stripped. */
const PostPolicyBodySchema = z
  .object({ name: z.string().min(1).max(200).optional() })
  .passthrough();

async function requireAuth(ctx: PotionContext, authorization: string | undefined) {
  return authenticate(ctx.db.db, bearerToken(authorization));
}

export function registerPolicyRoutes(app: FastifyInstance, ctx: PotionContext): void {
  /** Current policy bound to the authenticated key. */
  app.get('/v1/policies', async (req, reply) => {
    const auth = await requireAuth(ctx, req.headers.authorization);
    if (!auth) {
      return reply
        .code(401)
        .send(openAiError('missing or invalid api key', 'invalid_request_error', 'invalid_api_key'));
    }
    // Beta feedback (2026-08-24): policy DISCOVERY — the org's policies with
    // names and ids, and which one this key is bound to, so a client can
    // populate a selector from real data instead of guessing identifiers.
    const all = (await listPolicies(ctx.db.db, auth.org.orgId)).map((pl) => ({
      id: pl.id,
      name: pl.name,
      config: pl.config,
      bound: pl.id === auth.policyId,
    }));
    return reply.send({
      policy: auth.policy && auth.policyId ? { id: auth.policyId, config: auth.policy, bound: true } : null,
      policies: all,
    });
  });

  /** Create + bind a policy for the authenticated key.
   * G2.3 DELIBERATE: this stays reachable by a plain 'serve' key — it
   * rebinds the CALLING key's OWN policy (a self-scoped serving-onboarding
   * mutation), never another key's. Admin mutations on other keys live on
   * the /api surface behind the admin scope. */
  app.post('/v1/policies', async (req, reply) => {
    const auth = await requireAuth(ctx, req.headers.authorization);
    if (!auth) {
      return reply
        .code(401)
        .send(openAiError('missing or invalid api key', 'invalid_request_error', 'invalid_api_key'));
    }
    const bodyParsed = PostPolicyBodySchema.safeParse(req.body ?? {});
    if (!bodyParsed.success) {
      return reply.code(400).send(openAiError(bodyParsed.error.message, 'invalid_request_error'));
    }
    const { name, ...policyFields } = bodyParsed.data;
    const policyParsed = PolicySchema.safeParse(policyFields);
    if (!policyParsed.success) {
      const message = policyParsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return reply.code(400).send(openAiError(message, 'invalid_request_error'));
    }
    const policy = policyParsed.data;
    const id = `pol-${randomUUID().slice(0, 8)}`;
    const policyName = name ?? `${policy.type}-${id.slice(4)}`;
    // Tenant scope (M2 #13): the new policy row lives in the caller's org and
    // the re-bind is org-scoped — one org's keys/policies never cross.
    await insertPolicy(ctx.db.db, { id, orgId: auth.org.orgId, name: policyName, config: policy });
    await updateApiKeyPolicy(ctx.db.db, auth.org.orgId, auth.key.id, id);
    return reply.code(201).send({ policy: { id, name: policyName, config: policy } });
  });
}
