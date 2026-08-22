// `single` strategy interpreter (SPEC §3): one call; streams via ctx.stream.
// M3 #25: tool-call passthrough (ctx.params → provider) + toolCalls result.
import { costUsd, roundCost } from '@potion/core';
import type { ChatMessage, Usage } from '@potion/core';
import type { CompleteRequest } from '@potion/providers';
import type { ExecContext, StageTrace, StrategyResult } from './types.js';

/** Split text into deterministic stream chunks (word + trailing whitespace). */
export function streamChunks(text: string): string[] {
  return text.match(/\S+\s*/g) ?? [];
}

export async function runSingle(
  model: string,
  messages: ChatMessage[],
  ctx: ExecContext,
): Promise<StrategyResult> {
  const { provider, entry } = ctx.resolve(model);
  // M3 #25: ctx.params (tools/toolChoice) is forwarded UNMODIFIED into the
  // provider request — 'single' is the only strategy that can guarantee
  // tool semantics because it never transforms the prompt.
  const params: CompleteRequest['params'] = {
    ...(ctx.seed !== undefined ? { seed: ctx.seed } : {}),
    ...(ctx.maxOutputTokens !== undefined ? { maxTokens: ctx.maxOutputTokens } : {}),
    ...(ctx.params?.tools !== undefined ? { tools: ctx.params.tools } : {}),
    ...(ctx.params?.toolChoice !== undefined ? { tool_choice: ctx.params.toolChoice } : {}),
    ...(ctx.captureConfidence ? { logprobs: true } : {}),
  };
  const response = await provider.complete({
    model,
    messages,
    ...(Object.keys(params).length > 0 ? { params } : {}),
  });

  if (ctx.stream) {
    for (const chunk of streamChunks(response.text)) ctx.stream(chunk);
  }

  const usage: Usage = {
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    costUsd: roundCost(costUsd(response.usage, entry)),
    latencyMs: response.latencyMs,
  };

  const trace: StageTrace = {
    stage: 'single',
    model,
    text: response.text,
    usage,
    ...(response.logprobConfidence !== undefined
      ? { confidence: response.logprobConfidence }
      : {}),
  };

  return {
    text: response.text,
    trace: [trace],
    usage,
    ...(response.toolCalls !== undefined && response.toolCalls.length > 0
      ? { toolCalls: response.toolCalls }
      : {}),
  };
}
