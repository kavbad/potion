// Shared helpers for the live transports: alias resolution, system-message
// splitting and sampling params (SPEC §2).
import type { ChatMessage, PriceEntry, PriceTable } from '@potion/core';
import type { CompleteRequest } from '../types.js';
import type { RetryOptions } from '../http.js';

/** Options every live provider factory takes. */
export interface LiveProviderOptions extends RetryOptions {
  apiKey: string;
  prices: PriceTable;
}

/**
 * Resolve req.model: a prices.json alias maps to its provider-native id;
 * anything else is passed through as a native id (SPEC §2: "alias resolved
 * via PriceTable, or native id").
 */
export function resolveModel(
  prices: PriceTable,
  model: string,
): { native: string; entry?: PriceEntry } {
  const entry = prices.entries.find((e) => e.alias === model || e.model === model);
  return entry ? { native: entry.model, entry } : { native: model };
}

/** Split chat messages into concatenated system text + user/assistant turns. */
export function splitSystem(messages: ChatMessage[]): {
  system: string | undefined;
  turns: Array<{ role: 'user' | 'assistant'; content: string }>;
} {
  const systemParts: string[] = [];
  const turns: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const m of messages) {
    if (m.role === 'system') systemParts.push(m.content);
    else turns.push({ role: m.role, content: m.content });
  }
  return { system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined, turns };
}

/** Default max_tokens for live calls when params.maxTokens is absent. */
export const DEFAULT_MAX_TOKENS = 1024;

/** Normalized sampling params (exactOptionalPropertyTypes-safe). */
export function samplingParams(req: CompleteRequest): {
  temperature?: number;
  seed?: number;
  maxTokens: number;
  logprobs: boolean;
} {
  const p = req.params ?? {};
  const out: { temperature?: number; seed?: number; maxTokens: number; logprobs: boolean } = {
    maxTokens: p.maxTokens ?? DEFAULT_MAX_TOKENS,
    logprobs: p.logprobs ?? false,
  };
  if (p.temperature !== undefined) out.temperature = p.temperature;
  if (p.seed !== undefined) out.seed = p.seed;
  return out;
}
