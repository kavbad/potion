// Playground chat route (M4, ROADMAP #31, SPEC §13.3).
//
//   POST /api/playground/chat   org-scoped (member+ via the dashboard auth
//                               hook — it is a write method)
//
// The playground executes a CHOSEN frontier point directly (no policy
// routing): the caller picks { clusterId, strategyHash } — a point on the
// cluster's CURRENT frontier — or { clusterId, auto: true } ('potion-auto':
// the org's bound policy resolves the operating point exactly like the
// serving path, highest-quality fallback when no policy exists).
//
// Responses are ALWAYS SSE (OpenAI chunk framing, same shapes as
// routes/chat.ts): role chunk → content token chunks → finish chunk → a
// final META chunk (empty choices + usage + latency_ms + cost_usd +
// strategy_hash + provenance) → [DONE]. Multi-call strategies that cannot
// token-stream emit their final text as ONE content chunk (same documented
// latency contract as the serving path). x-frontier-trace carries
// `policy=playground` and the EXECUTED strategy's hash — the trace header is
// the proof the chosen point ran.
//
// Provenance: the chosen point's provider_mode drives the trace's
// provenance= field and the meta chunk — mock/unknown evidence is badged
// SIMULATED on the client, never presented as live.
//
// Deliberately NOT logged to request_logs and NEVER shadow/guarantee
// sampled: the playground is an interactive experiment surface, not served
// traffic — metering it would pollute the usage/savings evidence.
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ChatMessageSchema,
  strategyHash,
  type ChatMessage,
  type Frontier,
  type FrontierPoint,
  type Policy,
} from '@potion/core';
import { getFirstApiKeyWithPolicy, getPolicyById } from '@potion/db';
import { loadCurrentFrontier } from '@potion/pareto';
import { execute } from '@potion/strategies';
import { openAiError } from '../auth.js';
import type { PotionContext } from '../context.js';
import { highestQualityPoint, resolveOperatingPoint, traceHeaderValue } from './chat.js';

const PlaygroundChatSchema = z
  .object({
    clusterId: z.string().min(1).max(200),
    messages: z.array(ChatMessageSchema).min(1),
    /** A strategyHash of a point on the cluster's current frontier. */
    strategyHash: z.string().min(1).max(200).optional(),
    /** 'potion-auto': resolve the operating point via the org's policy. */
    auto: z.boolean().optional(),
  })
  .strict();

interface ResolvedPoint {
  config: FrontierPoint['strategyConfig'];
  /** The frontier point backing the execution (null only for the documented
   * no-policy/highest-quality fallback shapes — still frontier points). */
  point: FrontierPoint | null;
  fallback: 0 | 1;
}

/** Point selection: explicit strategyHash, else potion-auto policy routing. */
async function resolvePlaygroundPoint(
  ctx: PotionContext,
  orgId: string,
  frontier: Frontier,
  body: { strategyHash?: string | undefined; auto?: boolean | undefined },
): Promise<ResolvedPoint | { error: string }> {
  if (body.strategyHash) {
    const point = frontier.points.find((p) => p.strategyHash === body.strategyHash) ?? null;
    if (!point) {
      return { error: `strategy '${body.strategyHash}' is not a point on the current frontier` };
    }
    return { config: point.strategyConfig, point, fallback: 0 };
  }
  // potion-auto: the org's first key with a bound policy drives routing
  // (same resolution as the dashboard's operating point); without a policy
  // the documented highest-quality fallback serves.
  let policy: Policy | null = null;
  const key = await getFirstApiKeyWithPolicy(ctx.db.db, orgId);
  if (key?.policyId) {
    const row = await getPolicyById(ctx.db.db, orgId, key.policyId);
    policy = row?.config ?? null;
  }
  if (policy) {
    const op = resolveOperatingPoint(policy, frontier);
    const hash = strategyHash(op.config);
    return {
      config: op.config,
      point: frontier.points.find((p) => p.strategyHash === hash) ?? null,
      fallback: op.fallback,
    };
  }
  const best = highestQualityPoint(frontier.points);
  if (!best) return { error: 'frontier has no points' };
  return { config: best.strategyConfig, point: best, fallback: 1 };
}

