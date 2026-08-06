// Preflight cost projection (SPEC §5): refuse to start a run whose PROJECTED
// spend exceeds budgetCapUsd. Documented per-strategy token model (no live
// dry-run needed — the model below is THE estimate, conservative by design):
//
//   inputTokens(item)      = ceil(promptChars / 4)            (chars/4 rule, mock-consistent)
//   OUTPUT_TOKENS_PER_CALL = 80   (≈320 chars — mock answers run 60–330 chars)
//   JUDGE_INPUT_OVERHEAD   = 80 tokens per candidate/draft embedded in a
//                            judge/verify/self-report prompt
//   calls(strategy)        = WORST CASE (cascade: every stage escalates,
//                            self-report-calibrated adds one probe per non-final stage)
//
// Cost per call = (input·inputPer1M + output·outputPer1M) / 1e6 with the
// call's model price entry. Judge/probe calls output ≈ 8 tokens.
//
// llm-judge SCORING cost (M1b): every llm-judge item adds ONE judge call per
// (strategy × item) to the projection — the judge call is real provider spend
// and the preflight cap must see it. Token model (worst-case style, mirrors
// buildJudgeScoreMessages in scorers.ts):
//   judge input = ceil((promptChars + rubricChars) / 4)   (TASK + RUBRIC blocks)
//               + JUDGE_ANSWER_TOKENS                      (ANSWER block ≈ 80 tok,
//                                                          same rule as OUTPUT_TOKENS_PER_CALL)
//               + JUDGE_TEMPLATE_TOKENS                    (fixed instruction
//                                                          scaffolding ≈ 190 chars)
//   judge output = JUDGE_OUTPUT_TOKENS (the `SCORE: <x>` line)
import type { ChatMessage, EvalItem, PriceEntry, PriceTable, StrategyConfig } from '@potion/core';

export const OUTPUT_TOKENS_PER_CALL = 80;
export const JUDGE_OUTPUT_TOKENS = 8;
export const PER_ANSWER_INPUT_OVERHEAD = 80;
/** Estimated candidate-answer block inside the llm-judge scoring prompt. */
export const JUDGE_ANSWER_TOKENS = 80;
/** Fixed llm-judge prompt scaffolding (instruction/TASK/ANSWER markers ≈ 190 chars). */
export const JUDGE_TEMPLATE_TOKENS = 48;

export function promptCharsOf(messages: ChatMessage[]): number {
  return messages.reduce((a, m) => a + m.role.length + 1 + m.content.length, 0);
}

export function inputTokensOf(item: EvalItem): number {
  return Math.ceil(promptCharsOf(item.prompt) / 4);
}

