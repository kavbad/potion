// Shared helpers for the live transports: alias resolution, system-message
// splitting and sampling params (SPEC §2).
import { REASONING_BUDGET_TOKENS } from '@potion/core';
import type { ReasoningEffort } from '@potion/core';
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
    // Anthropic/Google transports do not serve tool loops; a tool-result
    // turn is presented as user text there.
    else turns.push({ role: m.role === 'tool' ? 'user' : m.role, content: m.content });
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


/**
 * C4: token budgets for the transports that express reasoning effort as a
 * NUMBER rather than a word (Anthropic `thinking.budget_tokens`, Google
 * `thinkingConfig.thinkingBudget`).
 *
 * Anthropic requires budget_tokens >= 1024 AND max_tokens > budget_tokens. A
 * request whose output budget cannot hold the thinking budget cannot honor the
 * effort, and answering anyway would record thought that never happened — so
 * this returns null and the caller REFUSES.
 */
export const MIN_THINKING_BUDGET = 1024;

export function thinkingBudgetFor(effort: ReasoningEffort, maxTokens: number): number | null {
  const wanted = REASONING_BUDGET_TOKENS[effort];
  const affordable = Math.min(wanted, maxTokens - 1);
  return affordable >= MIN_THINKING_BUDGET ? affordable : null;
}

/** The message a transport uses when it cannot honor an effort request. */
export function effortRefusal(provider: string, effort: ReasoningEffort, maxTokens: number): string {
  return (
    `provider '${provider}': cannot honor reasoningEffort '${effort}' within an output budget of ` +
    `${maxTokens} tokens (thinking needs at least ${MIN_THINKING_BUDGET}, and the budget must fit ` +
    `strictly inside max_tokens) — refusing rather than answering without thinking, which would be ` +
    `recorded as effort that never happened`
  );
}
