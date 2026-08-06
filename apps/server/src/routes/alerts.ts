// Alert rule routes (M4, ROADMAP #33, SPEC §13.5).
//
//   GET    /api/alerts           viewer+ — the org's rules, target MASKED
//   POST   /api/alerts           admin   — create {kind, targetUrl, events[]}
//   DELETE /api/alerts/:id       admin   — remove (org-scoped, uniform 404)
//   POST   /api/alerts/test      admin   — fire a test payload at a caller-
//                                supplied URL (single attempt; reports
//                                status/latency; query strings redacted in
//                                errors, never logged raw)
//
// Masking discipline: target_url may embed a secret (Slack path tokens,
// webhook query keys). It is write-only over the API — POST accepts it,
// GET never returns it: `targetMasked` keeps only scheme+host so operators
// can tell rules apart (same philosophy as share-token hash prefixes and
// alert_deliveries never copying target_url).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ALERT_EVENTS,
  ALERT_RULE_KINDS,
  deleteAlertRule,
  insertAlertRule,
  listAlertRules,
  redactUrl,
  type AlertEvent,
  type AlertRuleKind,
  type AlertRuleRow,
} from '@potion/db';
import { alertRequestBody, ALERT_DISPATCH_TIMEOUT_MS } from '@potion/workers';
import { openAiError, roleAtLeast } from '../auth.js';
import type { PotionContext } from '../context.js';

/** scheme://host/••• — never the path (Slack secrets live there). */
export function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/•••`;
  } catch {
    return '•••';
  }
}

function ruleDto(row: AlertRuleRow) {
  return {
    id: row.id,
    kind: row.kind,
    targetMasked: maskUrl(row.targetUrl),
    events: row.events,
    createdAt: row.createdAt.toISOString(),
    disabledAt: row.disabledAt?.toISOString() ?? null,
  };
}

const CreateRuleSchema = z
  .object({
    kind: z.enum(ALERT_RULE_KINDS as [AlertRuleKind, ...AlertRuleKind[]]),
    targetUrl: z
      .string()
      .min(8)
      .max(2048)
      .refine((v) => {
        try {
          const u = new URL(v);
          return u.protocol === 'https:' || u.protocol === 'http:';
        } catch {
          return false;
        }
      }, 'targetUrl must be an http(s) URL'),
    events: z
      .array(z.enum(ALERT_EVENTS as [AlertEvent, ...AlertEvent[]]))
      .min(1)
      .max(ALERT_EVENTS.length),
  })
  .strict();

const TestRuleSchema = z
  .object({
    url: z.string().min(8).max(2048),
    kind: z.enum(ALERT_RULE_KINDS as [AlertRuleKind, ...AlertRuleKind[]]).optional(),
  })
  .strict();

export function registerAlertRoutes(app: FastifyInstance, ctx: PotionContext): void {
  app.get('/api/alerts', async (req, reply) => {
    const org = req.potionOrg;
    if (!org) {
      return reply
        .code(401)
        .send(openAiError('authentication required', 'invalid_request_error', 'authentication_required'));
    }
    const rows = await listAlertRules(ctx.db.db, org.orgId);
    return reply.send({ rules: rows.map(ruleDto) });
  });

  app.post('/api/alerts', async (req, reply) => {
    const org = req.potionOrg;
    if (!org) {
      return reply
        .code(401)
        .send(openAiError('authentication required', 'invalid_request_error', 'authentication_required'));
    }
    if (!roleAtLeast(org.role, 'admin')) {
      return reply
        .code(403)
        .send(
          openAiError(
            `role '${org.role}' may not create alert rules — requires 'admin'`,
            'invalid_request_error',
            'insufficient_role',
          ),
        );
    }
    const parsed = CreateRuleSchema.safeParse(req.body);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return reply.code(400).send(openAiError(message, 'invalid_request_error'));
    }
    const row = await insertAlertRule(ctx.db.db, {
      orgId: org.orgId,
      kind: parsed.data.kind,
      targetUrl: parsed.data.targetUrl,
      events: parsed.data.events,
    });
    return reply.code(201).send({ rule: ruleDto(row) });
  });

  app.delete('/api/alerts/:id', async (req, reply) => {
    const org = req.potionOrg;
    if (!org) {
      return reply
        .code(401)
        .send(openAiError('authentication required', 'invalid_request_error', 'authentication_required'));
    }
    if (!roleAtLeast(org.role, 'admin')) {
      return reply
        .code(403)
        .send(
          openAiError(
            `role '${org.role}' may not delete alert rules — requires 'admin'`,
            'invalid_request_error',
            'insufficient_role',
          ),
        );
    }
    const { id } = req.params as { id: string };
    const deleted = await deleteAlertRule(ctx.db.db, org.orgId, id);
    if (!deleted) {
      // Unknown id FOR THIS ORG (uniform 404 — no existence oracle).
      return reply
        .code(404)
        .send(openAiError('alert rule not found', 'invalid_request_error', 'not_found'));
    }
    return reply.send({ deleted: true, id });
  });

  // POST /api/alerts/test — one delivery attempt against a caller-supplied
  // URL, using the SAME request body the dispatcher sends (shape parity:
  // webhook JSON / slack {text}).
  app.post('/api/alerts/test', async (req, reply) => {
    const org = req.potionOrg;
    if (!org) {
      return reply
        .code(401)
        .send(openAiError('authentication required', 'invalid_request_error', 'authentication_required'));
    }
    if (!roleAtLeast(org.role, 'admin')) {
      return reply
        .code(403)
        .send(
          openAiError(
            `role '${org.role}' may not test alert deliveries — requires 'admin'`,
            'invalid_request_error',
            'insufficient_role',
          ),
        );
    }
    const parsed = TestRuleSchema.safeParse(req.body);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return reply.code(400).send(openAiError(message, 'invalid_request_error'));
    }
    const kind = parsed.data.kind ?? 'webhook';
    const ts = new Date().toISOString();
    const body = alertRequestBody(
      kind,
      {
        orgId: org.orgId,
        event: 'budget_warning', // representative shape; the detail says test
        detail: { message: 'Potion test alert — your integration is wired correctly' },
      },
      ts,
    );
    const t0 = performance.now();
    try {
      const res = await fetch(parsed.data.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(ALERT_DISPATCH_TIMEOUT_MS),
      });
      return reply.send({
        delivered: res.ok,
        status: res.status,
        latencyMs: Math.round((performance.now() - t0) * 100) / 100,
        targetMasked: maskUrl(parsed.data.url),
      });
    } catch (err) {
      return reply.send({
        delivered: false,
        status: null,
        latencyMs: Math.round((performance.now() - t0) * 100) / 100,
        targetMasked: maskUrl(parsed.data.url),
        // Redact any URL echo inside the transport error (query secrets).
        error: redactUrl((err as Error).message),
      });
    }
  });
}
