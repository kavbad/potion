// `best-of-n` strategy interpreter (SPEC §3): n completions from the same
// model with seed variation (seed, seed+1, ...), then ONE judge call that
// must return `PICK: <index>`; the picked candidate is the result. Trace
// records all candidates + the judge pick. Usage/cost aggregated across all
// calls; candidate fan-out latency = max (parallel), judge adds sequentially.
import type { ChatMessage, StrategyConfig } from '@potion/core';
import { PROTOCOL_MAX_TOKENS } from '@potion/core';
import {
  addUsage,
  addUsageParallel,
  baseSeedOf,
  buildJudgeMessages,
  callModel,
  parsePick,
  zeroUsage,
} from './helpers.js';
import type { ExecContext, StageTrace, StrategyResult } from './types.js';

type BestOfNConfig = Extract<StrategyConfig, { type: 'best-of-n' }>;

export async function runBestOfN(
  strategy: BestOfNConfig,
  messages: ChatMessage[],
  ctx: ExecContext,
): Promise<StrategyResult> {
  if (strategy.n < 1) throw new Error('best-of-n requires n >= 1');
  const baseSeed = baseSeedOf(ctx, messages);
  const trace: StageTrace[] = [];
  const total = zeroUsage();

  // n parallel completions, seeds baseSeed+0 .. baseSeed+n-1.
  const candidates = await Promise.all(
    Array.from({ length: strategy.n }, (_, i) =>
      callModel(strategy.model, messages, ctx, baseSeed + i)),
  );
  candidates.forEach((c, i) => {
    addUsageParallel(total, c.usage);
    trace.push({
      stage: `candidate-${i}`,
      model: strategy.model,
      text: c.text,
      usage: c.usage,
      ...(c.logprobConfidence !== undefined ? { confidence: c.logprobConfidence } : {}),
    });
  });

  // One judge call (seed baseSeed+n) → `PICK: <index>`.
  const judgeOutcome = await callModel(
    strategy.judge.model,
    buildJudgeMessages(messages, candidates.map((c) => c.text), strategy.judge.rubric),
    ctx,
    baseSeed + strategy.n,
    { maxTokens: PROTOCOL_MAX_TOKENS },
  );
  addUsage(total, judgeOutcome.usage);
  const { index, parsed } = parsePick(judgeOutcome.text, strategy.n);
  trace.push({
    stage: 'judge',
    model: strategy.judge.model,
    text: judgeOutcome.text,
    usage: judgeOutcome.usage,
    decision: `pick:${index}${parsed ? '' : ';unparseable-judge-answer-default-0'}`,
  });

  return { text: candidates[index]!.text, trace, usage: total };
}
