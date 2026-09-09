// Anthropic live transport (SPEC §2): raw fetch to
// POST https://api.anthropic.com/v1/messages.
// ChatMessage[] → `system` string + `messages` (user/assistant turns).
// usage.input_tokens/output_tokens → Usage. Anthropic exposes no logprobs,
// so logprobConfidence is always undefined.
// embed: intentionally undefined — Anthropic has no embeddings API (v1).
import { ProviderEffortRefusalError } from '../errors.js';
import type { CompleteRequest, CompleteResponse, Provider } from '../types.js';
import { postJsonWithRetry } from '../http.js';
import { effortRefusal, resolveModel, samplingParams, splitSystem, thinkingBudgetFor, type LiveProviderOptions } from './common.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

interface AnthropicResponse {
  model?: string;
  content?: Array<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export function createAnthropicProvider(opts: LiveProviderOptions): Provider {
  const { apiKey, prices, ...retry } = opts;
  return {
    id: 'anthropic',

    async complete(req: CompleteRequest): Promise<CompleteResponse> {
      const started = Date.now();
      const { native } = resolveModel(prices, req.model);
      const sampling = samplingParams(req);
      const { system, turns } = splitSystem(req.messages);

      const body: Record<string, unknown> = {
        model: native,
        max_tokens: sampling.maxTokens,
        messages: turns,
      };
      if (system !== undefined) body.system = system;
      if (sampling.temperature !== undefined) body.temperature = sampling.temperature;
      // C4: effort as a THINKING BUDGET. Refuse rather than answer without it.
      if (req.params?.reasoningEffort !== undefined) {
        const budget = thinkingBudgetFor(req.params.reasoningEffort, sampling.maxTokens);
        if (budget === null) {
          throw new ProviderEffortRefusalError('anthropic', effortRefusal('anthropic', req.params.reasoningEffort, sampling.maxTokens));
        }
        body.thinking = { type: 'enabled', budget_tokens: budget };
      }

      const { json } = await postJsonWithRetry<AnthropicResponse>(
        'anthropic',
        {
          url: API_URL,
          headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
          body,
          // F19: the caller's cancellation reaches the socket.
          signal: req.signal,
        },
        retry,
      );

      const text = (json.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('');
      return {
        text,
        usage: {
          inputTokens: json.usage?.input_tokens ?? 0,
          outputTokens: json.usage?.output_tokens ?? 0,
        },
        latencyMs: Date.now() - started,
        // Anthropic returns no token logprobs → logprobConfidence stays undefined.
        modelVersion: json.model ?? native,
      };
    },

    // embed intentionally undefined: Anthropic has no embeddings endpoint (v1).
  };
}
