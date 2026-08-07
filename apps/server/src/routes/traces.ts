// Trace routes (M5, ROADMAP #36, SPEC §14.1/§14.3).
//
//   POST /v1/traces                api-key — batch span ingest (OTel GenAI
//                                  subset). Idempotent on (org, trace, span):
//                                  retries and overlapping uploads are safe.
//                                  cost_usd is priced AT INGEST from
//                                  prices.json (alias or model-id match).
//   GET  /api/traces?from&to       viewer+ — per-trace session rollup:
//                                  span count, total cost, models used, and
//                                  loop signals (≥3 identical tool-call
//                                  signatures).
//   GET  /api/traces/:traceId      viewer+ — the cost-attribution waterfall
//                                  (spans in order, per-span cost + attrs).
//   PUT  /api/traces/retention     admin — set trace_retention_days
//                                  (0 = metadata only; nightly purge enforces).
//   POST /api/traces/cluster       admin — enqueue traces:cluster, scoped to
//                                  the caller's org (agent clustering +
//                                  replay-suite synthesis + first frontier).
//   POST /api/traces/purge         admin — enforce retention NOW for the
//                                  caller's org (nightly job = global pass).
// Spans are ORG-SCOPED — payloads may contain customer data. The public
// surface (leaderboard/recipes) never reads them.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  redactAttrs, costUsd, roundCost } from '@potion/core';
import {
  detectLoopSignals,
  getOrgTraceRetentionDays,
  insertTraceSpans,
  listOrgTraceSpans,
  listSpansForTrace,
  setOrgTraceRetentionDays,
  type NewTraceSpan,
  type TraceSpanRow,
} from '@potion/db';
import type { PotionQueue } from '@potion/queue';
import type { TracesClusterPayload } from '@potion/workers';
import { authenticate, bearerToken, openAiError, roleAtLeast } from '../auth.js';
import type { PotionContext } from '../context.js';

export interface TracesRoutesOptions {
  queue: PotionQueue;
}

/** Batch cap per POST /v1/traces (payload hygiene, not a protocol limit). */
export const TRACES_BATCH_CAP = 500;

const SpanSchema = z.object({
  trace_id: z.string().min(1).max(200),
  span_id: z.string().min(1).max(200),
  parent_id: z.string().min(1).max(200).nullish(),
  name: z.string().min(1).max(500),
  model: z.string().min(1).max(300).optional(),
  input_tokens: z.number().int().min(0).optional(),
  output_tokens: z.number().int().min(0).optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  ts: z.string().datetime({ offset: true }).optional(),
});

const IngestBody = z.object({
  spans: z.array(SpanSchema).min(1).max(TRACES_BATCH_CAP),
});

const RetentionBody = z.object({
  days: z.number().int().min(0).max(3650),
});

function forbidden(role: string, action: string) {
  return openAiError(
    `role '${role}' may not ${action} — requires 'admin'`,
    'invalid_request_error',
    'insufficient_role',
  );
}

