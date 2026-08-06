// POST /v1/chat/completions (SPEC §8) — OpenAI-compatible subset.
//
// Pipeline: zod-validate → Bearer auth → api_keys row → its policy → cluster
// assign (<30ms target; cached by sha256(first 512 chars of concatenated user
// content)) → loadCurrentFrontier(cluster) → selectPoint(policy) → NULL
// fallback to the highest-quality point (documented in SPEC §1/§8) → execute
// the resolved strategy → OpenAI-shaped response.
//
// Every response carries `x-frontier-trace:
//   cluster=<id>;strategy=<hash8>;frontier=v<n>;policy=<type>;fallback=<0|1>;provenance=<live|mock|blocked>`.
// (provenance added in M1a — see guardFrontierProvenance.)
// stream:true + single strategy → SSE (chat.completion.chunk deltas + [DONE]);
// stream:true + composite strategy (M3 #23, SPEC §12.6) → SSE too, with the
// keep/upgrade decision recorded as `upgraded=0|1` on x-frontier-trace;
// stream:true + any other multi-call strategy → 200 JSON +
// `x-latency-contract: non-streamed` (documented latency contract: those
// strategies fan out model calls and cannot honor token streaming).
// EVERY request (including 4xx/5xx) is logged to request_logs.
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ChatMessageSchema,
  ToolChoiceSchema,
  ToolSchema,
  highestQualityPoint,
  selectPoint,
  strategyHash,
  type ChatMessage,
  type Frontier,
  type FrontierPoint,
  type Policy,
  type StrategyConfig,
  type ToolCall,
  type Usage,
} from '@potion/core';
import { DEFAULT_ORG_ID, getClusterById, insertRequestLog, resolvePolicyRef, type NewRequestLog } from '@potion/db';
import { loadCurrentFrontier } from '@potion/pareto';
import { execute } from '@potion/strategies';
import { authenticate, bearerToken, openAiError } from '../auth.js';
import {
  DEFAULT_STRATEGY,
  assignmentCacheKey,
  type PotionContext,
} from '../context.js';
// ---- M3 #21 shadow (m3-shadow) — appended import ----
import { runShadow, shouldSample } from '../shadow.js';
// ---- end M3 #21 shadow imports ----
// ---- M3 #22 guarantee (m3-guarantee) — appended import ----
import {
  resolveGuaranteeOverride,
  runGuaranteeSample,
  shouldSampleGuarantee,
} from '../guarantee.js';
// ---- end M3 #22 guarantee imports ----
// ---- M4 #33/#35 alerts + budget (m4-alerts-budget) — appended imports ----
import { emitAlert } from '../alerts.js';
import { checkBudgetHardStop } from './budgets.js';
import { recordBudgetEvent } from '@potion/db';
import { ProviderError, breakerStates } from '@potion/providers';
// ---- end M4 #33/#35 imports ----

// ---- M4 #33 breaker_open alerts (m4-alerts-budget) ----
// Transition detector: the resilience circuit breaker fast-rejects with a
// breakerOpen ProviderError for as long as the breaker stays open — alerting
// on every refusal would spam. Emit ONLY on the closed→open edge per
// `${provider}:${model}` key; the edge re-arms when the resilience registry
// reports the key no longer open (cooldown/half-open recovery). Per-instance
// state (HA: each instance may emit once — documented, acceptable for an
// incident signal).
const breakerAlertedKeys = new Set<string>();
function notifyBreakerOpen(
  ctx: PotionContext,
  orgId: string,
  err: unknown,
  warn: (msg: string) => void,
): void {
  if (!(err instanceof ProviderError) || err.breakerOpen !== true) return;
  const key = `${err.provider}:${err.model ?? 'unknown'}`;
  // Re-arm keys the registry no longer reports open.
  const states = breakerStates();
  for (const k of breakerAlertedKeys) {
    if (states[k] !== 'open') breakerAlertedKeys.delete(k);
  }
  if (breakerAlertedKeys.has(key)) return;
  breakerAlertedKeys.add(key);
  emitAlert(ctx, {
    orgId,
    event: 'breaker_open',
    detail: { breaker: key, kind: err.kind, message: err.message },
  }).catch((e: unknown) => warn(`breaker_open alert emit failed — swallowed: ${(e as Error).message}`));
}
// ---- end M4 #33 breaker_open alerts ----

