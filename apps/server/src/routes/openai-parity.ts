// OpenAI API parity routes (M3 #25, SPEC §12.7) — GET /v1/models,
// POST /v1/embeddings, POST /v1/completions (legacy).
//
// All three reuse the §8 chat serving path pieces (Bearer-key auth →
// api_keys row, org resolution, cluster assign, frontier → selectPoint →
// strategy execution, x-frontier-trace) via the helpers exported from
// ./chat.js, and every error is OpenAI-shaped:
//   { error: { message, type, param, code } }
//   401 invalid_api_key (type invalid_request_error) · 400 invalid_request_error
//   503 service_unavailable (provider down mid-execution).
// Chat-completions parity (tools/tool_choice passthrough, streaming usage)
// lives in ./chat.ts; 429 rate_limit_exceeded in middleware/ratelimit.ts.
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { strategyHash, type ChatMessage, type Usage } from '@potion/core';
import { DEFAULT_ORG_ID, insertRequestLog, resolvePolicyRef, type NewRequestLog } from '@potion/db';
import { loadCurrentFrontier } from '@potion/pareto';
import { execute, type ExecContext } from '@potion/strategies';
import { authenticate, bearerToken, openAiError, type AuthResult } from '../auth.js';
import { assignmentCacheKey, type PotionContext } from '../context.js';
import { guardFrontierProvenance, resolveOperatingPoint, traceHeaderValue } from './chat.js';

/** chars/4 token estimate (same convention as the mock provider). */
function estTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/** `created` epoch for /v1/models entries — derived from the price table's
 * updatedAt so the list is deterministic per prices.json version. */
function modelListCreated(ctx: PotionContext): number {
  const ms = Date.parse(ctx.prices.updatedAt);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

/** Bearer-key auth shared by all three parity routes: 401 invalid_api_key in
 * the OpenAI error shape when the credential is missing/unknown/dead. */
async function requireApiKey(
  ctx: PotionContext,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<AuthResult | null> {
  const auth = await authenticate(ctx.db.db, bearerToken(req.headers.authorization));
  if (!auth) {
    await reply
      .code(401)
      .send(openAiError('missing or invalid api key', 'invalid_request_error', 'invalid_api_key'));
    return null;
  }
  return auth;
}

function zodMessage(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

// ---------------------------------------------------------------------------
// GET /v1/models (SPEC §12.7): all prices.json aliases + 'potion-auto' in the
// OpenAI list shape; owned_by = the entry's provider ('potion' for the auto
// router itself).
// ---------------------------------------------------------------------------
function registerModelsRoute(app: FastifyInstance, ctx: PotionContext): void {
  app.get('/v1/models', async (req, reply) => {
    const auth = await requireApiKey(ctx, req, reply);
    if (!auth) return reply;
    const created = modelListCreated(ctx);
    return {
      object: 'list',
      data: [
        { id: 'potion-auto', object: 'model', created, owned_by: 'potion' },
        ...ctx.prices.entries.map((e) => ({
          id: e.alias,
          object: 'model' as const,
          created,
          owned_by: e.provider,
        })),
      ],
    };
  });
}

// ---------------------------------------------------------------------------
// POST /v1/embeddings (SPEC §12.7): { model, input: string|string[] } → OpenAI
// embedding-list shape via the platform embedder (resolveEmbedder-selected at
// boot, cache-wrapped, guarded to the canonical 384-dim space). Batched input
// supported. `model` must be the deployment's embedding model — anything else
// is an OpenAI-shaped 400 (code model_not_found).
// ---------------------------------------------------------------------------
const EmbeddingsRequestSchema = z.object({
  model: z.string().min(1),
  input: z.union([z.string(), z.array(z.string()).min(1)]),
});

function registerEmbeddingsRoute(app: FastifyInstance, ctx: PotionContext): void {
  app.post('/v1/embeddings', async (req, reply) => {
    const auth = await requireApiKey(ctx, req, reply);
    if (!auth) return reply;

    const parsed = EmbeddingsRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(
          openAiError(zodMessage(parsed.error), 'invalid_request_error', 'invalid_request_error'),
        );
    }
    const { model, input } = parsed.data;
    if (model !== ctx.embedderInfo.model) {
      return reply
        .code(400)
        .send(
          openAiError(
            `unknown embedding model '${model}' — this deployment serves '${ctx.embedderInfo.model}'`,
            'invalid_request_error',
            'model_not_found',
            'model',
          ),
        );
    }

    const texts = typeof input === 'string' ? [input] : input;
    let vectors: number[][];
    try {
      vectors = await ctx.embedder.embed(texts);
    } catch (err) {
      return reply
        .code(503)
        .send(
          openAiError(
            `embedding provider unavailable: ${(err as Error).message}`,
            'service_unavailable',
            'service_unavailable',
          ),
        );
    }
    const promptTokens = texts.reduce((sum, t) => sum + estTokens(t.length), 0);
    return {
      object: 'list',
      data: vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })),
      model,
      usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
    };
  });
}

