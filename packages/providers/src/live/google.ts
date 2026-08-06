// Google (Gemini) live transport (SPEC §2): raw fetch to
// POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key=API_KEY
// ChatMessage[] → systemInstruction + contents (role 'user' | 'model').
// usageMetadata.promptTokenCount/candidatesTokenCount → Usage.
// Gemini exposes no logprobs → logprobConfidence undefined.
// embed: text-embedding-004 via :batchEmbedContents — NOTE: this model is
// 768-dim, NOT the platform-canonical 384-dim the mock embedder uses; mixing
// Google and mock embeddings in one vector space is invalid (v1).
import type { CompleteRequest, CompleteResponse, Provider } from '../types.js';
import { postJsonWithRetry } from '../http.js';
import {
  resolveModel,
  samplingParams,
  splitSystem,
  type LiveProviderOptions,
} from './common.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
export const GOOGLE_EMBED_MODEL = 'text-embedding-004';
/** Native dimension of text-embedding-004 (differs from platform-canonical 384!). */
export const GOOGLE_EMBED_DIMS = 768;

interface GeminiResponse {
  modelVersion?: string;
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

interface GeminiBatchEmbedResponse {
  embeddings?: Array<{ values?: number[] }>;
}

export function createGoogleProvider(opts: LiveProviderOptions): Provider {
  const { apiKey, prices, ...retry } = opts;
  return {
    id: 'google',

    async complete(req: CompleteRequest): Promise<CompleteResponse> {
      const started = Date.now();
      const { native } = resolveModel(prices, req.model);
      const sampling = samplingParams(req);
      const { system, turns } = splitSystem(req.messages);

      const generationConfig: Record<string, unknown> = {
        maxOutputTokens: sampling.maxTokens,
      };
      if (sampling.temperature !== undefined) generationConfig.temperature = sampling.temperature;
      if (sampling.seed !== undefined) generationConfig.seed = sampling.seed;

      const body: Record<string, unknown> = {
        contents: turns.map((t) => ({
          role: t.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: t.content }],
        })),
        generationConfig,
      };
      if (system !== undefined) body.systemInstruction = { parts: [{ text: system }] };

      const { json } = await postJsonWithRetry<GeminiResponse>(
        'google',
        {
          url: `${API_BASE}/${encodeURIComponent(native)}:generateContent?key=${encodeURIComponent(apiKey)}`,
          headers: {},
          body,
        },
        retry,
      );

      const text = (json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
      return {
        text,
        usage: {
          inputTokens: json.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: json.usageMetadata?.candidatesTokenCount ?? 0,
        },
        latencyMs: Date.now() - started,
        // Gemini returns no token logprobs → logprobConfidence stays undefined.
        modelVersion: json.modelVersion ?? native,
      };
    },

    async embed(texts: string[]): Promise<number[][]> {
      const { json } = await postJsonWithRetry<GeminiBatchEmbedResponse>(
        'google',
        {
          url: `${API_BASE}/${GOOGLE_EMBED_MODEL}:batchEmbedContents?key=${encodeURIComponent(apiKey)}`,
          headers: {},
          body: {
            requests: texts.map((text) => ({
              model: `models/${GOOGLE_EMBED_MODEL}`,
              content: { parts: [{ text }] },
            })),
          },
        },
        retry,
      );
      // 768-dim vectors — see header comment; not interchangeable with the
      // platform-canonical 384-dim mock embeddings in v1.
      return (json.embeddings ?? []).map((e) => e.values ?? []);
    },
  };
}