export function registerTraceRoutes(
  app: FastifyInstance,
  ctx: PotionContext,
  opts: TracesRoutesOptions,
): void {
  const db = ctx.db.db;

  // ---- POST /v1/traces (api-key; idempotent batch ingest) ----
  app.post('/v1/traces', async (req: FastifyRequest, reply) => {
    const auth = await authenticate(db, bearerToken(req.headers.authorization));
    if (!auth) {
      return reply
        .code(401)
        .send(openAiError('missing or invalid api key', 'invalid_request_error', 'invalid_api_key'));
    }
    const parsed = IngestBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send(
        openAiError(
          `invalid spans batch: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
          'invalid_request_error',
          'invalid_spans',
        ),
      );
    }
    // Price at ingest: alias match first, then provider model-id match.
    const byAlias = new Map(ctx.prices.entries.map((e) => [e.alias, e]));
    const byModel = new Map(ctx.prices.entries.map((e) => [e.model, e]));
    let batchCost = 0;
    const rows: NewTraceSpan[] = parsed.data.spans.map((s) => {
      const entry =
        s.model !== undefined ? (byAlias.get(s.model) ?? byModel.get(s.model)) : undefined;
      const input = s.input_tokens ?? 0;
      const output = s.output_tokens ?? 0;
      const cost =
        entry !== undefined
          ? roundCost(costUsd({ inputTokens: input, outputTokens: output }, entry))
          : 0;
      batchCost += cost;
      // G1.1: PII-redact user-supplied attributes AT INGEST — raw prompts are
      // never at rest. String leaves only (numbers/booleans/keys preserved);
      // the server-injected model key is added AFTER (allowlisted anyway —
      // model ids carry digit runs the generic rule would mangle).
      const attrs = redactAttrs({ ...(s.attributes ?? {}) });
      if (s.model !== undefined && attrs['gen_ai.request.model'] === undefined) {
        attrs['gen_ai.request.model'] = s.model;
      }
      return {
        orgId: auth.org.orgId,
        traceId: s.trace_id,
        spanId: s.span_id,
        ...(s.parent_id != null ? { parentId: s.parent_id } : {}),
        name: s.name,
        ...(s.model !== undefined ? { model: s.model } : {}),
        usage: { input_tokens: input, output_tokens: output },
        costUsd: cost,
        attrs,
        ...(s.ts !== undefined ? { ts: new Date(s.ts) } : {}),
      };
    });
    const { accepted, duplicates } = await insertTraceSpans(db, rows);
    return reply.code(202).send({ accepted, duplicates, costUsd: roundCost(batchCost) });
  });

  // ---- GET /api/traces?from&to&limit (viewer+) — session rollup ----
  app.get('/api/traces', async (req: FastifyRequest, reply) => {
    const org = req.potionOrg!;
    const query = z
      .object({
        from: z.string().datetime({ offset: true }).optional(),
        to: z.string().datetime({ offset: true }).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
      })
      .safeParse(req.query);
    if (!query.success) {
      return reply.code(400).send({
        error: 'invalid_query',
        message: query.error.issues.map((i) => i.message).join('; '),
      });
    }
    const spans = await listOrgTraceSpans(db, org.orgId, {
      ...(query.data.from !== undefined ? { from: new Date(query.data.from) } : {}),
      ...(query.data.to !== undefined ? { to: new Date(query.data.to) } : {}),
    });
    const byTrace = new Map<string, TraceSpanRow[]>();
    for (const s of spans) {
      const list = byTrace.get(s.traceId) ?? [];
      list.push(s);
      byTrace.set(s.traceId, list);
    }
    const sessions = [...byTrace.entries()]
      .map(([traceId, rows]) => {
        const sorted = [...rows].sort((a, b) => a.ts.getTime() - b.ts.getTime());
        const loops = detectLoopSignals(sorted);
        return {
          traceId,
          spanCount: rows.length,
          totalCostUsd: roundCost(rows.reduce((sum, s) => sum + s.costUsd, 0)),
          models: [...new Set(rows.map((s) => s.model).filter((m): m is string => m !== null))],
          startedAt: sorted[0]!.ts,
          endedAt: sorted[sorted.length - 1]!.ts,
          loops,
          looping: loops.length > 0,
          /** True when every payload column has been retention-redacted
           * (metadata only). */
          metadataOnly: rows.every(
            (s) => Object.keys(s.attrs as Record<string, unknown>).length === 0,
          ),
        };
      })
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, query.data.limit ?? 100);
    return reply.send({ orgId: org.orgId, sessions });
  });

  // ---- GET /api/traces/:traceId (viewer+) — cost waterfall ----
  app.get('/api/traces/:traceId', async (req: FastifyRequest, reply) => {
    const org = req.potionOrg!;
    const { traceId } = req.params as { traceId: string };
    const spans = await listSpansForTrace(db, org.orgId, traceId);
    if (spans.length === 0) {
      return reply.code(404).send({
        error: 'not_found',
        message: `no trace '${traceId}' in your org`,
      });
    }
    return reply.send({
      traceId,
      orgId: org.orgId,
      totalCostUsd: roundCost(spans.reduce((sum, s) => sum + s.costUsd, 0)),
      spans: spans.map((s) => ({
        spanId: s.spanId,
        parentId: s.parentId,
        name: s.name,
        model: s.model,
        usage: s.usage,
        costUsd: s.costUsd,
        ts: s.ts,
        attrs: s.attrs,
      })),
    });
  });

  // ---- PUT /api/traces/retention (admin) ----
  app.put('/api/traces/retention', async (req: FastifyRequest, reply) => {
    const org = req.potionOrg!;
    if (!roleAtLeast(org.role, 'admin')) {
      return reply.code(403).send(forbidden(org.role, 'set trace retention'));
    }
    const parsed = RetentionBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_body',
        message: parsed.error.issues.map((i) => i.message).join('; '),
      });
    }
    await setOrgTraceRetentionDays(db, org.orgId, parsed.data.days);
    return reply.send({ orgId: org.orgId, traceRetentionDays: parsed.data.days });
  });

  // ---- GET /api/traces/retention (viewer+) — current setting ----
  app.get('/api/traces/retention', async (req: FastifyRequest, reply) => {
    const org = req.potionOrg!;
    const days = await getOrgTraceRetentionDays(db, org.orgId);
    return reply.send({ orgId: org.orgId, traceRetentionDays: days ?? 30 });
  });

  // ---- POST /api/traces/cluster (admin) — enqueue agent clustering ----
  // Org-scoped to the caller: an org admin clusters THEIR OWN sessions (the
  // nightly interval job is the platform-global pass).
  app.post('/api/traces/cluster', async (req: FastifyRequest, reply) => {
    const org = req.potionOrg!;
    if (!roleAtLeast(org.role, 'admin')) {
      return reply.code(403).send(forbidden(org.role, 'cluster agent sessions'));
    }
    const body = z
      .object({ sinceDays: z.number().int().min(1).max(90).optional() })
      .safeParse(req.body ?? {});
    if (!body.success) {
      return reply.code(400).send({
        error: 'invalid_body',
        message: body.error.issues.map((i) => i.message).join('; '),
      });
    }
    const payload: TracesClusterPayload = {
      orgId: org.orgId,
      ...(body.data.sinceDays !== undefined ? { sinceDays: body.data.sinceDays } : {}),
    };
    const jobId = await opts.queue.enqueue('traces:cluster', payload);
    return reply.code(202).send({ jobId });
  });

  // ---- POST /api/traces/purge (admin) — enforce retention NOW (org-scoped) ----
  app.post('/api/traces/purge', async (req: FastifyRequest, reply) => {
    const org = req.potionOrg!;
    if (!roleAtLeast(org.role, 'admin')) {
      return reply.code(403).send(forbidden(org.role, 'purge traces'));
    }
    const jobId = await opts.queue.enqueue('traces:purge', { orgId: org.orgId });
    return reply.code(202).send({ jobId });
  });

  // ---- POST /api/traces/redact (admin) — G1.1 PII-redaction backfill ------
  // One-shot by design: ingest-time redaction covers new rows; this re-runs
  // the platform redactor over rows ingested before G1.1 (idempotent — a
  // second run updates 0). Org-forced like purge.
  app.post('/api/traces/redact', async (req: FastifyRequest, reply) => {
    const org = req.potionOrg!;
    if (!roleAtLeast(org.role, 'admin')) {
      return reply.code(403).send(forbidden(org.role, 'redact traces'));
    }
    const jobId = await opts.queue.enqueue('traces:redact', { orgId: org.orgId });
    return reply.code(202).send({ jobId });
  });
}
