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
import { postJsonWithRetry } from '../http.js';
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
  usage?: { prompt_tokens?: number; completion_tokens?: number };
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
    messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
  };
  if (sampling.temperature !== undefined) body.temperature = sampling.temperature;
  if (sampling.seed !== undefined) body.seed = sampling.seed;
  // Always sent (DEFAULT_MAX_TOKENS when params.maxTokens is absent), like the
  // anthropic/google transports: the preflight cost projection's per-call
  // output bound is only real if every live path enforces it.
  body[tokenParam] = sampling.maxTokens;
  if (sampling.logprobs) body.logprobs = true;
  // M3 #25: tool-calling passthrough — forwarded UNMODIFIED.
  if (req.params?.tools !== undefined) body.tools = req.params.tools;
  if (req.params?.tool_choice !== undefined) body.tool_choice = req.params.tool_choice;

  const { apiKey, ...retry } = opts;
  const { json } = await postJsonWithRetry<OpenAiChatResponse>(
    provider,
    {
      url: baseUrl,
      headers: { authorization: `Bearer ${apiKey}`, ...extraHeaders },
      body,
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
    },
    latencyMs: Date.now() - started,
    // exactOptionalPropertyTypes: only present when the provider returned logprobs.
    ...(logprobConfidence !== undefined ? { logprobConfidence } : {}),
    modelVersion: json.model ?? native,
    // M3 #25: preserved verbatim when the provider returned tool calls.
    ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

export function createOpenAiProvider(opts: LiveProviderOptions): Provider {
  const { apiKey, ...retry } = opts;
  return {
    id: 'openai',

    complete: (req) =>
      openAiCompatibleComplete('openai', OPENAI_CHAT_URL, {}, opts, req, 'max_completion_tokens'),

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
