// Operator routes (G2.7) — platform-operator surface, NOT tenant-facing.
//
//   POST   /operator/orgs        create an org + admin user/membership; the
//                                magic link is returned UNCONDITIONALLY in
//                                the 201 (hand-delivery is the documented
//                                partner flow — SMTP deliberately absent).
//   GET    /operator/orgs        list orgs with headline counts.
//   DELETE /operator/orgs/:id    TRUE-CASCADE deletion (the owner carve-out:
//                                evidence rows and tombstones included) via
//                                the org:delete job → 202 {jobId}. Refuses
//                                org_demo. Idempotent at the job layer.
//   GET    /operator/jobs/:id    job-status mirror — the operator has no
//                                OrgContext for the org-checked /api/jobs.
//
// AUTH: POTION_OPERATOR_TOKEN bearer, compared with timingSafeEqual. FAIL
// CLOSED: when the env var is unset, every operator call 401s — the exact
// opposite polarity of the dev bypass (which fails open outside
// production); a deployment without the token has NO operator surface.
// Paths live under /operator/* — the /api/* auth hook never sees them.
import { ensureDefaultAlertRule } from '../default-alert-rule.js';
import { timingSafeEqual } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import {
  createMembership,
  createOrg,
  createUser,
  getOrgById,
  getUserByEmail,
  listOrgs,
  DEFAULT_ORG_ID,
} from '@potion/db';
import type { PotionQueue } from '@potion/queue';
import { bearerToken, openAiError } from '../auth.js';
import type { PotionContext } from '../context.js';
import { issueMagicLink, soloOrgName } from './auth.js';
import { sendEmailFromEnv } from '../email.js';

export interface OperatorRoutesOptions {
  queue: PotionQueue;
}

