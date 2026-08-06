// `draft-verify` strategy interpreter (SPEC §3): the draft model answers;
// the verifier model receives the original messages + draft and returns the
// corrected final answer. Trace records draft + verification; usage/cost
// aggregated across both calls (sequential → latency summed).
import type { ChatMessage, StrategyConfig } from '@potion/core';
import { addUsage, baseSeedOf, callModel, zeroUsage } from './helpers.js';
import type { ExecContext, StageTrace, StrategyResult } from './types.js';

type DraftVerifyConfig = Extract<StrategyConfig, { type: 'draft-verify' }>;

export function buildVerifyMessages(original: ChatMessage[], draft: string): ChatMessage[] {
  return [
    ...original,
    { role: 'assistant', content: draft },
    {
      role: 'user',
      content:
        'Verify the draft answer above for correctness and completeness. ' +
        'If anything is wrong or missing, correct it. Return only the final corrected answer.',
    },
  ];
}

export async function runDraftVerify(
  strategy: DraftVerifyConfig,
  messages: ChatMessage[],
  ctx: ExecContext,
): Promise<StrategyResult> {
  const baseSeed = baseSeedOf(ctx, messages);
  const trace: StageTrace[] = [];
  const total = zeroUsage();

  const draft = await callModel(strategy.draftModel, messages, ctx, baseSeed);
  addUsage(total, draft.usage);
  trace.push({
    stage: 'draft',
    model: strategy.draftModel,
    text: draft.text,
    usage: draft.usage,
    ...(draft.logprobConfidence !== undefined ? { confidence: draft.logprobConfidence } : {}),
  });

  const verified = await callModel(
    strategy.verifierModel,
    buildVerifyMessages(messages, draft.text),
    ctx,
    baseSeed + 1,
  );
  addUsage(total, verified.usage);
  trace.push({
    stage: 'verify',
    model: strategy.verifierModel,
    text: verified.text,
    usage: verified.usage,
    ...(verified.logprobConfidence !== undefined
      ? { confidence: verified.logprobConfidence }
      : {}),
    decision: 'final',
  });

  return { text: verified.text, trace, usage: total };
}