/** zod-validated OpenAI subset; unknown fields are stripped (ignored).
 * M3 #25: tools / tool_choice (function-calling passthrough — 'single'
 * strategy only, enforced below) and stream_options.include_usage. */
export const ChatCompletionsRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(ChatMessageSchema).min(1),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  max_tokens: z.number().int().positive().optional(),
  tools: z.array(ToolSchema).min(1).optional(),
  tool_choice: ToolChoiceSchema.optional(),
  stream_options: z.object({ include_usage: z.boolean().optional() }).optional(),
});

export interface OperatingPoint {
  config: StrategyConfig;
  /** 1 when the policy was infeasible (or no frontier exists) and the
   * documented fallback fired. */
  fallback: 0 | 1;
  frontierVersion: number;
  frontier: Frontier | null;
}

/** Highest-quality point (tie → lower cost) — the documented NULL fallback. */
// Canonical home is @potion/core (select.ts) since M4b #37 — imported above
// and re-exported here for the dashboard route's existing import.
export { highestQualityPoint };

/** selectPoint(policy) with the §8 NULL fallback applied. */
export function resolveOperatingPoint(
  policy: Policy,
  frontier: Frontier | null,
): OperatingPoint {
  if (!frontier || frontier.points.length === 0) {
    return { config: DEFAULT_STRATEGY, fallback: 1, frontierVersion: 0, frontier };
  }
  const selected = selectPoint(policy, frontier);
  if (selected) {
    return {
      config: selected.strategyConfig,
      fallback: 0,
      frontierVersion: frontier.version,
      frontier,
    };
  }
  const best = highestQualityPoint(frontier.points);
  if (!best) {
    return { config: DEFAULT_STRATEGY, fallback: 1, frontierVersion: frontier.version, frontier };
  }
  return { config: best.strategyConfig, fallback: 1, frontierVersion: frontier.version, frontier };
}

/**
 * Serve-time provenance guard (ROADMAP M1a item 4): a simulated number may
 * never masquerade as live evidence.
 *
 * A frontier is TAINTED when any point's provider_mode is 'mock' or
 * 'unknown' (absent on the value object — pre-M1a rows). When the server
 * runs with live providers we REFUSE to serve from a tainted frontier: the
 * request falls back per the existing no-frontier rule (DEFAULT_STRATEGY,
 * frontier=v0, fallback=1) and the trace header carries provenance=blocked.
 * When running mock-only (dev), tainted frontiers serve with
 * provenance=mock. All-live frontiers always serve with provenance=live.
 */
export function guardFrontierProvenance(
  frontier: Frontier | null,
  serverMode: 'mock' | 'live',
  warn: (msg: string) => void = () => {},
): { frontier: Frontier | null; provenance: 'live' | 'mock' | 'blocked' } {
  if (!frontier || frontier.points.length === 0) {
    return { frontier, provenance: serverMode };
  }
  const tainted = frontier.points.some((p) => (p.providerMode ?? 'unknown') !== 'live');
  if (!tainted) return { frontier, provenance: 'live' };
  if (serverMode === 'live') {
    warn(
      `provenance guard: refusing to serve cluster '${frontier.clusterId}' from ` +
        `frontier v${frontier.version} — provider_mode mock/unknown under live providers ` +
        `(falling back to the no-frontier default)`,
    );
    return { frontier: null, provenance: 'blocked' };
  }
  return { frontier, provenance: 'mock' };
}

/** SPEC §8 trace header (semicolon-separated, no spaces), plus the M1a
 * provenance marker: provenance=live|mock|blocked. */