/** Fail-closed operator check: unset token env → every call 401s. */
export function isOperator(req: FastifyRequest): boolean {
  const configured = process.env.POTION_OPERATOR_TOKEN;
  if (configured === undefined || configured === '') return false;
  const presented = bearerToken(req.headers.authorization);
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(configured);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const unauthorized = openAiError(
  'operator credential required (POTION_OPERATOR_TOKEN; unset means no operator surface)',
  'invalid_request_error',
  'operator_unauthorized',
);

export function registerOperatorRoutes(
  app: FastifyInstance,
  ctx: PotionContext,
  opts: OperatorRoutesOptions,
): void {
  const db = ctx.db.db;

  // ---- POST /operator/orgs ----
  app.post('/operator/orgs', async (req, reply) => {
    if (!isOperator(req)) return reply.code(401).send(unauthorized);
    const body = z
      .object({
        id: z
          .string()
          .regex(/^org[-_][a-z0-9-]{2,40}$/)
          .optional(),
        name: z.string().min(1).max(120),
        adminEmail: z.string().email(),
      })
      .safeParse(req.body ?? {});
    if (!body.success) {
      return reply.code(400).send({
        error: 'invalid_body',
        message: body.error.issues.map((i) => i.message).join('; '),
      });
    }
    const orgId = body.data.id ?? `org-${randomUUID().slice(0, 8)}`;
    if ((await getOrgById(db, orgId)) !== null) {
      return reply
        .code(409)
        .send(openAiError(`org '${orgId}' already exists`, 'invalid_request_error', 'org_exists'));
    }
    const email = body.data.adminEmail.trim().toLowerCase();
    await createOrg(db, { id: orgId, name: body.data.name });
    // Operator-provisioned orgs hear about their first problem too (2026-09-16).
    await ensureDefaultAlertRule(db, orgId, email).catch(() => undefined);
    const existing = await getUserByEmail(db, email);
    let userId: string;
    if (existing) {
      userId = existing.id;
    } else {
      userId = `usr-${randomUUID().slice(0, 8)}`;
      await createUser(db, { id: userId, email, name: email.split('@')[0] ?? soloOrgName(email) });
    }
    await createMembership(db, { orgId, userId, role: 'admin' });
    // The link must land on the DASHBOARD, whose /api/auth/verify sets the
    // session cookie on the host the partner actually uses. Built from the
    // raw request it pointed at the API host over plain http (caught in the
    // Phase D rehearsal, 2026-08-21). POTION_APP_URL is the deployed
    // dashboard origin; without it (local dev) fall back to this host.
    const appUrl = process.env.POTION_APP_URL?.replace(/\/$/, '');
    const proto = req.protocol || 'http';
    const host = req.headers.host ?? 'localhost:3000';
    const linkBase = appUrl ? `${appUrl}/api` : `${proto}://${host}`;
    // The magic link is returned UNCONDITIONALLY — operator hand-delivery
    // is the partner flow; the email side effect is best-effort logging.
    // Delivered by the configured transport when one exists (Resend); the
    // link is STILL returned for hand-delivery — the partner flow never
    // depends on email arriving.
    const magicLink = await issueMagicLink(db, email, orgId, linkBase, sendEmailFromEnv().sendEmail);
    return reply.code(201).send({ orgId, name: body.data.name, adminEmail: email, magicLink });
  });

  // ---- GET /operator/orgs ----
  app.get('/operator/orgs', async (req, reply) => {
    if (!isOperator(req)) return reply.code(401).send(unauthorized);
    const orgs = await listOrgs(db);
    const out = [];
    for (const org of orgs) {
      const counts = await db.execute(sql`
        SELECT
          (SELECT count(*)::int FROM memberships WHERE org_id = ${org.id}) AS members,
          (SELECT count(*)::int FROM api_keys WHERE org_id = ${org.id}) AS api_keys,
          (SELECT count(*)::int FROM request_logs WHERE org_id = ${org.id}) AS request_logs
      `);
      const c = counts.rows[0] as { members: number; api_keys: number; request_logs: number };
      out.push({
        id: org.id,
        name: org.name,
        createdAt: org.createdAt,
        members: Number(c.members),
        apiKeys: Number(c.api_keys),
        requestLogs: Number(c.request_logs),
      });
    }
    return reply.send({ orgs: out });
  });

  // ---- DELETE /operator/orgs/:id ----
  app.delete('/operator/orgs/:id', async (req, reply) => {
    if (!isOperator(req)) return reply.code(401).send(unauthorized);
    const { id } = req.params as { id: string };
    if (id === DEFAULT_ORG_ID) {
      return reply
        .code(409)
        .send(
          openAiError(
            `'${DEFAULT_ORG_ID}' cannot be deleted — it holds platform-wide unauthenticated ` +
              'request logs and is re-seeded at every boot',
            'invalid_request_error',
            'org_undeletable',
          ),
        );
    }
    if ((await getOrgById(db, id)) === null) {
      return reply
        .code(404)
        .send(openAiError(`org '${id}' not found`, 'invalid_request_error', 'org_not_found'));
    }
    const jobId = await opts.queue.enqueue('org:delete', { orgId: id });
    return reply.code(202).send({ jobId });
  });

  // ---- POST /operator/frontiers/platform-sweep (Lab Step 5) ----
  // Enqueues one PLATFORM-scope live sweep leg for a taxonomy cluster.
  // capUsd is REQUIRED end-to-end (the handler refuses without it); the
  // route ceiling matches the operator-approved Step 5 envelope. Platform
  // jobs carry no orgId, so /api/jobs/:id 404s on them by design — status
  // reads go through the operator mirror below.
  app.post('/operator/frontiers/platform-sweep', async (req, reply) => {
    if (!isOperator(req)) return reply.code(401).send(unauthorized);
    const Body = z.object({
      clusterId: z.string().min(1),
      capUsd: z.number().positive().max(60),
      sampleN: z.number().int().positive().max(500).optional(),
      judgeMaxTokens: z.number().int().positive().max(4096).optional(),
      maxOutputTokens: z.number().int().positive().max(8192).optional(),
      // THE WIDTH KNOBS (2026-09-17). The handler refuses a pool wider than
      // its ceiling unless maxAnswerers is passed explicitly — and this
      // route silently dropped it (zod strips unknown keys), so every sweep
      // started here with a 389-model registry was refused with
      // 'pool-exceeds-ceiling'. Prior sweeps named their models in scripts;
      // the route now takes the same acknowledgement and the same list.
      maxAnswerers: z.number().int().positive().max(500).optional(),
      auditionModels: z.array(z.string().min(1)).min(1).max(60).optional(),
      cellConcurrency: z.number().int().positive().max(16).optional(),
      publish: z.boolean().optional(),
      instrument: z.enum(['default', 'tools', 'vision', 'audio']).optional(),
    });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(openAiError(parsed.error.message, 'invalid_request_error', 'invalid_body'));
    }
    const jobId = await opts.queue.enqueue('frontier:platform-sweep', parsed.data);
    return reply.code(202).send({ jobId });
  });

  // ---- GET /operator/jobs/:id (mirror — no org check) ----
  app.get('/operator/jobs/:id', async (req, reply) => {
    if (!isOperator(req)) return reply.code(401).send(unauthorized);
    const { id } = req.params as { id: string };
    const status = await opts.queue.getJob(id);
    if (!status) {
      return reply
        .code(404)
        .send(openAiError(`job '${id}' not found`, 'invalid_request_error', 'job_not_found'));
    }
    return reply.send({
      id,
      name: status.name,
      state: status.state,
      ...(status.result !== undefined ? { result: status.result } : {}),
      ...(status.error !== undefined ? { error: status.error } : {}),
    });
  });
}