interface CallEstimate {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Worst-case per-item call plan for a strategy (model + token estimate per call).
 */
export function estimateCalls(strategy: StrategyConfig, baseInputTokens: number): CallEstimate[] {
  switch (strategy.type) {
    case 'single':
      return [{ model: strategy.model, inputTokens: baseInputTokens, outputTokens: OUTPUT_TOKENS_PER_CALL }];
    case 'cascade': {
      const calls: CallEstimate[] = [];
      const stages = strategy.stages;
      stages.forEach((stage, i) => {
        calls.push({ model: stage.model, inputTokens: baseInputTokens, outputTokens: OUTPUT_TOKENS_PER_CALL });
        const isFinal = i === stages.length - 1;
        if (!isFinal && strategy.confidenceMethod === 'self-report-calibrated' && stage.escalateIf?.confidenceBelow !== undefined) {
          calls.push({
            model: stage.model,
            inputTokens: baseInputTokens + PER_ANSWER_INPUT_OVERHEAD,
            outputTokens: JUDGE_OUTPUT_TOKENS,
          });
        }
      });
      return calls;
    }
    case 'best-of-n': {
      const calls: CallEstimate[] = [];
      for (let i = 0; i < strategy.n; i++) {
        calls.push({ model: strategy.model, inputTokens: baseInputTokens, outputTokens: OUTPUT_TOKENS_PER_CALL });
      }
      calls.push({
        model: strategy.judge.model,
        inputTokens: baseInputTokens + strategy.n * PER_ANSWER_INPUT_OVERHEAD,
        outputTokens: JUDGE_OUTPUT_TOKENS,
      });
      return calls;
    }
    case 'draft-verify':
      return [
        { model: strategy.draftModel, inputTokens: baseInputTokens, outputTokens: OUTPUT_TOKENS_PER_CALL },
        { model: strategy.verifierModel, inputTokens: baseInputTokens + PER_ANSWER_INPUT_OVERHEAD, outputTokens: OUTPUT_TOKENS_PER_CALL },
      ];
    case 'ensemble': {
      const calls: CallEstimate[] = strategy.models.map((model) => ({
        model,
        inputTokens: baseInputTokens,
        outputTokens: OUTPUT_TOKENS_PER_CALL,
      }));
      if (strategy.fusion.method === 'judge-pick' && strategy.fusion.judge) {
        calls.push({
          model: strategy.fusion.judge.model,
          inputTokens: baseInputTokens + strategy.models.length * PER_ANSWER_INPUT_OVERHEAD,
          outputTokens: JUDGE_OUTPUT_TOKENS,
        });
      }
      return calls;
    }
    case 'decompose': {
      // Estimated fan-out: 1 decompose + 3 routed subtask calls + optional judge fusion.
      const calls: CallEstimate[] = [
        { model: strategy.decomposerModel, inputTokens: baseInputTokens, outputTokens: OUTPUT_TOKENS_PER_CALL },
      ];
      const routed = [...new Set(Object.values(strategy.routing))];
      const subModel = routed[0] ?? strategy.decomposerModel;
      for (let i = 0; i < 3; i++) {
        calls.push({ model: subModel, inputTokens: baseInputTokens, outputTokens: OUTPUT_TOKENS_PER_CALL });
      }
      if (strategy.fusion?.method === 'judge-pick' && strategy.fusion.judge) {
        calls.push({
          model: strategy.fusion.judge.model,
          inputTokens: baseInputTokens + 3 * PER_ANSWER_INPUT_OVERHEAD,
          outputTokens: JUDGE_OUTPUT_TOKENS,
        });
      }
      return calls;
    }
    case 'composite': {
      // M3 #23 (SPEC §12.6), worst case: start call + self-report probe (the
      // provider exposes no logprob confidence) + the upgrade fires.
      return [
        { model: strategy.startModel, inputTokens: baseInputTokens, outputTokens: OUTPUT_TOKENS_PER_CALL },
        {
          model: strategy.startModel,
          inputTokens: baseInputTokens + PER_ANSWER_INPUT_OVERHEAD,
          outputTokens: JUDGE_OUTPUT_TOKENS,
        },
        {
          model: strategy.upgradeModel,
          inputTokens: baseInputTokens + PER_ANSWER_INPUT_OVERHEAD,
          outputTokens: OUTPUT_TOKENS_PER_CALL,
        },
      ];
    }
  }
}

function entryFor(prices: PriceTable, model: string): PriceEntry {
  const entry = prices.entries.find((e) => e.alias === model || e.model === model);
  if (!entry) {
    throw new Error(`unknown model '${model}' — not an alias or native id in prices.json (version ${prices.version})`);
  }
  return entry;
}

export function estimateCallCostUsd(call: CallEstimate, prices: PriceTable): number {
  const entry = entryFor(prices, call.model);
  return (call.inputTokens * entry.inputPer1M + call.outputTokens * entry.outputPer1M) / 1_000_000;
}

/**
 * Estimated llm-judge SCORING call for an item (null for deterministic
 * scorers). Mirrors buildJudgeScoreMessages: the judge prompt embeds the
 * item's task and rubric plus the candidate answer and fixed scaffolding.
 */
export function estimateJudgeScoringCall(item: EvalItem): CallEstimate | null {
  if (item.scoring.kind !== 'llm-judge') return null;
  return {
    model: item.scoring.judgeModel,
    inputTokens:
      Math.ceil((promptCharsOf(item.prompt) + item.scoring.rubric.length) / 4) +
      JUDGE_ANSWER_TOKENS +
      JUDGE_TEMPLATE_TOKENS,
    outputTokens: JUDGE_OUTPUT_TOKENS,
  };
}

/**
 * Estimated judge-scoring cost for an item: $0 for deterministic scorers,
 * one priced judge call for llm-judge items (M1b).
 */
export function estimateItemJudgeCostUsd(item: EvalItem, prices: PriceTable): number {
  const call = estimateJudgeScoringCall(item);
  return call === null ? 0 : estimateCallCostUsd(call, prices);
}

export function estimateItemCostUsd(strategy: StrategyConfig, item: EvalItem, prices: PriceTable): number {
  const base = inputTokensOf(item);
  const strategyCost = estimateCalls(strategy, base).reduce((a, c) => a + estimateCallCostUsd(c, prices), 0);
  // llm-judge items are scored once per (strategy × item) → one judge call
  // each; preflight must project that spend (M1b — previously omitted).
  return strategyCost + estimateItemJudgeCostUsd(item, prices);
}

/** Preflight projection: Σ over (item × strategy) of estimated cost, INCLUDING llm-judge scoring calls. */
export function projectRunCostUsd(
  strategies: StrategyConfig[],
  items: EvalItem[],
  prices: PriceTable,
): number {
  let total = 0;
  for (const strategy of strategies) {
    for (const item of items) {
      total += estimateItemCostUsd(strategy, item, prices);
    }
  }
  return total;
}

/** Error thrown by runEval's preflight when the projection exceeds the cap. */
export class BudgetCapError extends Error {
  readonly projectedUsd: number;
  readonly capUsd: number;
  constructor(projectedUsd: number, capUsd: number) {
    super(
      `budget cap refusal: projected spend $${projectedUsd.toFixed(4)} exceeds budget cap ` +
        `$${capUsd.toFixed(4)} — reduce suites/strategies or raise --cap. Run NOT started.`,
    );
    this.name = 'BudgetCapError';
    this.projectedUsd = projectedUsd;
    this.capUsd = capUsd;
  }
}
