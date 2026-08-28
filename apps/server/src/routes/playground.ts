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
  type LatencyPremium,
  type Policy,
  flattenWireMessage,
} from '@potion/core';
import { getFirstServingApiKeyWithPolicy, getPolicyById } from '@potion/db';
import { loadCurrentFrontier } from '@potion/pareto';
import type { RankedAssignment } from '@potion/cluster';
import { ambiguityMargin, ambiguousRunnerUp, pickSafer } from '../routing/ambiguity.js';
import { floorFor } from '../routing/floors.js';
import { execute } from '@potion/strategies';
import { openAiError } from '../auth.js';
import { maybeKeepLearningSample } from '../learning/sampling.js';
import { fallbackStrategyFor, type PotionContext } from '../context.js';
import {
  highestQualityPoint,
  resolveOperatingPoint,
  traceHeaderValue,
  type LatencyViolation, strategyModelLabel } from './chat.js';
import { bindServingLatency, policyHasLatencyDimension } from '../latency-policy.js';
import { assignmentCacheKey } from '../context.js';

const PlaygroundChatSchema = z
  .object({
    clusterId: z.string().min(1).max(200),
    messages: z.array(ChatMessageSchema).min(1),
    /** A strategyHash of a point on the cluster's current frontier. */
    strategyHash: z.string().min(1).max(200).optional(),
    /** 'potion-auto': resolve the operating point via the org's policy. */
    auto: z.boolean().optional(),
    /** Try page (operator, 2026-08-22): run the same request under a different
     * rule and watch the choice change. cost = cheapest at or above the floor;
     * quality = highest measured quality; latency = fastest at or above the
     * floor. Picked from the same frontier the policy routes from. */
    optimizeFor: z.enum(['cost', 'quality', 'latency']).optional(),
  })
  .strict();

type OptimizeFor = 'cost' | 'quality' | 'latency';

/** A public name for what a point runs: the model for a single, a count for a combination. */
export function pointModelLabel(cfg: FrontierPoint['strategyConfig']): string {
  if (cfg.type === 'single') return cfg.model;
  return `a combination (${cfg.type})`;
}

/** The three rules a reader can pick, applied to one frontier. Pure; no provider call. */
export function pickUnderRule(points: FrontierPoint[], rule: OptimizeFor, floor: number): FrontierPoint | null {
  if (points.length === 0) return null;
  const above = points.filter((p) => p.quality >= floor);
  const pool = above.length > 0 ? above : points;
  if (rule === 'quality') return points.reduce((a, b) => (b.quality > a.quality || (b.quality === a.quality && b.costPer1K < a.costPer1K) ? b : a));
  if (rule === 'latency') return pool.reduce((a, b) => (b.latencyP95 < a.latencyP95 ? b : a));
  return pool.reduce((a, b) => (b.costPer1K < a.costPer1K ? b : a));
}

export function alternativesFor(points: FrontierPoint[], floor: number) {
  return (['cost', 'quality', 'latency'] as const).map((rule) => {
    const p = pickUnderRule(points, rule, floor);
    return p
      ? { rule, model: pointModelLabel(p.strategyConfig), strategy_hash: p.strategyHash, quality: p.quality, cost_per_1k: p.costPer1K, p95_ms: p.latencyP95 }
      : { rule, model: null, strategy_hash: null, quality: null, cost_per_1k: null, p95_ms: null };
  });
}