export function traceHeaderValue(op: {
  clusterId: string;
  strategyHash8: string;
  frontierVersion: number;
  policyType: string;
  fallback: 0 | 1;
  provenance: 'live' | 'mock' | 'blocked';
}): string {
  return (
    `cluster=${op.clusterId};strategy=${op.strategyHash8};` +
    `frontier=v${op.frontierVersion};policy=${op.policyType};fallback=${op.fallback};` +
    `provenance=${op.provenance}`
  );
}

/** OpenAI streaming tool_calls delta (M3 #25): the wire format carries an
 * `index` per tool call inside the delta. */
interface SseToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
}

interface SseChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: 0;
    delta: { role?: 'assistant'; content?: string; tool_calls?: SseToolCallDelta[] };
    finish_reason: 'stop' | 'tool_calls' | null;
  }>;
}

function sseChunk(
  base: { id: string; created: number; model: string },
  delta: { role?: 'assistant'; content?: string; tool_calls?: SseToolCallDelta[] },
  finishReason: 'stop' | 'tool_calls' | null = null,
): SseChunk {
  return {
    id: base.id,
    object: 'chat.completion.chunk',
    created: base.created,
    model: base.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

/** Final usage-only chunk (M3 #25): emitted when the request sets
 * stream_options.include_usage — choices is EMPTY per the OpenAI spec. */
function sseUsageChunk(
  base: { id: string; created: number; model: string },
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
): {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: [];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
} {
  return {
    id: base.id,
    object: 'chat.completion.chunk',
    created: base.created,
    model: base.model,
    choices: [],
    usage,
  };
}

/** Convert provider-verbatim ToolCalls to the streaming delta wire shape. */
function toolCallDeltas(toolCalls: ToolCall[]): SseToolCallDelta[] {
  return toolCalls.map((tc, index) => ({
    index,
    id: tc.id,
    type: 'function' as const,
    function: { name: tc.function.name, arguments: tc.function.arguments },
  }));
}

export function registerChatRoutes(app: FastifyInstance, ctx: PotionContext): void {
  const logRequest = async (fields: NewRequestLog): Promise<void> => {
    try {
      await insertRequestLog(ctx.db.db, fields);
    } catch (err) {
      app.log.warn(err, 'request_logs insert failed');
    }
  };

  app.post('/v1/chat/completions', async (req, reply) => {
    const t0 = performance.now();
    const elapsed = (): number => Math.round((performance.now() - t0) * 100) / 100;

    // ---- 1. validate (unknown fields ignored) ----
    const parsed = ChatCompletionsRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      await logRequest({
        // request_logs.org_id is NOT NULL (M2 #13); a request that failed
        // validation BEFORE auth has no tenant, so unattributed traffic is
        // recorded under the default org.
        orgId: DEFAULT_ORG_ID,
        model: null,
        status: 'invalid_request',
        latencyMs: elapsed(),
        trace: null,
      });
      return reply
        .code(400)
        .send(openAiError(message, 'invalid_request_error', 'invalid_request_error'));
    }
    const body = parsed.data;
    // Pre-auth log fields: unattributed → default org (see above). Replaced
    // with the authenticated org as soon as the key resolves.
    const logBase: NewRequestLog = { orgId: DEFAULT_ORG_ID, model: body.model };

    // ---- 2. auth: Bearer → api_keys row → its policy ----
    const auth = await authenticate(ctx.db.db, bearerToken(req.headers.authorization));
    if (!auth) {
      await logRequest({ ...logBase, status: 'auth_failed', latencyMs: elapsed() });
      return reply
        .code(401)
        .send(openAiError('missing or invalid api key', 'invalid_request_error', 'invalid_api_key'));
    }
    logBase.apiKeyId = auth.key.id;
    logBase.orgId = auth.org.orgId; // tenant scope (M2 #13)
    // ---- M4 #35 budget autopilot (m4-alerts-budget) ----
    // Hard-stop (SPEC §13.7): BEFORE any strategy work, if the org's budget
    // has hard_stop=true and MTD spend ≥ cap → 429 OpenAI-shaped
    // budget_exceeded. Soft caps NEVER block. The check is cached 60s/org
    // and fails OPEN on db errors (availability; see routes/budgets.ts).
    // The refusal is also an ALERT event — deduped per (org, kind, UTC day)
    // through the budget_events ledger, then alerts:dispatch.
    {
      const gate = await checkBudgetHardStop(ctx, auth.org.orgId);
      if (gate.stopped && gate.budget) {
        await logRequest({ ...logBase, status: 'budget_exceeded', latencyMs: elapsed() });
        recordBudgetEvent(ctx.db.db, { orgId: auth.org.orgId, kind: 'budget_exceeded' })
          .then(async (fresh) => {
            if (fresh) {
              await emitAlert(ctx, {
                orgId: auth.org.orgId,
                event: 'budget_exceeded',
                detail: {
                  monthlyCapUsd: gate.budget!.monthlyCapUsd,
                  mtdUsd: gate.mtdUsd,
                  source: 'serving_path_hard_stop',
                },
              });
            }
          })
          .catch((err: unknown) => app.log.warn(err, 'budget alert emit failed — swallowed'));
        return reply
          .code(429)
          .send(
            openAiError(
              `monthly budget cap reached (hard stop): MTD $${gate.mtdUsd.toFixed(2)} ≥ cap ` +
                `$${gate.budget.monthlyCapUsd.toFixed(2)} — raise it via PUT /api/budgets`,
              'budget_exceeded',
              'budget_exceeded',
            ),
          );
      }
    }
    // ---- end M4 #35 budget autopilot ----
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
    // X-Potion-Policy: <policyId | policyName> — per-request policy override
    // (SPEC §13.1), resolved within the caller's org (a ref that only exists
    // in another org is NOT FOUND — no cross-org existence oracle). The api
    // key's bound policy remains the default when the header is absent. An
    // unknown ref is a client error: OpenAI-shaped 400
    // invalid_request_error/policy_not_found with param echoing the header
    // name. The resolution is recorded in request_logs.policy_id (the bound
    // policy id by default, the override row id when overridden) and echoed
    // on x-frontier-trace: policy=<type> always reflects the ACTIVE policy
    // (override included); an override additionally appends
    // `;policy_override=<name>` so the name flows to the client (SDKs parse
    // it into frontier_trace).
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

    // ---- M5 #36 X-Potion-Cluster hint (SPEC §14.2): agent workloads may
    // pin their cluster explicitly (e.g. X-Potion-Cluster: agent-<slug>)
    // instead of relying on content embedding. Unknown cluster → 400, same
    // contract as X-Potion-Policy: an explicit request is rejected
    // explicitly, never silently re-routed. ----
    const clusterHeader = req.headers['x-potion-cluster'];
    const clusterHintRaw = Array.isArray(clusterHeader) ? clusterHeader[0] : clusterHeader;
    let hintedClusterId: string | null = null;
    if (clusterHintRaw !== undefined && clusterHintRaw.trim() !== '') {
      const clusterRow = await getClusterById(ctx.db.db, clusterHintRaw.trim());
      if (!clusterRow) {
        await logRequest({ ...logBase, status: 'cluster_not_found', latencyMs: elapsed() });
        return reply
          .code(400)
          .send(
            openAiError(
              `unknown cluster '${clusterHintRaw.trim()}' — no cluster with that id exists`,
              'invalid_request_error',
              'cluster_not_found',
              'X-Potion-Cluster',
            ),
          );
      }
      hintedClusterId = clusterRow.id;
    }
    // ---- end M5 #36 cluster hint ----

    // ---- 3. cluster assign (<30ms target; cached by content hash) ----
    let clusterId: string;
    if (hintedClusterId !== null) {
      // M5 #36: hint wins; the embedder/assigner is skipped entirely.
      clusterId = hintedClusterId;
    } else {
      const userContents = body.messages.filter((m) => m.role === 'user').map((m) => m.content);
      const contents = userContents.length > 0 ? userContents : body.messages.map((m) => m.content);
      const cacheKey = assignmentCacheKey(contents);
      let assignment = ctx.assignCache.get(cacheKey);
      if (!assignment) {
        assignment = await ctx.assigner.assign(contents.join('\n'));
        ctx.assignCache.set(cacheKey, assignment);
      }
      clusterId = assignment.clusterId;
    }
    logBase.clusterId = clusterId;

    // ---- 4. frontier → provenance guard → selectPoint(policy) → NULL fallback ----
    // Frontiers are shared-global by design (ROADMAP #13): the routing
    // evidence base is a platform asset — NEVER org-scoped.
    const loaded = await loadCurrentFrontier(ctx.db.db, clusterId);
    const { frontier, provenance } = guardFrontierProvenance(
      loaded,
      ctx.providerMode,
      (msg) => app.log.warn(msg),
    );
    let op = resolveOperatingPoint(policy, frontier);
    // ---- M3 #22 guarantee (m3-guarantee) — rollback operating-point override ----
    // The LATEST UNRESOLVED kind='rollback' incident for (org, cluster) IS the
    // org's operating point for that cluster (SPEC §12.5; the incident row
    // doubles as the override state — see repos/guarantee.ts). When one is
    // active, the served strategy is swapped to its detail.toStrategy
    // (resolved via the serving frontier's points, then strategy_configs);
    // the trace header's strategy= field therefore shows the rolled-back
    // hash. Resolving the incident (POST /api/incidents/:id/resolve) lifts
    // the override. A failed/unresolvable lookup NEVER breaks the serving
    // path — the policy-resolved point serves with a warn.
    try {
      const guaranteeOverride = await resolveGuaranteeOverride(
        ctx,
        auth.org.orgId,
        clusterId,
        frontier,
        (msg) => app.log.warn(msg),
      );
      if (guaranteeOverride) op = { ...op, config: guaranteeOverride };
    } catch (err) {
      app.log.warn(err, 'guarantee override lookup failed — serving the policy-resolved point');
    }
    // ---- end M3 #22 guarantee override ----
    const sh = strategyHash(op.config);
    logBase.strategyHash = sh;
    logBase.frontierVersion = op.frontierVersion;
    const trace =
      traceHeaderValue({
        clusterId,
        strategyHash8: sh.slice(0, 8),
        frontierVersion: op.frontierVersion,
        policyType: policy.type,
        fallback: op.fallback,
        provenance,
      }) + (policyOverrideName !== null ? `;policy_override=${policyOverrideName}` : '');
    logBase.trace = trace;
    void reply.header('x-frontier-trace', trace);
    // ---- M3 #26 observability (m3-observability) ----
    // One frontier-decision observation per served request, next to where
    // the trace header is built (same inputs).
    ctx.observability?.meter.observeFrontierDecision({
      clusterId,
      strategyHash: sh,
      fallback: op.fallback === 1,
      provenance,
    });
    // ---- end M3 #26 observability ----

    // ---- M3 #21 shadow (m3-shadow) — sampling decision ----
    // Policies with a shadow config (SPEC §12.4): decide per-request whether
    // this request is shadow-sampled. The decision happens BEFORE execution
    // so the observeShadow metric sees BOTH outcomes for every shadow-policy
    // request; the shadow run itself fires AFTER the response is sent
    // (5a/5b below) and never touches the primary latency path.
    const shadowCfg = policy.shadow ?? null;
    const shadowSampled = shadowCfg !== null && shouldSample(shadowCfg);
    if (shadowCfg) {
      ctx.observability?.meter.observeShadow?.({ clusterId, sampled: shadowSampled });
    }
    // ---- end M3 #21 shadow sampling ----

    // ---- M3 #22 guarantee (m3-guarantee) — sampling decision ----
    // Policies with a guarantee config (SPEC §12.5): per-request decision on
    // whether this request's SERVED answer gets quality-scored. The sample
    // itself runs AFTER the response is sent (5a/5b below, next to the
    // shadow trigger) and never touches the primary latency path.
    const guaranteeCfg = policy.guarantee ?? null;
    const guaranteeSampled = guaranteeCfg !== null && shouldSampleGuarantee(guaranteeCfg);
    // ---- end M3 #22 guarantee sampling ----

    // ---- 4b. M3 #25 tool-calling passthrough gate ----
    // tools/tool_choice are forwarded UNMODIFIED to the provider — but ONLY
    // through the 'single' strategy: composite strategies transform prompts
    // (fan-out, judges, decomposers) and cannot guarantee tool semantics, so
    // a tool request routed to one is a client-visible 400, not a silent
    // degradation. tool_choice without tools is meaningless (OpenAI 400s too).
    if (body.tool_choice !== undefined && body.tools === undefined) {
      await logRequest({ ...logBase, status: 'invalid_request', latencyMs: elapsed() });
      return reply
        .code(400)
        .send(
          openAiError(
            "'tool_choice' requires 'tools' to be set",
            'invalid_request_error',
            'invalid_request_error',
            'tool_choice',
          ),
        );
    }
    if (body.tools !== undefined && op.config.type !== 'single') {
      await logRequest({ ...logBase, status: 'invalid_request', latencyMs: elapsed() });
      return reply
        .code(400)
        .send(
          openAiError(
            `tools/tool_choice are only supported on 'single' strategies — the operating ` +
              `point resolved to '${op.config.type}', which transforms prompts and cannot ` +
              `guarantee tool semantics (choose a policy whose frontier point is 'single')`,
            'invalid_request_error',
            'invalid_request_error',
            'tools',
          ),
        );
    }

    const id = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const created = Math.floor(Date.now() / 1000);
    // BYOK serving path (M2 Wave 2, ROADMAP #16): resolve the provider set
    // for the request's ORG — an org with active provider keys is served by
    // providers built from its DECRYPTED keys (decrypts audited in
    // custody_audit, cached 60s per org); everyone else gets the platform
    // boot set. Platform env keys remain the per-provider fallback.
    const orgProviders = await ctx.providersForOrg(auth.org.orgId);
    const execBase = {
      providers: orgProviders.providers,
      prices: ctx.prices,
      resolve: orgProviders.resolve,
      ...(body.tools !== undefined
        ? {
            params: {
              tools: body.tools,
              ...(body.tool_choice !== undefined ? { toolChoice: body.tool_choice } : {}),
            },
          }
        : {}),
    };
    const wantStream = body.stream === true;
    const includeUsage = body.stream_options?.include_usage === true;

    // ---- 5a. SSE path: stream:true + single strategy ----
    if (wantStream && op.config.type === 'single') {
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-frontier-trace': trace,
        // M3 #26 observability: echo the request id (hijacked responses
        // bypass the plugin's onSend hook).
        'x-request-id': req.id,
      });
      const base = { id, created, model: body.model };
      const writeData = (obj: unknown): void => {
        reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`);
      };
      writeData(sseChunk(base, { role: 'assistant' }));
      let result;
      try {
        result = await execute(op.config, body.messages as ChatMessage[], {
          ...execBase,
          stream: (token) => writeData(sseChunk(base, { content: token })),
        });
      } catch (err) {
        // M3 #25: mid-stream provider failure → OpenAI error parity shape.
        // M4 #33: breaker fast-reject → breaker_open alert (edge-deduped).
        notifyBreakerOpen(ctx, auth.org.orgId, err, (m) => app.log.warn(m));
        writeData(openAiError((err as Error).message, 'service_unavailable', 'service_unavailable'));
        reply.raw.write('data: [DONE]\n\n');
        reply.raw.end();
        await logRequest({ ...logBase, status: 'error', latencyMs: elapsed() });
        return;
      }
      // M3 #25: provider tool_calls stream as tool_calls delta chunks with
      // finish_reason 'tool_calls' (OpenAI chunk format).
      if (result.toolCalls) {
        writeData(sseChunk(base, { tool_calls: toolCallDeltas(result.toolCalls) }));
      }
      writeData(sseChunk(base, {}, result.toolCalls ? 'tool_calls' : 'stop'));
      // M3 #25: stream_options.include_usage → final usage-only chunk
      // (choices: []) per the OpenAI spec, before [DONE].
      if (includeUsage) {
        writeData(sseUsageChunk(base, openAiUsage(result.usage)));
      }
      reply.raw.write('data: [DONE]\n\n');
      reply.raw.end();
      await logRequest({ ...logBase, status: 'ok', usage: result.usage, latencyMs: elapsed() });
      // ---- M3 #21 shadow (m3-shadow) ----
      // Stream fully ended above ([DONE] + end): the shadow run executes
      // strictly AFTER the primary response, fire-and-forget with a
      // catch-all — a shadow failure can never affect the served stream.
      if (shadowCfg && shadowSampled) {
        void runShadow(
          ctx,
          {
            orgId: auth.org.orgId,
            requestId: id,
            clusterId,
            messages: body.messages as ChatMessage[],
            primary: { hash: sh, text: result.text },
            shadow: shadowCfg,
            frontier,
            orgProviders,
          },
          (msg) => app.log.warn(msg),
        ).catch((err) => app.log.warn(err, 'shadow run failed (stream) — swallowed'));
      }
      // ---- end M3 #21 shadow ----
      // ---- M3 #22 guarantee (m3-guarantee) ----
      // Stream fully ended above ([DONE] + end): the guarantee sample is
      // scored strictly AFTER the primary response, fire-and-forget with a
      // catch-all — same latency contract as the shadow run.
      if (guaranteeCfg && guaranteeSampled) {
        void runGuaranteeSample(
          ctx,
          {
            orgId: auth.org.orgId,
            requestId: id,
            clusterId,
            messages: body.messages as ChatMessage[],
            policy,
            policyId,
            orgProviders,
            served: { hash: sh, text: result.text },
          },
          (msg) => app.log.warn(msg),
        ).catch((err) => app.log.warn(err, 'guarantee sample failed (stream) — swallowed'));
      }
      // ---- end M3 #22 guarantee ----
      return;
    }

    // ---- M3 #23 composite (m3-composite) ----
    // SSE path: stream:true + composite strategy (SPEC §12.6). The composite
    // interpreter makes its keep/upgrade decision BEFORE any client token is
    // emitted (provider confidence resolves at completion; see
    // packages/strategies/src/composite.ts), so token chunks are captured
    // during execute() and flushed afterwards — this lets x-frontier-trace
    // carry the final upgraded=0|1 flag (HTTP headers precede the body) while
    // the client still receives ONE coherent OpenAI-shaped SSE token stream
    // with no meta-commentary at the upgrade boundary. Chunk framing reuses
    // the 'single' plumbing above; tool_calls never occur (composite refuses
    // tools at the 4b gate).
    if (wantStream && op.config.type === 'composite') {
      reply.hijack();
      const base = { id, created, model: body.model };
      const writeData = (obj: unknown): void => {
        reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`);
      };
      const captured: string[] = [];
      let result;
      try {
        result = await execute(op.config, body.messages as ChatMessage[], {
          ...execBase,
          stream: (token) => captured.push(token),
        });
      } catch (err) {
        // Mid-execution provider failure → OpenAI error parity shape (same
        // contract as the 'single' SSE path). Headers not yet sent, so the
        // base trace (upgraded unknown → flag omitted) is used.
        reply.raw.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'x-frontier-trace': trace,
          'x-request-id': req.id,
        });
        writeData(openAiError((err as Error).message, 'service_unavailable', 'service_unavailable'));
        reply.raw.write('data: [DONE]\n\n');
        reply.raw.end();
        await logRequest({ ...logBase, status: 'error', latencyMs: elapsed() });
        return;
      }
      // upgraded flag → trace header, NOT the stream (SPEC §12.6).
      const upgraded = result.trace.some((t) => t.decision === 'upgraded') ? 1 : 0;
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-frontier-trace': `${trace};upgraded=${upgraded}`,
        // M3 #26 observability: echo the request id (hijacked responses
        // bypass the plugin's onSend hook).
        'x-request-id': req.id,
      });
      writeData(sseChunk(base, { role: 'assistant' }));
      for (const token of captured) writeData(sseChunk(base, { content: token }));
      writeData(sseChunk(base, {}, 'stop'));
      if (includeUsage) {
        writeData(sseUsageChunk(base, openAiUsage(result.usage)));
      }
      reply.raw.write('data: [DONE]\n\n');
      reply.raw.end();
      await logRequest({ ...logBase, status: 'ok', usage: result.usage, latencyMs: elapsed() });
      return;
    }
    // ---- end M3 #23 composite (m3-composite) ----

    // ---- 5b. JSON path (non-stream, or stream:true on a non-streamable multi-call strategy) ----
    try {
      const result = await execute(op.config, body.messages as ChatMessage[], execBase);
      if (wantStream) {
        // Documented contract: non-streamable multi-call strategies (anything
        // but 'single'/'composite') cannot token-stream.
        void reply.header('x-latency-contract', 'non-streamed');
      }
      // ---- M3 #23 composite (m3-composite) ----
      // Non-stream composite: record the keep/upgrade decision on the trace
      // header too (same upgraded=0|1 contract as the SSE relay above).
      if (op.config.type === 'composite') {
        const upgraded = result.trace.some((t) => t.decision === 'upgraded') ? 1 : 0;
        void reply.header('x-frontier-trace', `${trace};upgraded=${upgraded}`);
      }
      // ---- end M3 #23 composite (m3-composite) ----
      await logRequest({ ...logBase, status: 'ok', usage: result.usage, latencyMs: elapsed() });
      const sent = reply.send({
        id,
        object: 'chat.completion',
        created,
        model: body.model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: result.text,
              // M3 #25: provider tool_calls preserved verbatim.
              ...(result.toolCalls ? { tool_calls: result.toolCalls } : {}),
            },
            finish_reason: result.toolCalls ? 'tool_calls' : 'stop',
          },
        ],
        usage: openAiUsage(result.usage),
      });
      // ---- M3 #21 shadow (m3-shadow) ----
      // Primary response handed to the transport above; shadow candidates
      // execute AFTER, fire-and-forget with a catch-all (see shadow.ts for
      // the spend-discipline + error-swallowing contract).
      if (shadowCfg && shadowSampled) {
        void runShadow(
          ctx,
          {
            orgId: auth.org.orgId,
            requestId: id,
            clusterId,
            messages: body.messages as ChatMessage[],
            primary: { hash: sh, text: result.text },
            shadow: shadowCfg,
            frontier,
            orgProviders,
          },
          (msg) => app.log.warn(msg),
        ).catch((err) => app.log.warn(err, 'shadow run failed — swallowed'));
      }
      // ---- end M3 #21 shadow ----
      // ---- M3 #22 guarantee (m3-guarantee) ----
      // Primary response handed to the transport above; the guarantee sample
      // is scored AFTER, fire-and-forget with a catch-all (see guarantee.ts
      // for the scoring/queue/evaluation contract).
      if (guaranteeCfg && guaranteeSampled) {
        void runGuaranteeSample(
          ctx,
          {
            orgId: auth.org.orgId,
            requestId: id,
            clusterId,
            messages: body.messages as ChatMessage[],
            policy,
            policyId,
            orgProviders,
            served: { hash: sh, text: result.text },
          },
          (msg) => app.log.warn(msg),
        ).catch((err) => app.log.warn(err, 'guarantee sample failed — swallowed'));
      }
      // ---- end M3 #22 guarantee ----
      return sent;
    } catch (err) {
      await logRequest({ ...logBase, status: 'error', latencyMs: elapsed() });
      // M4 #33: breaker fast-reject → breaker_open alert (edge-deduped).
      notifyBreakerOpen(ctx, auth.org.orgId, err, (m) => app.log.warn(m));
      // M3 #25: provider down mid-execution → 503 service_unavailable
      // (OpenAI parity; was 502 upstream_error).
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

function openAiUsage(u: Usage): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
} {
  return {
    prompt_tokens: u.inputTokens,
    completion_tokens: u.outputTokens,
    total_tokens: u.inputTokens + u.outputTokens,
  };
}