// ---------------------------------------------------------------------------
// POST /v1/completions (SPEC §12.7, LEGACY): { model, prompt, max_tokens,
// temperature, stream? } — the prompt→messages shim over the §8 serving
// path. prompt is a string or a string[] (one choice per element, index =
// position, same as OpenAI's legacy batching). Responses use the legacy
// shape: { id: cmpl-*, object: 'text_completion', choices: [{ text, index,
// finish_reason }] }. stream:true → SSE chunks in the OpenAI legacy chunk
// format (choices[].text deltas) terminated by [DONE]; composite strategies
// keep the documented non-streamed latency contract (200 JSON +
// x-latency-contract header), matching /v1/chat/completions.
// ---------------------------------------------------------------------------
const LegacyCompletionsRequestSchema = z.object({
  model: z.string().min(1),
  prompt: z.union([z.string(), z.array(z.string()).min(1)]),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
  stream: z.boolean().optional(),
});

interface CompletionPlan {
  messages: ChatMessage[];
  clusterId: string;
  op: ReturnType<typeof resolveOperatingPoint>;
  trace: string;
  strategyHash: string;
}

interface LegacySseChunk {
  id: string;
  object: 'text_completion';
  created: number;
  model: string;
  choices: Array<{ text: string; index: number; finish_reason: 'stop' | null }>;
}

