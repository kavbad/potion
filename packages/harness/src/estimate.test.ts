// Preflight cost-model tests (SPEC §5): hand-computed projections + cap refusal error.
// The model is a worst-case UPPER BOUND: answer output at the enforced
// DEFAULT_MAX_TOKENS ceiling, protocol (judge/probe) output at
// PROTOCOL_MAX_TOKENS — see estimate.ts header and the M1b domination
// regression in estimate-m1b-regression.test.ts.
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { EvalItem } from '@potion/core';
import { loadPrices } from '@potion/providers';
import { MAX_SUBTASKS } from '@potion/strategies';
import {
  ANSWER_OUTPUT_TOKENS,
  BudgetCapError,
  EMBEDDED_ANSWER_TOKENS,
  PROTOCOL_OUTPUT_TOKENS,
  estimateCallCostUsd,
  estimateCalls,
  estimateItemCostUsd,
  estimateItemJudgeCostUsd,
  estimateJudgeScoringCall,
  inputTokensOf,
  projectRunCostUsd,
  promptCharsOf,
} from './estimate.js';
import { buildJudgeScoreMessages } from './scorers.js';

const PRICES_PATH = fileURLToPath(new URL('../../../prices.json', import.meta.url));
const prices = loadPrices(PRICES_PATH).table;

function itemWithContent(content: string): EvalItem {
  return {
    id: 't-01',
    clusterId: 'extraction',
    prompt: [{ role: 'user', content }],
    reference: {},
    scoring: { kind: 'field-match', schema: {} },
  };
}

describe('preflight token model', () => {
  it('inputTokens = ceil(promptChars/4) including the role prefix', () => {
    // 'user' (4) + ':' (1) + 100 content chars = 105 chars → 27 tokens
    expect(inputTokensOf(itemWithContent('x'.repeat(100)))).toBe(27);
  });

  it('single: exactly one answering call at the enforced output ceiling', () => {
    const calls = estimateCalls({ type: 'single', model: 'frontier-class' }, 27);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.outputTokens).toBe(ANSWER_OUTPUT_TOKENS);
  });

  it('cascade self-report-calibrated: all stages + one probe per non-final stage', () => {
    const calls = estimateCalls(
      {
        type: 'cascade',
        stages: [
          { model: 'cheap-class', escalateIf: { confidenceBelow: 0.7 } },
          { model: 'frontier-class' },
        ],
        confidenceMethod: 'self-report-calibrated',
      },
      27,
    );
    expect(calls).toHaveLength(3); // cheap answer + cheap probe + frontier answer
    // Probe embeds the draft answer at its ceiling; protocol-capped output.
    expect(calls[1]).toMatchObject({
      model: 'cheap-class',
      inputTokens: 27 + EMBEDDED_ANSWER_TOKENS,
      outputTokens: PROTOCOL_OUTPUT_TOKENS,
    });
  });

  it("cascade 'logprob' ALSO budgets the probe (worst case: provider exposes no logprobs)", () => {
    const calls = estimateCalls(
      {
        type: 'cascade',
        stages: [
          { model: 'cheap-class', escalateIf: { confidenceBelow: 0.7 } },
          { model: 'frontier-class' },
        ],
        confidenceMethod: 'logprob',
      },
      27,
    );
    expect(calls).toHaveLength(3); // fallback probe included in the bound
  });

  it('decompose: 1 decompose + MAX_SUBTASKS subtasks priced at the priciest routable model', () => {
    const calls = estimateCalls(
      {
        type: 'decompose',
        decomposerModel: 'cheap-class',
        routing: { extraction: 'cheap-class', 'code-gen': 'frontier-class' },
      },
      27,
    );
    expect(calls).toHaveLength(1 + MAX_SUBTASKS);
    // Every subtask carries the full routable candidate set → priced as max.
    const subtask = calls[1]!;
    expect(subtask.candidateModels).toEqual(expect.arrayContaining(['cheap-class', 'frontier-class']));
    // frontier-class ($15/$75) dominates cheap-class ($0.25/$1.25):
    const frontier = prices.entries.find((e) => e.alias === 'frontier-class')!;
    const want =
      ((27 + EMBEDDED_ANSWER_TOKENS) * frontier.inputPer1M + ANSWER_OUTPUT_TOKENS * frontier.outputPer1M) / 1e6;
    expect(estimateCallCostUsd(subtask, prices)).toBeCloseTo(want, 12);
  });

  it('hand-computed single-call cost matches the price table', () => {
    // frontier-class: $15/$75 per 1M. 27 in + ANSWER_OUTPUT_TOKENS out.
    const cost = estimateItemCostUsd({ type: 'single', model: 'frontier-class' }, itemWithContent('x'.repeat(100)), prices);
    expect(cost).toBeCloseTo((27 * 15 + ANSWER_OUTPUT_TOKENS * 75) / 1e6, 12);
  });

  it('projection = Σ over (item × strategy)', () => {
    const items = [itemWithContent('x'.repeat(100)), itemWithContent('y'.repeat(100))];
    const one = estimateItemCostUsd({ type: 'single', model: 'frontier-class' }, items[0]!, prices);
    expect(projectRunCostUsd([{ type: 'single', model: 'frontier-class' }], items, prices)).toBeCloseTo(2 * one, 12);
  });

  it('a configured answer ceiling flows into answer calls AND embedded answers', () => {
    const calls = estimateCalls(
      { type: 'draft-verify', draftModel: 'cheap-class', verifierModel: 'frontier-class' },
      27,
      2048,
    );
    expect(calls[0]!.outputTokens).toBe(2048); // draft answer at the configured ceiling
    expect(calls[1]!.inputTokens).toBe(27 + 2048); // verifier embeds the draft at that ceiling
    expect(calls[1]!.outputTokens).toBe(2048);
    // projection scales with the ceiling — a raised ceiling can never shrink the bound
    const item = itemWithContent('x'.repeat(100));
    const cfg = { type: 'single', model: 'frontier-class' } as const;
    expect(estimateItemCostUsd(cfg, item, prices, 2048)).toBeGreaterThan(
      estimateItemCostUsd(cfg, item, prices),
    );
  });

  it('mock strategies project $0 (mock price entries are free)', () => {
    const cost = estimateItemCostUsd({ type: 'single', model: 'mock-frontier' }, itemWithContent('hello'), prices);
    expect(cost).toBe(0);
  });
});

