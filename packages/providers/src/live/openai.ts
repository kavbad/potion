import type { SamplingParams } from '@potion/core';
// OpenAI live transport (SPEC §2): raw fetch to
// POST https://api.openai.com/v1/chat/completions (Bearer auth).
// `logprobs: true` is requested when params.logprobs is set; when token
// logprobs come back, logprobConfidence = exp(mean(token logprobs)).
// modelVersion comes from the response `model` field.
// embed: text-embedding-3-small with dimensions=384 — pinned to the
// platform-canonical 384-dim space the mock embedder defines (v1).
// M3 #25 (OpenAI parity, ADDITIVE): params.tools/tool_choice are forwarded
// UNMODIFIED in the request body and response message.tool_calls are
// preserved verbatim on CompleteResponse.toolCalls.
import type { ProviderId, ToolCall } from '@potion/core';
import type { CompleteRequest, CompleteResponse, Provider } from '../types.js';
import { postJsonWithRetry, DEFAULT_TIMEOUT_MS } from '../http.js';
import { ProviderError, ProviderTimeoutError } from '../errors.js';
import { resolveModel, samplingParams, type LiveProviderOptions } from './common.js';

export const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';
export const OPENAI_EMBED_URL = 'https://api.openai.com/v1/embeddings';
export const OPENAI_EMBED_MODEL = 'text-embedding-3-small';
/** Platform-canonical embedding dimension (matches the mock embedder). */
export const OPENAI_EMBED_DIMS = 384;

interface OpenAiChatResponse {
  model?: string;
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: ToolCall[] };
    logprobs?: { content?: Array<{ logprob?: number }> | null } | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /** OpenRouter only, and only when the request asks for it: the ACTUAL
     *  billed cost in USD for this call. */
    cost?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

interface OpenAiEmbedResponse {
  data?: Array<{ index: number; embedding: number[] }>;
}

/** Shared OpenAI-shaped chat completion; also used by OpenRouter. */
export async function openAiCompatibleComplete(
  provider: ProviderId,
  baseUrl: string,
  extraHeaders: Record<string, string>,
  opts: LiveProviderOptions,
  req: CompleteRequest,
  /** OpenAI-native chat models reject 'max_tokens' (deprecated) and require
   * 'max_completion_tokens'; OpenRouter still speaks 'max_tokens'. The cap
   * is ALWAYS sent either way (the estimator's enforced output bound). */
  tokenParam: 'max_tokens' | 'max_completion_tokens' = 'max_tokens',
): Promise<CompleteResponse> {
  const started = Date.now();
  const { native } = resolveModel(opts.prices, req.model);
  const sampling = samplingParams(req);

  const body: Record<string, unknown> = {
    model: native,
    messages: req.messages.map(wireMessage),
  };
  if (sampling.temperature !== undefined) body.temperature = sampling.temperature;
  if (sampling.seed !== undefined) body.seed = sampling.seed;
  // Always sent (DEFAULT_MAX_TOKENS when params.maxTokens is absent), like the
  // anthropic/google transports: the preflight cost projection's per-call
  // output bound is only real if every live path enforces it.
  body[tokenParam] = sampling.maxTokens;
  // Ask OpenRouter to return what it actually billed. OpenRouter ONLY — the
  // OpenAI-native endpoint shares this function and rejects unknown top-level
  // params, so sending it there would 400 every call.
  if (provider === 'openrouter') body.usage = { include: true };
  if (sampling.logprobs) body.logprobs = true;
  // M3 #25: tool-calling passthrough — forwarded UNMODIFIED.
  if (req.params?.tools !== undefined) body.tools = req.params.tools;
  if (req.params?.tool_choice !== undefined) body.tool_choice = req.params.tool_choice;
  Object.assign(body, callerSampling(req.params?.sampling));

  const { apiKey, ...retry } = opts;
  const { json } = await postJsonWithRetry<OpenAiChatResponse>(
    provider,
    {
      url: baseUrl,
      headers: { authorization: `Bearer ${apiKey}`, ...extraHeaders },
      body,
      // F19: the caller's cancellation reaches the socket.
      signal: req.signal,
    },
    retry,
  );

  const choice = json.choices?.[0];
  const tokenLogprobs = (choice?.logprobs?.content ?? [])
    .map((t) => t.logprob)
    .filter((v): v is number => typeof v === 'number');
  const logprobConfidence =
    tokenLogprobs.length > 0
      ? Math.exp(tokenLogprobs.reduce((s, v) => s + v, 0) / tokenLogprobs.length)
      : undefined;

  const toolCalls = choice?.message?.tool_calls;

  return {
    text: choice?.message?.content ?? '',
    usage: {
      inputTokens: json.usage?.prompt_tokens ?? 0,
      outputTokens: json.usage?.completion_tokens ?? 0,
      // Only set when the provider actually reported it — absent must stay
      // absent so costUsd() falls back to the modelled price rather than
      // billing a fabricated zero.
      ...(typeof json.usage?.cost === 'number' ? { providerCostUsd: json.usage.cost } : {}),
      ...(typeof json.usage?.prompt_tokens_details?.cached_tokens === 'number'
        ? { cachedInputTokens: json.usage.prompt_tokens_details.cached_tokens }
        : {}),
      ...(typeof json.usage?.completion_tokens_details?.reasoning_tokens === 'number'
        ? { reasoningTokens: json.usage.completion_tokens_details.reasoning_tokens }
        : {}),
    },
    latencyMs: Date.now() - started,
    // exactOptionalPropertyTypes: only present when the provider returned logprobs.
    ...(logprobConfidence !== undefined ? { logprobConfidence } : {}),
    modelVersion: json.model ?? native,
    // M3 #25: preserved verbatim when the provider returned tool calls.
    ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
  };
}


