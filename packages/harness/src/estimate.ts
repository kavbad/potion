// Preflight cost projection (SPEC §5): refuse to start a run whose PROJECTED
// spend exceeds budgetCapUsd. The projection is a WORST-CASE UPPER BOUND BY
// CONSTRUCTION, not a typical-cost estimate (M1b lesson: the old 80-token
// output model was calibrated to mock answers and actuals ran 2.3× over —
// preflight refusal must dominate actuals or it is theater):
//
//   · Every answering call's output is bounded by the provider layer:
//     DEFAULT_MAX_TOKENS is now sent on EVERY live transport (openai-shaped
//     included), so ANSWER_OUTPUT_TOKENS = DEFAULT_MAX_TOKENS is an enforced
//     ceiling, not a guess.
//   · Every one-line-protocol call (judge PICK / SCORE, self-report
//     CONFIDENCE) runs with maxTokens: PROTOCOL_MAX_TOKENS at its call site,
//     so PROTOCOL_OUTPUT_TOKENS = PROTOCOL_MAX_TOKENS is likewise enforced.
//   · Any answer embedded in a judge/verify/probe prompt is modeled at its
//     producer's ceiling (DEFAULT_MAX_TOKENS input tokens).
//   · calls(strategy) is the worst case: every cascade stage escalates and
//     every non-final stage with an escalateIf threshold probes (the logprob
//     method ALSO probes when the provider returns no logprobs); decompose
//     fans out to MAX_SUBTASKS subtasks, each priced at the most expensive
//     routable model; composite starts, probes, and upgrades.
//   · llm-judge scoring adds ONE judge call per (strategy × item); its
//     scaffolding is measured from the REAL prompt builder
//     (buildJudgeScoreMessages) so template drift cannot silently break the
//     bound.
//
// Input tokens remain the chars/4 heuristic (mock-consistent; tokenizers
// vary ±30%). The enforced output ceilings dominate the total — validated
// against the recorded M1b sweep (artifacts/m1b-sweep-*.json): projection
// ≥ actual per suite, per (suite × strategy), and in total; see
// estimate-m1b-regression.test.ts.
//
// Cost per call = (input·inputPer1M + output·outputPer1M) / 1e6 with the
// call's model price entry.
import type { ChatMessage, EvalItem, PriceEntry, PriceTable, StrategyConfig } from '@potion/core';
import { PROTOCOL_MAX_TOKENS } from '@potion/core';
import { DEFAULT_MAX_TOKENS } from '@potion/providers';
import { MAX_SUBTASKS } from '@potion/strategies';
import { buildJudgeScoreMessages } from './scorers.js';

/** Enforced output ceiling for an answering call (provider-layer max_tokens). */
export const ANSWER_OUTPUT_TOKENS = DEFAULT_MAX_TOKENS;
/** Enforced output ceiling for one-line-protocol (judge/probe) calls. */
export const PROTOCOL_OUTPUT_TOKENS = PROTOCOL_MAX_TOKENS;
/**
 * Worst-case input tokens for an answer embedded in a judge/verify/probe
 * prompt: the embedded text was produced by a call bounded at
 * DEFAULT_MAX_TOKENS, so its ceiling is exactly that.
 */
export const EMBEDDED_ANSWER_TOKENS = DEFAULT_MAX_TOKENS;

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
  /**
   * Runtime-routed calls (decompose subtasks): the model is decided by the
   * decomposer's output, so the worst case prices the call at the most
   * expensive candidate. When set, `model` is just the first candidate.
   */
  candidateModels?: string[];
}

/**
 * Worst-case per-item call plan for a strategy (model + token bound per call).
 */
/**
 * @param answerOutputTokens the ENFORCED per-call output ceiling for answer
 * calls in this run (RunEvalOptions.maxOutputTokens → ExecContext; default
 * DEFAULT_MAX_TOKENS). The projection binds to the configured value so a
 * workload that raises its ceiling gets a correspondingly larger bound —
 * never a bound achieved by silently truncating output.
 */
