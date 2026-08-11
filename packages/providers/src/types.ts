// Provider contract types — EXACTLY per SPEC.md §2.
// M3 #25 (OpenAI parity, ADDITIVE): CompleteRequest.params gains optional
// tools/tool_choice passthrough and CompleteResponse gains optional
// toolCalls — all optional, backward-compatible with the §2 contract.
import type { ChatMessage, PriceTable, ProviderId, Tool, ToolCall, ToolChoice } from '@potion/core';
// type-only, so the resilience <-> types cycle never exists at runtime
import type { BreakerPolicy } from './resilience.js';

export interface CompleteRequest {
  model: string; // alias resolved via PriceTable, or native id
  messages: ChatMessage[];
  params?: {
    temperature?: number;
    maxTokens?: number;
    seed?: number;
    logprobs?: boolean;
    /** OpenAI function-calling passthrough (M3 #25): forwarded UNMODIFIED to
     * the provider; only honored on the 'single' strategy serving path. */
    tools?: Tool[];
    tool_choice?: ToolChoice;
  };
  // M3 (SPEC §12.1, additive): optional cancellation signal threaded by the
  // resilience wrapper (per-attempt timeout / hedge loser abort). Providers
  // that ignore it keep working unchanged; chaosProvider honors it.
  signal?: AbortSignal;
}

export interface CompleteResponse {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
  latencyMs: number;
  logprobConfidence?: number; // mean token logprob → exp, when provider exposes it
  modelVersion: string; // resolved concrete version
  // M3 (SPEC §12.1, additive): trace flag set by the resilience wrapper when a
  // hedged duplicate call was started for this request (winner's usage only).
  hedged?: boolean;
  /** Provider-returned tool calls (M3 #25), preserved verbatim. */
  toolCalls?: ToolCall[];
}

export interface Provider {
  id: ProviderId;
  complete(req: CompleteRequest): Promise<CompleteResponse>;
  embed?(texts: string[]): Promise<number[][]>; // providers without embeddings leave undefined
}

export interface ProviderFactoryOptions {
  apiKeys?: Partial<Record<ProviderId, string>>;
  timeoutMs?: number;
  maxRetries?: number;
  prices: PriceTable;
  /** F19: circuit-breaker policy. Omitted → resolved from the environment
   * (DEFAULT_BREAKER, or none when POTION_BREAKER=off). Pass `null` to
   * disable it explicitly — tests that assert the pre-F19 behavior, and
   * anything that must not carry breaker state across cases, use that. */
  breaker?: BreakerPolicy | null;
}