interface OpenAiStreamChunk {
  model?: string;
  choices?: Array<{ delta?: {
      tool_calls?: Array<{ index: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }>; content?: string | null }; finish_reason?: string | null }>;
  usage?: OpenAiChatResponse['usage'];
}

/**
 * The streaming twin of openAiCompatibleComplete: same request, plus
 * `stream: true` and `stream_options.include_usage` so the final chunk
 * carries usage (and, on OpenRouter, the billed cost). Tokens are handed to
 * `onToken` as they arrive; the resolved CompleteResponse is byte-for-byte
 * what the non-streaming call would have returned for the same answer.
 * One attempt, no retry (a stream cannot be replayed); the caller's signal
 * and the transport timeout (to first byte, then per read) both abort it.
 */
/** The wire message: text content plus the agentic fields, verbatim. */
function wireMessage(m: CompleteRequest['messages'][number]): Record<string, unknown> {
  const out: Record<string, unknown> = { role: m.role, content: m.content };
  if (m.tool_calls !== undefined) { out.tool_calls = m.tool_calls; if (m.content === '') out.content = null; }
  if (m.tool_call_id !== undefined) out.tool_call_id = m.tool_call_id;
  if (m.name !== undefined) out.name = m.name;
  return out;
}

/** Caller sampling/format parameters, OpenAI names, forwarded as-is. */
function callerSampling(p: SamplingParams | undefined): Record<string, unknown> {
  if (!p) return {};
  const out: Record<string, unknown> = {};
  for (const k of ['temperature', 'top_p', 'stop', 'seed', 'user', 'response_format', 'parallel_tool_calls'] as const) {
    if (p[k] !== undefined) out[k] = p[k];
  }
  return out;
}