export function estimateCalls(
  strategy: StrategyConfig,
  baseInputTokens: number,
  answerOutputTokens: number = ANSWER_OUTPUT_TOKENS,
): CallEstimate[] {
  const OUT = answerOutputTokens;
  const EMBED = answerOutputTokens;
  switch (strategy.type) {
    case 'single':
      return [{ model: strategy.model, inputTokens: baseInputTokens, outputTokens: OUT }];
    case 'cascade': {
      const calls: CallEstimate[] = [];
      const stages = strategy.stages;
      stages.forEach((stage, i) => {
        calls.push({ model: stage.model, inputTokens: baseInputTokens, outputTokens: OUT });
        const isFinal = i === stages.length - 1;
        // Worst case probes for EVERY confidence method: 'logprob' falls back
        // to a self-report probe when the provider exposes no logprobs
        // (cascade.ts), so any non-final stage with a threshold may probe.
        if (!isFinal && stage.escalateIf?.confidenceBelow !== undefined) {
          calls.push({
            model: stage.model,
            inputTokens: baseInputTokens + EMBED,
            outputTokens: PROTOCOL_OUTPUT_TOKENS,
          });
        }
      });
      return calls;
    }
    case 'best-of-n': {
      const calls: CallEstimate[] = [];
      for (let i = 0; i < strategy.n; i++) {
        calls.push({ model: strategy.model, inputTokens: baseInputTokens, outputTokens: OUT });
      }
      calls.push({
        model: strategy.judge.model,
        inputTokens: baseInputTokens + strategy.n * EMBED,
        outputTokens: PROTOCOL_OUTPUT_TOKENS,
      });
      return calls;
    }
    case 'draft-verify':
      return [
        { model: strategy.draftModel, inputTokens: baseInputTokens, outputTokens: OUT },
        {
          model: strategy.verifierModel,
          inputTokens: baseInputTokens + EMBED,
          outputTokens: OUT,
        },
      ];
    case 'ensemble': {
      const calls: CallEstimate[] = strategy.models.map((model) => ({
        model,
        inputTokens: baseInputTokens,
        outputTokens: OUT,
      }));
      if (strategy.fusion.method === 'judge-pick' && strategy.fusion.judge) {
        calls.push({
          model: strategy.fusion.judge.model,
          inputTokens: baseInputTokens + strategy.models.length * EMBED,
          outputTokens: PROTOCOL_OUTPUT_TOKENS,
        });
      }
      return calls;
    }
    case 'decompose': {
      // Worst-case fan-out (decompose.ts hardening caps): 1 decompose call +
      // MAX_SUBTASKS routed subtask calls + optional judge fusion. Routing is
      // decided at runtime by the decomposer's output, so each subtask is
      // priced at the MOST EXPENSIVE routable model.
      const calls: CallEstimate[] = [
        { model: strategy.decomposerModel, inputTokens: baseInputTokens, outputTokens: OUT },
      ];
      const routable = [...new Set([...Object.values(strategy.routing), strategy.decomposerModel])];
      for (let i = 0; i < MAX_SUBTASKS; i++) {
        calls.push({
          model: routable[0]!,
          candidateModels: routable,
          inputTokens: baseInputTokens + EMBED,
          outputTokens: OUT,
        });
      }
      if (strategy.fusion?.method === 'judge-pick' && strategy.fusion.judge) {
        calls.push({
          model: strategy.fusion.judge.model,
          inputTokens: baseInputTokens + MAX_SUBTASKS * EMBED,
          outputTokens: PROTOCOL_OUTPUT_TOKENS,
        });
      }
      return calls;
    }
    case 'composite': {
      // M3 #23 (SPEC §12.6), worst case: start call + self-report probe (the
      // provider exposes no logprob confidence) + the upgrade fires with the
      // full start answer as context prefix.
      return [
        { model: strategy.startModel, inputTokens: baseInputTokens, outputTokens: OUT },
        {
          model: strategy.startModel,
          inputTokens: baseInputTokens + EMBED,
          outputTokens: PROTOCOL_OUTPUT_TOKENS,
        },
        {
          model: strategy.upgradeModel,
          inputTokens: baseInputTokens + EMBED,
          outputTokens: OUT,
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
  // Runtime-routed calls price at the most expensive candidate (worst case).
  const models = call.candidateModels?.length ? call.candidateModels : [call.model];
  return Math.max(
    ...models.map((m) => {
      const entry = entryFor(prices, m);
      return (call.inputTokens * entry.inputPer1M + call.outputTokens * entry.outputPer1M) / 1_000_000;
    }),
  );
}

/**
 * Estimated llm-judge SCORING call for an item (null for deterministic
 * scorers). The prompt scaffolding (instructions, rubric, TASK block,
 * DATA-framing) is MEASURED from the real builder with an empty answer, then
 * the candidate answer is added at its enforced ceiling — template drift in
 * scorers.ts automatically flows into the bound.
 */
export function estimateJudgeScoringCall(
  item: EvalItem,
  answerOutputTokens: number = ANSWER_OUTPUT_TOKENS,
  judgeOutputTokens: number = PROTOCOL_OUTPUT_TOKENS,
): CallEstimate | null {
  if (item.scoring.kind !== 'llm-judge') return null;
  const scaffolding = buildJudgeScoreMessages(item, '', item.scoring);
  return {
    model: item.scoring.judgeModel,
    inputTokens: Math.ceil(promptCharsOf(scaffolding) / 4) + answerOutputTokens,
    // G1.7: the projection binds to the CONFIGURED judge budget (G0.5/G1.1
    // lesson — enforcement caps are config; dependent calculations follow).
    outputTokens: judgeOutputTokens,
  };
}

/**
 * Estimated judge-scoring cost for an item: $0 for deterministic scorers,
 * one priced judge call for llm-judge items (M1b).
 */
export function estimateItemJudgeCostUsd(
  item: EvalItem,
  prices: PriceTable,
  answerOutputTokens: number = ANSWER_OUTPUT_TOKENS,
  judgeOutputTokens: number = PROTOCOL_OUTPUT_TOKENS,
): number {
  const call = estimateJudgeScoringCall(item, answerOutputTokens, judgeOutputTokens);
  return call === null ? 0 : estimateCallCostUsd(call, prices);
}

export function estimateItemCostUsd(
  strategy: StrategyConfig,
  item: EvalItem,
  prices: PriceTable,
  answerOutputTokens: number = ANSWER_OUTPUT_TOKENS,
  judgeOutputTokens: number = PROTOCOL_OUTPUT_TOKENS,
): number {
  const base = inputTokensOf(item);
  const strategyCost = estimateCalls(strategy, base, answerOutputTokens).reduce(
    (a, c) => a + estimateCallCostUsd(c, prices),
    0,
  );
  // llm-judge items are scored once per (strategy × item) → one judge call
  // each; preflight must project that spend (M1b — previously omitted).
  return strategyCost + estimateItemJudgeCostUsd(item, prices, answerOutputTokens, judgeOutputTokens);
}

/** Preflight projection: Σ over (item × strategy) of estimated cost, INCLUDING llm-judge scoring calls. */
export function projectRunCostUsd(
  strategies: StrategyConfig[],
  items: EvalItem[],
  prices: PriceTable,
  answerOutputTokens: number = ANSWER_OUTPUT_TOKENS,
  judgeOutputTokens: number = PROTOCOL_OUTPUT_TOKENS,
): number {
  let total = 0;
  for (const strategy of strategies) {
    for (const item of items) {
      total += estimateItemCostUsd(strategy, item, prices, answerOutputTokens, judgeOutputTokens);
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
