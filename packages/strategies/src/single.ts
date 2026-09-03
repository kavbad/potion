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
    ...(ctx.sampling !== undefined ? { sampling: ctx.sampling } : {}),
  };
  const request = {
    model,
    messages,
    ...(Object.keys(params).length > 0 ? { params } : {}),
  };
  // Real streaming when the caller wants tokens and the transport can relay
  // them (2026-08-22). Confidence capture needs the complete response's
  // logprobs, so it keeps the non-streaming call and replays the text.
  // Tool calls relay too (2026-08-22): the transport assembles the call
  // fragments and returns them whole, so the text streams live and the
  // calls arrive on the response exactly as the JSON path delivers them.
  const canRelay = ctx.stream !== undefined && provider.completeStream !== undefined && !ctx.captureConfidence;
  const response = canRelay
    ? await provider.completeStream!(request, ctx.stream!)
    : await provider.complete(request);

  if (ctx.stream && !canRelay) {
    for (const chunk of streamChunks(response.text)) ctx.stream(chunk);
  }

  const usage: Usage = {
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    costUsd: roundCost(costUsd(response.usage, entry)),
    latencyMs: response.latencyMs,
    ...(response.usage.usageEstimated ? { usageEstimated: true as const } : {}),
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
    ...(response.finishReason !== undefined ? { finishReason: response.finishReason } : {}),
    text: response.text,
    trace: [trace],
    usage,
    ...(response.toolCalls !== undefined && response.toolCalls.length > 0
      ? { toolCalls: response.toolCalls }
      : {}),
  };
}