export async function openAiCompatibleCompleteStream(
  provider: ProviderId,
  baseUrl: string,
  extraHeaders: Record<string, string>,
  opts: LiveProviderOptions,
  req: CompleteRequest,
  onToken: (token: string) => void,
  tokenParam: 'max_tokens' | 'max_completion_tokens' = 'max_tokens',
): Promise<CompleteResponse> {
  const started = Date.now();
  const { native } = resolveModel(opts.prices, req.model);
  const sampling = samplingParams(req);
  const body: Record<string, unknown> = {
    model: native,
    messages: req.messages.map(wireMessage),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (sampling.temperature !== undefined) body.temperature = sampling.temperature;
  if (sampling.seed !== undefined) body.seed = sampling.seed;
  body[tokenParam] = sampling.maxTokens;
  if (provider === 'openrouter') body.usage = { include: true };
  // Tools ride the stream exactly as the non-streaming body carries them
  // (found live 2026-08-23: a reasoning model, never shown the tool, spent
  // its whole budget thinking and the stream ended empty).
  if (req.params?.tools !== undefined) body.tools = req.params.tools;
  if (req.params?.tool_choice !== undefined) body.tool_choice = req.params.tool_choice;
  Object.assign(body, callerSampling(req.params?.sampling));

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort();
  req.signal?.addEventListener('abort', onCallerAbort, { once: true });
  if (req.signal?.aborted === true) controller.abort();
  let timer = setTimeout(() => controller.abort(), timeoutMs);
  const armTimer = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), timeoutMs); };
  const fetchFn = opts.fetchFn ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  try {
    const res = await fetchFn(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.apiKey}`, ...extraHeaders },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new ProviderError(provider, `HTTP ${res.status}: ${text.slice(0, 200)}`, { status: res.status });
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let text = '';
    let model: string | undefined;
    let usage: OpenAiChatResponse['usage'];
    const calls = new Map<number, { id: string; type: string; function: { name: string; arguments: string } }>();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      armTimer();
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let chunk: OpenAiStreamChunk;
        try { chunk = JSON.parse(payload) as OpenAiStreamChunk; } catch { continue; }
        if (chunk.model) model = chunk.model;
        const delta = chunk.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) { text += delta; onToken(delta); }
        // Tool-call fragments (2026-08-22): OpenAI streams each call as an
        // index-keyed series — id/name once, arguments in pieces. Assembled
        // here and returned whole on the response, the same shape the
        // non-streaming path preserves verbatim.
        for (const frag of chunk.choices?.[0]?.delta?.tool_calls ?? []) {
          const cur = calls.get(frag.index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (frag.id) cur.id = frag.id;
          if (frag.type) cur.type = frag.type;
          if (frag.function?.name) cur.function.name += frag.function.name;
          if (frag.function?.arguments) cur.function.arguments += frag.function.arguments;
          calls.set(frag.index, cur);
        }
        if (chunk.usage) usage = chunk.usage;
      }
    }
    const toolCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c) as ToolCall[];
    return {
      text,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      usage: {
        inputTokens: usage?.prompt_tokens ?? 0,
        outputTokens: usage?.completion_tokens ?? 0,
        ...(typeof usage?.cost === 'number' ? { providerCostUsd: usage.cost } : {}),
        ...(typeof usage?.prompt_tokens_details?.cached_tokens === 'number' ? { cachedInputTokens: usage.prompt_tokens_details.cached_tokens } : {}),
        ...(typeof usage?.completion_tokens_details?.reasoning_tokens === 'number' ? { reasoningTokens: usage.completion_tokens_details.reasoning_tokens } : {}),
      },
      latencyMs: Date.now() - started,
      modelVersion: model ?? native,
    };
  } catch (err) {
    if (controller.signal.aborted && req.signal?.aborted !== true) {
      throw new ProviderTimeoutError(provider, timeoutMs, { cause: err });
    }
    throw err;
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener('abort', onCallerAbort);
  }
}

export function createOpenAiProvider(opts: LiveProviderOptions): Provider {
  const { apiKey, ...retry } = opts;
  return {
    id: 'openai',

    complete: (req) =>
      openAiCompatibleComplete('openai', OPENAI_CHAT_URL, {}, opts, req, 'max_completion_tokens'),
    completeStream: (req, onToken) =>
      openAiCompatibleCompleteStream('openai', OPENAI_CHAT_URL, {}, opts, req, onToken, 'max_completion_tokens'),

    async embed(texts: string[]): Promise<number[][]> {
      const { json } = await postJsonWithRetry<OpenAiEmbedResponse>(
        'openai',
        {
          url: OPENAI_EMBED_URL,
          headers: { authorization: `Bearer ${apiKey}` },
          body: {
            model: OPENAI_EMBED_MODEL,
            input: texts,
            // Pin to the platform-canonical 384-dim (same as the mock embedder).
            dimensions: OPENAI_EMBED_DIMS,
          },
        },
        retry,
      );
      const data = [...(json.data ?? [])].sort((a, b) => a.index - b.index);
      return data.map((d) => d.embedding);
    },
  };
}
