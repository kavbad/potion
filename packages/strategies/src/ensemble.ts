// `ensemble` strategy interpreter (SPEC §3): all models in parallel
// (Promise.all), then fusion per FusionConfig:
//  - 'judge-pick'   : one judge call returns `PICK: <index>`; that candidate wins.
//  - 'concat-rank'  : deterministic ranking (see concatRankScore in helpers.ts:
//                     confidence primary, length tiebreak, stable) and the
//                     candidates are concatenated in ranked order with headers.
// Usage/cost aggregated across all calls; candidate fan-out latency = max.
import type { ChatMessage, StrategyConfig } from '@potion/core';
import {
  addUsage,
  addUsageParallel,
  baseSeedOf,
  buildJudgeMessages,
  callModel,
  parsePick,
  rankIndices,
  zeroUsage,
} from './helpers.js';
import type { ExecContext, StageTrace, StrategyResult } from './types.js';

type EnsembleConfig = Extract<StrategyConfig, { type: 'ensemble' }>;

export async function runEnsemble(
  strategy: EnsembleConfig,
  messages: ChatMessage[],
  ctx: ExecContext,
): Promise<StrategyResult> {
  if (strategy.models.length === 0) throw new Error('ensemble requires at least one model');
  const baseSeed = baseSeedOf(ctx, messages);
  const trace: StageTrace[] = [];
  const total = zeroUsage();

  const candidates = await Promise.all(
    strategy.models.map((model, i) => callModel(model, messages, ctx, baseSeed + i)),
  );
  candidates.forEach((c, i) => {
    addUsageParallel(total, c.usage);
    trace.push({
      stage: `candidate-${i}`,
      model: strategy.models[i]!,
      text: c.text,
      usage: c.usage,
      ...(c.logprobConfidence !== undefined ? { confidence: c.logprobConfidence } : {}),
    });
  });

  if (strategy.fusion.method === 'judge-pick') {
    const judge = strategy.fusion.judge;
    if (!judge) throw new Error("ensemble fusion 'judge-pick' requires fusion.judge");
    const judgeOutcome = await callModel(
      judge.model,
      buildJudgeMessages(messages, candidates.map((c) => c.text), judge.rubric),
      ctx,
      baseSeed + strategy.models.length,
    );
    addUsage(total, judgeOutcome.usage);
    const { index, parsed } = parsePick(judgeOutcome.text, candidates.length);
    trace.push({
      stage: 'fusion-judge',
      model: judge.model,
      text: judgeOutcome.text,
      usage: judgeOutcome.usage,
      decision: `judge-pick:${index}${parsed ? '' : ';unparseable-judge-answer-default-0'}`,
    });
    return { text: candidates[index]!.text, trace, usage: total };
  }

  // concat-rank: deterministic, no extra calls.
  const order = rankIndices(candidates);
  const text = order
    .map((idx, rank) => `## ${strategy.models[idx]} (rank ${rank + 1})\n${candidates[idx]!.text}`)
    .join('\n\n');
  trace.push({
    stage: 'fusion',
    model: 'deterministic',
    text,
    usage: zeroUsage(),
    decision: `concat-rank:order=[${order.join(',')}]`,
  });
  return { text, trace, usage: total };
}