interface ResolvedPoint {
  config: FrontierPoint['strategyConfig'];
  /** The frontier point backing the execution (null only for the documented
   * no-policy/highest-quality fallback shapes — still frontier points). */
  point: FrontierPoint | null;
  fallback: 0 | 1;
  /** G2.6: the labeled consequence when a compound policy's latency bound
   * admits no quality-qualifying point. The playground is where a developer
   * TUNES a policy, so it is the surface where seeing the violation matters
   * most — showing a served answer with no note would teach them the bound
   * is being met. */
  latencyViolation?: LatencyViolation;
  /** Which clock the bound was evaluated against. */
  latencySource?: 'serving' | 'harness';
  /** What the bound is costing at this quality floor, if anything. */
  latencyPremium?: LatencyPremium;
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
  const key = await getFirstServingApiKeyWithPolicy(ctx.db.db, orgId);
  if (key?.policyId) {
    const row = await getPolicyById(ctx.db.db, orgId, key.policyId);
    policy = row?.config ?? null;
  }
  if (policy) {
    // G2.4: the playground shares the serving path's mode-aware fallback —
    // under a live server it never resolves to a mock alias.
    // G2.6: …and the same serving-grade latency binding, so a policy tuned
    // here behaves identically when it serves.
    const latency = await bindServingLatency(ctx, policy, frontier, orgId, frontier.clusterId);
    const op = resolveOperatingPoint(
      policy,
      latency.frontier,
      fallbackStrategyFor(ctx.providerMode, ctx.prices),
    );
    if (op.config === null) {
      return { error: 'no live strategy is resolvable — a live server never serves mock output' };
    }
    const opConfig = op.config;
    const hash = strategyHash(opConfig);
    const boundPoints = latency.frontier?.points ?? frontier.points;
    return {
      config: opConfig,
      point: boundPoints.find((p) => p.strategyHash === hash) ?? null,
      fallback: op.fallback,
      ...(op.latencyViolation ? { latencyViolation: op.latencyViolation } : {}),
      ...(policyHasLatencyDimension(policy)
        ? { latencySource: latency.source, latencyPremium: latency.premium }
        : {}),
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
    const messages: ChatMessage[] = body.messages.map((m) => flattenWireMessage(m).message);
    // 'auto' (2026-08-22, Home's "Try a request"): classify the prompt the way
    // serving does — same assigner, same content-hash cache — so the box needs
    // no cluster picked by hand. The receipt names what it chose.
    let clusterId = body.clusterId;
    let clusterConfidence: number | null = null;
    let ranked: RankedAssignment | undefined;
    if (clusterId === 'auto') {
      const contents = messages.filter((m) => m.role === 'user').map((m) => m.content);
      const cacheKey = assignmentCacheKey(contents);
      ranked = ctx.assignCache.get(cacheKey);
      if (!ranked) {
        ranked = await ctx.assigner.assignRanked(contents.join('\n'));
        ctx.assignCache.set(cacheKey, ranked);
      }
      clusterId = ranked.assignment.clusterId;
      clusterConfidence = ranked.assignment.confidence;
    }
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

    // The org's floor, for the Try page's rules (0.95 when the policy has none).
    let boundPolicy: Policy | null = null;
    {
      const k = await getFirstServingApiKeyWithPolicy(ctx.db.db, org.orgId);
      const row = k?.policyId ? await getPolicyById(ctx.db.db, org.orgId, k.policyId) : null;
      boundPolicy = row?.config ?? null;
    }
    // The org's floor for this kind of work (0.95 when the policy has none).
    const floorOf = (cid: string) => (boundPolicy ? floorFor(boundPolicy, cid) : null) ?? 0.95;
    let floor = floorOf(clusterId);
    let frontier = await loadCurrentFrontier(ctx.db.db, clusterId, org.orgId);
    // Quality-safe tiebreak, the same rule the serving path applies
    // (routing/ambiguity.ts): a near-equal runner-up cluster is loaded too and
    // the pair is served under the higher measured quality of each one's pick.
    let tiebreak = false;
    const runnerUpId = ranked !== undefined ? ambiguousRunnerUp(ranked, ambiguityMargin()) : null;
    if (runnerUpId !== null) {
      const other = await loadCurrentFrontier(ctx.db.db, runnerUpId, org.orgId);
      const candidate = (cid: string, f: Frontier | null) => {
        const pick = f ? pickUnderRule(f.points, body.optimizeFor ?? 'cost', floorOf(cid)) : null;
        return { clusterId: cid, frontier: f, quality: pick?.quality ?? null, costPer1K: pick?.costPer1K ?? null };
      };
      const winner = pickSafer(candidate(clusterId, frontier), candidate(runnerUpId, other));
      if (winner.clusterId !== clusterId) {
        tiebreak = true;
        clusterId = winner.clusterId;
        frontier = winner.frontier;
        floor = floorOf(clusterId);
      }
    }
    // An unmeasured cluster must not kill the FIRST experience (found by the
    // S1 browser pass, 2026-08-25: a fresh org's sample request classified
    // into a frontier-less cluster and died at the aha). Parity with /v1:
    // serve the documented default strategy, honestly marked fallback=1 —
    // the receipt says "not measured yet", never a 404.
    const unmeasured = !frontier || frontier.points.length === 0;
    // The fallback applies ONLY to auto-classified requests (a real taxonomy
    // id the classifier chose). An EXPLICITLY named cluster that has no
    // frontier keeps its 404 — a typo must error, not silently serve.
    if (unmeasured && body.clusterId !== 'auto') {
      return reply
        .code(404)
        .send(openAiError(`no frontier for cluster '${clusterId}'`, 'invalid_request_error'));
    }
    type PlaygroundResolved = Exclude<Awaited<ReturnType<typeof resolvePlaygroundPoint>>, { error: string }>;
    const alternatives = unmeasured ? [] : alternativesFor(frontier!.points, floor);
    const ruled = !unmeasured && body.optimizeFor ? pickUnderRule(frontier!.points, body.optimizeFor, floor) : null;
    const resolved = unmeasured
      ? ({ config: fallbackStrategyFor(ctx.providerMode, ctx.prices), fallback: 1 as const, point: null } as PlaygroundResolved)
      : await resolvePlaygroundPoint(
          ctx,
          org.orgId,
          frontier!,
          ruled ? { strategyHash: ruled.strategyHash, auto: false } : body,
        );
    if ('error' in resolved) {
      return reply.code(404).send(openAiError(resolved.error, 'invalid_request_error', 'not_found'));
    }

    const sh = strategyHash(resolved.config);
    // Per-point provenance: only live-backed evidence may claim live.
    const provenance: 'live' | 'mock' =
      resolved.point !== null && resolved.point.providerMode === 'live' ? 'live' : 'mock';
    const trace = traceHeaderValue({
      clusterId,
      strategyHash8: sh.slice(0, 8),
      frontierVersion: frontier?.version ?? 0,
      policyType: 'playground',
      fallback: resolved.fallback,
      provenance,
    }) +
      // G2.6: the same latency markers the serving path emits, so a policy
      // tuned in the playground reads exactly as it will when it serves.
      (resolved.latencySource !== undefined ? `;latency_src=${resolved.latencySource}` : '') +
      (resolved.latencyPremium?.binding === 'latency' && resolved.latencyPremium.savingsPct > 0
        ? `;latency_premium=${resolved.latencyPremium.savingsPct.toFixed(2)}` +
          `;relax_ms=${Math.round(resolved.latencyPremium.relaxLatencyToMs ?? 0)}`
        : '') +
      (resolved.latencyViolation !== undefined ? ';latency_violated=1' : '');

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
        'x-potion-model': strategyModelLabel(resolved.config as { type: string; model?: string }),
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
      const result = await execute(resolved.config, messages, {
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
      // A Try-page request is the org's real request under its rule: sample it
      // for the learning period exactly like the key-served path (consent-
      // gated, capped, redacted), and measure the moment a kind of work has
      // enough — the journey's own trial requests count toward it.
      {
        const lastUser = [...messages].reverse().find((m) => m.role === 'user');
        const cfg = resolved.config as { type: string; model?: string };
        void maybeKeepLearningSample(
          ctx.db.db,
          {
            orgId: org.orgId,
            requestId: id,
            clusterId,
            model: cfg.type === 'single' ? (cfg.model ?? null) : `combination:${cfg.type}`,
            prompt: typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content ?? ''),
            completion: result.text,
            costUsd: result.usage.costUsd ?? 0,
            usage: result.usage as unknown as Record<string, unknown>,
          },
          () => { ctx.queue?.enqueue('learning:period', { orgId: org.orgId }).catch(() => undefined); },
        );
      }
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
        model: pointModelLabel(resolved.config),
        ...(resolved.point ? { quality: resolved.point.quality, cost_per_1k: resolved.point.costPer1K, p95_ms: resolved.point.latencyP95 } : {}),
        rule: body.optimizeFor ?? 'policy',
        floor,
        alternatives,
        provenance,
        cluster_id: clusterId,
        ...(clusterConfidence !== null ? { cluster_confidence: clusterConfidence } : {}),
        ...(tiebreak ? { cluster_tiebreak: true } : {}),
        // G2.6: the compare view reads this meta chunk, so the latency
        // consequence travels with the answer rather than only in a header.
        ...(resolved.latencySource !== undefined ? { latency_source: resolved.latencySource } : {}),
        ...(resolved.latencyViolation !== undefined
          ? { latency_violation: resolved.latencyViolation }
          : {}),
        ...(resolved.latencyPremium !== undefined && resolved.latencyPremium.binding === 'latency'
          ? {
              latency_premium: {
                savings_pct: resolved.latencyPremium.savingsPct,
                delta_cost_per_1k: resolved.latencyPremium.deltaCostPer1K,
                relax_latency_to_ms: resolved.latencyPremium.relaxLatencyToMs,
                relax_quality_to_floor: resolved.latencyPremium.relaxQualityToFloor,
              },
            }
          : {}),
      });
    } catch (err) {
      writeData(openAiError((err as Error).message, 'service_unavailable', 'service_unavailable'));
    }
    reply.raw.write('data: [DONE]\n\n');
    reply.raw.end();
    return;
  });
}
