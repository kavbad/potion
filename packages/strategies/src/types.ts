// Strategy interpreter contract — EXACTLY per SPEC.md §3.
// M3 #25 (OpenAI parity, ADDITIVE): ExecContext gains an optional tool-call
// passthrough (`params.tools` / `params.toolChoice`) honored ONLY by
// 'single' — composite strategies transform prompts and cannot guarantee
// tool semantics, so the server refuses tools on them with a 400 before
// execution. StrategyResult gains optional `toolCalls` (provider-verbatim).
import type {
  ChatMessage,
  PriceEntry,
  PriceTable,
  ProviderId,
  StrategyConfig,
  Tool,
  ToolCall,
  ToolChoice,
  Usage,
} from '@potion/core';
import type { Provider } from '@potion/providers';

export interface StageTrace {
  stage: string;
  model: string;
  text: string;
  usage: Usage;
  confidence?: number;
  decision?: string;
}

export interface StrategyResult {
  text: string;
  trace: StageTrace[];
  usage: Usage;
  /** Provider-returned tool calls, preserved verbatim (M3 #25; 'single' only). */
  toolCalls?: ToolCall[];
}

export interface ExecContext {
  providers: Record<ProviderId, Provider>;
  prices: PriceTable;
  resolve(model: string): { provider: Provider; entry: PriceEntry }; // alias → provider+price
  seed?: number;
  // stream honored by 'single' and 'composite' (M3 #23, SPEC §12.6) only.
  stream?: (token: string) => void;
  /** Tool-calling passthrough (M3 #25; 'single' only): forwarded UNMODIFIED
   * to the provider's CompleteRequest.params. */
  params?: { tools?: Tool[]; toolChoice?: ToolChoice };
}

export type { ChatMessage, StrategyConfig };
