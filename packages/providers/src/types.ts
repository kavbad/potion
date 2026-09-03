import type { SamplingParams } from '@potion/core';
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
    /** Caller sampling/format parameters (2026-08-23), forwarded as-is. */
    sampling?: SamplingParams;
  };
  // M3 (SPEC §12.1, additive): optional cancellation signal threaded by the
  // resilience wrapper (per-attempt timeout / hedge loser abort). Providers
  // that ignore it keep working unchanged; chaosProvider honors it.
  signal?: AbortSignal;
}

export interface CompleteResponse {
  text: string;
  /** The provider's finish reason, passed through (2026-08-23). 'length'
   * means the output budget was exhausted — a reasoning model can spend a
   * customer-sized max_tokens entirely on thinking and answer nothing. */
  finishReason?: 'stop' | 'length' | 'tool_calls' | 'content_filter';
  usage: {
    inputTokens: number;
    outputTokens: number;
    /**
     * The provider's OWN billed cost for this call, in USD, when the
     * transport reports one (OpenRouter does; Anthropic/Google native do
     * not). Absent means "the provider did not tell us" — never zero, which
     * would read as a free call. core's costUsd() prefers this over the
     * modelled price; see the reasoning there.
     */
     providerCostUsd?: number;
    /**
     * Diagnostics that EXPLAIN why a modelled cost and a billed cost differ:
     * cached input is discounted, and reasoning tokens can be billed while
     * sitting outside the completion count entirely (measured: gpt-5-mini
     * returned completion_tokens 0 with reasoning_tokens 107). Recorded so
     * the discrepancy is inspectable rather than mysterious.
     */
    cachedInputTokens?: number;
    reasoningTokens?: number;
    /**
     * TRUE when the transport REPLACED the provider's usage with a chars/4
     * estimate because the usage block was missing, or claimed
     * completion_tokens 0 against a non-empty payload (text or tool calls
     * came back) — the 2026-09-01 or-gemini-flash incident shape. A
     * transport must never fabricate silent zeros: zeros bill real spend at
     * $0 and make the serving degeneracy rollup read a text-bearing answer
     * as an empty completion. Absent = the provider's own numbers.
     */
    usageEstimated?: true;
  };
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
  /**
   * Real token streaming (2026-08-22): relays the provider's own stream,
   * calling `onToken` as deltas arrive, and resolves to the same
   * CompleteResponse `complete` would return (text, usage, billed cost).
   * Optional: transports without it fall back to complete() and the
   * strategy replays the finished text, which is what every live path did
   * before this — and why a streaming client saw a two-second silence then a
   * burst (found by dogfooding the docs assistant).
   */
  completeStream?(req: CompleteRequest, onToken: (token: string) => void): Promise<CompleteResponse>;
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