export function registerPlaygroundRoutes(app: FastifyInstance, ctx: PotionContext): void {
  app.post('/api/playground/chat', async (req, reply) => {
    const org = req.potionOrg;
    if (!org) {
      return reply
        .code(401)
        .send(openAiError('authentication required', 'invalid_request_error', 'authentication_required'));
    }
    const parsed = PlaygroundChatSchema.safeParse(req.body);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return reply.code(400).send(openAiError(message, 'invalid_request_error'));
    }
    const body = parsed.data;
    if (!body.strategyHash && body.auto !== true) {
      return reply
        .code(400)
        .send(
          openAiError(
            "pick a frontier point (strategyHash) or potion-auto (auto: true)",
            'invalid_request_error',
          ),
        );
    }

    const frontier = await loadCurrentFrontier(ctx.db.db, body.clusterId);
    if (!frontier || frontier.points.length === 0) {
      return reply
        .code(404)
        .send(openAiError(`no frontier for cluster '${body.clusterId}'`, 'invalid_request_error'));
    }
    const resolved = await resolvePlaygroundPoint(ctx, org.orgId, frontier, body);
    if ('error' in resolved) {
      return reply.code(404).send(openAiError(resolved.error, 'invalid_request_error', 'not_found'));
    }

    const sh = strategyHash(resolved.config);
    // Per-point provenance: only live-backed evidence may claim live.
    const provenance: 'live' | 'mock' =
      resolved.point !== null && resolved.point.providerMode === 'live' ? 'live' : 'mock';
    const trace = traceHeaderValue({
      clusterId: body.clusterId,
      strategyHash8: sh.slice(0, 8),
      frontierVersion: frontier.version,
      policyType: 'playground',
      fallback: resolved.fallback,
      provenance,
    });

    const t0 = performance.now();
    const id = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const created = Math.floor(Date.now() / 1000);
    const model = 'potion-playground';
    const orgProviders = await ctx.providersForOrg(org.orgId);

    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-frontier-trace': trace,
      'x-request-id': req.id,
    });
    const base = { id, created, model };
    const writeData = (obj: unknown): void => {
      reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`);
    };
    const chunk = (
      delta: { role?: 'assistant'; content?: string },
      finishReason: 'stop' | null = null,
    ): unknown => ({
      ...base,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    });

    writeData(chunk({ role: 'assistant' }));
    let streamed = 0;
    try {
      const result = await execute(resolved.config, body.messages as ChatMessage[], {
        providers: orgProviders.providers,
        prices: ctx.prices,
        resolve: orgProviders.resolve,
        stream: (token) => {
          streamed += 1;
          writeData(chunk({ content: token }));
        },
      });
      // Multi-call strategies cannot token-stream (documented latency
      // contract) — deliver the final text as one content chunk so the SSE
      // shape stays uniform for the compare view.
      if (streamed === 0 && result.text !== '') {
        writeData(chunk({ content: result.text }));
      }
      writeData(chunk({}, 'stop'));
      // Final META chunk: empty choices + usage + the playground's per-response
      // latency/cost (the compare view reads this).
      writeData({
        ...base,
        object: 'chat.completion.chunk',
        choices: [],
        usage: {
          prompt_tokens: result.usage.inputTokens,
          completion_tokens: result.usage.outputTokens,
          total_tokens: result.usage.inputTokens + result.usage.outputTokens,
        },
        latency_ms: Math.round((performance.now() - t0) * 100) / 100,
        cost_usd: result.usage.costUsd,
        strategy_hash: sh,
        provenance,
      });
    } catch (err) {
      writeData(openAiError((err as Error).message, 'service_unavailable', 'service_unavailable'));
    }
    reply.raw.write('data: [DONE]\n\n');
    reply.raw.end();
    return;
  });
}