function registerLegacyCompletionsRoute(app: FastifyInstance, ctx: PotionContext): void {
  const logRequest = async (fields: NewRequestLog): Promise<void> => {
    try {
      await insertRequestLog(ctx.db.db, fields);
    } catch (err) {
      app.log.warn(err, 'request_logs insert failed');
    }
  };

  app.post('/v1/completions', async (req, reply) => {
    const t0 = performance.now();
    const elapsed = (): number => Math.round((performance.now() - t0) * 100) / 100;

    // ---- 1. validate (unknown fields stripped) ----
    const parsed = LegacyCompletionsRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      await logRequest({
        orgId: DEFAULT_ORG_ID,
        model: null,
        status: 'invalid_request',
        latencyMs: elapsed(),
        trace: null,
      });
      return reply
        .code(400)
        .send(
          openAiError(zodMessage(parsed.error), 'invalid_request_error', 'invalid_request_error'),
        );
    }
    const body = parsed.data;
    const logBase: NewRequestLog = { orgId: DEFAULT_ORG_ID, model: body.model };

    // ---- 2. auth: Bearer → api_keys row → its policy (chat parity) ----
    const auth = await authenticate(ctx.db.db, bearerToken(req.headers.authorization));
    if (!auth) {
      await logRequest({ ...logBase, status: 'auth_failed', latencyMs: elapsed() });
      return reply
        .code(401)
        .send(openAiError('missing or invalid api key', 'invalid_request_error', 'invalid_api_key'));
    }
    logBase.apiKeyId = auth.key.id;
    logBase.orgId = auth.org.orgId;
    if (!auth.policy) {
      await logRequest({ ...logBase, status: 'no_policy', latencyMs: elapsed() });
      return reply
        .code(403)
        .send(
          openAiError(
            'api key has no policy bound — POST /v1/policies first',
            'invalid_request_error',
            'no_policy_bound',
          ),
        );
    }
    // ---- M4 #30 policy override (m4-sdks) ----
    // X-Potion-Policy: <policyId | policyName> — same per-request override
    // contract as /v1/chat/completions (SPEC §13.1; see the marked block in
    // ./chat.ts). Unknown ref → OpenAI-shaped 400 policy_not_found; the key's
    // bound policy remains the default.
    let policy = auth.policy;
    let policyId: string | null = auth.policyId;
    let policyOverrideName: string | null = null;
    const overrideHeader = req.headers['x-potion-policy'];
    const overrideRef = Array.isArray(overrideHeader) ? overrideHeader[0] : overrideHeader;
    if (overrideRef !== undefined && overrideRef.trim() !== '') {
      const overrideRow = await resolvePolicyRef(ctx.db.db, auth.org.orgId, overrideRef.trim());
      if (!overrideRow) {
        await logRequest({ ...logBase, status: 'policy_not_found', latencyMs: elapsed() });
        return reply
          .code(400)
          .send(
            openAiError(
              `unknown policy '${overrideRef.trim()}' — no policy with that id or name exists in your org`,
              'invalid_request_error',
              'policy_not_found',
              'X-Potion-Policy',
            ),
          );
      }
      policy = overrideRow.config;
      policyId = overrideRow.id;
      policyOverrideName = overrideRow.name;
    }
    logBase.policyType = policy.type;
    logBase.policyId = policyId;
    // ---- end M4 #30 policy override ----

    // ---- 3. prompt→messages shim + per-prompt serving plan ----
    // The shim is 1:1 with /v1/chat/completions: each prompt becomes a single
    // user message and flows through cluster assign → frontier → selectPoint
    // → NULL fallback (helpers shared with ./chat.ts).
    const prompts = typeof body.prompt === 'string' ? [body.prompt] : body.prompt;
    const orgProviders = await ctx.providersForOrg(auth.org.orgId);
    const execBase: Pick<ExecContext, 'providers' | 'prices' | 'resolve'> = {
      providers: orgProviders.providers,
      prices: ctx.prices,
      resolve: orgProviders.resolve,
    };
    const plans: CompletionPlan[] = [];
    for (const prompt of prompts) {
      const messages: ChatMessage[] = [{ role: 'user', content: prompt }];
      const cacheKey = assignmentCacheKey([prompt]);
      let assignment = ctx.assignCache.get(cacheKey);
      if (!assignment) {
        assignment = await ctx.assigner.assign(prompt);
        ctx.assignCache.set(cacheKey, assignment);
      }
      const loaded = await loadCurrentFrontier(ctx.db.db, assignment.clusterId);
      const { frontier, provenance } = guardFrontierProvenance(
        loaded,
        ctx.providerMode,
        (msg) => app.log.warn(msg),
      );
      const op = resolveOperatingPoint(policy, frontier);
      const sh = strategyHash(op.config);
      const trace =
        traceHeaderValue({
          clusterId: assignment.clusterId,
          strategyHash8: sh.slice(0, 8),
          frontierVersion: op.frontierVersion,
          policyType: policy.type,
          fallback: op.fallback,
          provenance,
        }) + (policyOverrideName !== null ? `;policy_override=${policyOverrideName}` : '');
      plans.push({ messages, clusterId: assignment.clusterId, op, trace, strategyHash: sh });
    }
    const first = plans[0]!;
    void reply.header('x-frontier-trace', first.trace);
    logBase.clusterId = first.clusterId;
    logBase.strategyHash = first.strategyHash;
    logBase.frontierVersion = first.op.frontierVersion;
    logBase.trace = first.trace;

    const id = `cmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const created = Math.floor(Date.now() / 1000);
    const wantStream = body.stream === true;
    const allSingle = plans.every((p) => p.op.config.type === 'single');

    // ---- 4a. SSE path: stream:true + all-single plans ----
    if (wantStream && allSingle) {
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-frontier-trace': first.trace,
      });
      const writeData = (obj: unknown): void => {
        reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`);
      };
      const aggregate: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 };
      try {
        for (const [index, plan] of plans.entries()) {
          const chunk = (text: string, finishReason: 'stop' | null): LegacySseChunk => ({
            id,
            object: 'text_completion',
            created,
            model: body.model,
            choices: [{ text, index, finish_reason: finishReason }],
          });
          const result = await execute(plan.op.config, plan.messages, {
            ...execBase,
            stream: (token) => writeData(chunk(token, null)),
          });
          writeData(chunk('', 'stop'));
          aggregate.inputTokens += result.usage.inputTokens;
          aggregate.outputTokens += result.usage.outputTokens;
          aggregate.costUsd += result.usage.costUsd;
          aggregate.latencyMs += result.usage.latencyMs;
        }
      } catch (err) {
        writeData(openAiError((err as Error).message, 'service_unavailable', 'service_unavailable'));
        reply.raw.write('data: [DONE]\n\n');
        reply.raw.end();
        await logRequest({ ...logBase, status: 'error', latencyMs: elapsed() });
        return;
      }
      reply.raw.write('data: [DONE]\n\n');
      reply.raw.end();
      await logRequest({ ...logBase, status: 'ok', usage: aggregate, latencyMs: elapsed() });
      return;
    }

    // ---- 4b. JSON path (non-stream, or stream:true with a composite) ----
    try {
      const choices: Array<{ text: string; index: number; finish_reason: 'stop' }> = [];
      const aggregate: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 };
      for (const [index, plan] of plans.entries()) {
        const result = await execute(plan.op.config, plan.messages, execBase);
        choices.push({ text: result.text, index, finish_reason: 'stop' });
        aggregate.inputTokens += result.usage.inputTokens;
        aggregate.outputTokens += result.usage.outputTokens;
        aggregate.costUsd += result.usage.costUsd;
        aggregate.latencyMs += result.usage.latencyMs;
      }
      if (wantStream) {
        // Documented contract (shared with chat): composite strategies cannot
        // token-stream → 200 JSON + the latency-contract header.
        void reply.header('x-latency-contract', 'non-streamed');
      }
      await logRequest({ ...logBase, status: 'ok', usage: aggregate, latencyMs: elapsed() });
      return reply.send({
        id,
        object: 'text_completion',
        created,
        model: body.model,
        choices,
        usage: {
          prompt_tokens: aggregate.inputTokens,
          completion_tokens: aggregate.outputTokens,
          total_tokens: aggregate.inputTokens + aggregate.outputTokens,
        },
      });
    } catch (err) {
      await logRequest({ ...logBase, status: 'error', latencyMs: elapsed() });
      return reply
        .code(503)
        .send(
          openAiError(
            `strategy execution failed: ${(err as Error).message}`,
            'service_unavailable',
            'service_unavailable',
          ),
        );
    }
  });
}

/** M3 #25 registration entry point (called from the marked block in server.ts). */
export function registerOpenAiParityRoutes(app: FastifyInstance, ctx: PotionContext): void {
  registerModelsRoute(app, ctx);
  registerEmbeddingsRoute(app, ctx);
  registerLegacyCompletionsRoute(app, ctx);
}