describe('llm-judge scoring cost in the projection (M1b)', () => {
  const judgeScoring = {
    kind: 'llm-judge' as const,
    rubric: 'r'.repeat(40),
    judgeModel: 'judge-class',
    scale: [0, 4] as [number, number],
  };
  const judgeItem: EvalItem = { ...itemWithContent('x'.repeat(100)), scoring: judgeScoring };

  it('judge call estimate = MEASURED scaffolding + answer at its ceiling', () => {
    const call = estimateJudgeScoringCall(judgeItem);
    expect(call).not.toBeNull();
    expect(call!.model).toBe('judge-class');
    // Scaffolding is measured from the REAL prompt builder (empty answer) so
    // template drift in scorers.ts automatically flows into the bound.
    const scaffolding = buildJudgeScoreMessages(judgeItem, '', judgeScoring);
    const scaffoldingTokens = Math.ceil(promptCharsOf(scaffolding) / 4);
    expect(call!.inputTokens).toBe(scaffoldingTokens + EMBEDDED_ANSWER_TOKENS);
    expect(call!.outputTokens).toBe(PROTOCOL_OUTPUT_TOKENS);
    // deterministic scorers → no judge call
    expect(estimateJudgeScoringCall(itemWithContent('x'.repeat(100)))).toBeNull();
    expect(estimateItemJudgeCostUsd(itemWithContent('x'.repeat(100)), prices)).toBe(0);
  });

  it('G1.4: a reference on the item raises the judge projection (measured scaffolding)', () => {
    // itemWithContent carries a reference — strip it for the true bare baseline
    const bareItem = { ...judgeItem };
    delete (bareItem as { reference?: unknown }).reference;
    const bare = estimateJudgeScoringCall(bareItem)!;
    const anchored = estimateJudgeScoringCall({ ...bareItem, reference: 'z'.repeat(400) })!;
    // The REFERENCE block flows through the real builder into the bound —
    // at least the reference's own tokens beyond the bare scaffolding.
    expect(anchored.inputTokens).toBeGreaterThan(bare.inputTokens + 100);
    expect(anchored.outputTokens).toBe(bare.outputTokens);
  });

  it('item cost = strategy cost + judge cost, hand-computed', () => {
    const call = estimateJudgeScoringCall(judgeItem)!;
    // judge-class $3/$15 per 1M:
    const judgeCost = (call.inputTokens * 3 + call.outputTokens * 15) / 1e6;
    expect(estimateItemJudgeCostUsd(judgeItem, prices)).toBeCloseTo(judgeCost, 12);
    // frontier-class single: 27 in + ANSWER_OUTPUT_TOKENS out
    const singleCost = (27 * 15 + ANSWER_OUTPUT_TOKENS * 75) / 1e6;
    const cost = estimateItemCostUsd({ type: 'single', model: 'frontier-class' }, judgeItem, prices);
    expect(cost).toBeCloseTo(singleCost + judgeCost, 12);
  });

  it('projection over a 14-item llm-judge suite includes every judge call', () => {
    const items14 = Array.from({ length: 14 }, (_, i) => ({ ...judgeItem, id: `t-${String(i).padStart(2, '0')}` }));
    const perItem = estimateItemCostUsd({ type: 'single', model: 'frontier-class' }, judgeItem, prices);
    const strategyOnly = (27 * 15 + ANSWER_OUTPUT_TOKENS * 75) / 1e6;
    const projected = projectRunCostUsd([{ type: 'single', model: 'frontier-class' }], items14, prices);
    expect(projected).toBeCloseTo(14 * perItem, 12);
    expect(projected).toBeGreaterThan(14 * strategyOnly);
  });
});

describe('BudgetCapError', () => {
  it('carries projected + cap and a clear message', () => {
    const e = new BudgetCapError(1.2345, 0.0001);
    expect(e.message).toContain('$1.2345');
    expect(e.message).toContain('$0.0001');
    expect(e.message).toMatch(/Run NOT started/);
    expect(e.projectedUsd).toBe(1.2345);
    expect(e.capUsd).toBe(0.0001);
  });
});
