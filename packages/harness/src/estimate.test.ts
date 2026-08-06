// Preflight cost-model tests (SPEC §5): hand-computed projections + cap refusal error.
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { EvalItem } from '@potion/core';
import { loadPrices } from '@potion/providers';
import {
  BudgetCapError,
  estimateCalls,
  estimateItemCostUsd,
  estimateItemJudgeCostUsd,
  estimateJudgeScoringCall,
  inputTokensOf,
  projectRunCostUsd,
} from './estimate.js';

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

  it('single: exactly one answering call, worst case', () => {
    expect(estimateCalls({ type: 'single', model: 'frontier-class' }, 27)).toHaveLength(1);
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
  });

  it('hand-computed single-call cost matches the price table', () => {
    // frontier-class: $15/$75 per 1M. 27 in + 80 out → (27·15 + 80·75)/1e6
    const cost = estimateItemCostUsd({ type: 'single', model: 'frontier-class' }, itemWithContent('x'.repeat(100)), prices);
    expect(cost).toBeCloseTo((27 * 15 + 80 * 75) / 1e6, 12);
  });

  it('projection = Σ over (item × strategy)', () => {
    const items = [itemWithContent('x'.repeat(100)), itemWithContent('y'.repeat(100))];
    const one = estimateItemCostUsd({ type: 'single', model: 'frontier-class' }, items[0]!, prices);
    expect(projectRunCostUsd([{ type: 'single', model: 'frontier-class' }], items, prices)).toBeCloseTo(2 * one, 12);
  });

  it('mock strategies project $0 (mock price entries are free)', () => {
    const cost = estimateItemCostUsd({ type: 'single', model: 'mock-frontier' }, itemWithContent('hello'), prices);
    expect(cost).toBe(0);
  });
});

describe('llm-judge scoring cost in the projection (M1b)', () => {
  // 100 content chars + 'user' (4) + ':' (1) = 105 prompt chars; 40-char rubric.
  const judgeItem: EvalItem = {
    ...itemWithContent('x'.repeat(100)),
    scoring: { kind: 'llm-judge', rubric: 'r'.repeat(40), judgeModel: 'judge-class', scale: [0, 4] },
  };

  it('judge call estimate mirrors the scoring prompt shape', () => {
    const call = estimateJudgeScoringCall(judgeItem);
    expect(call).not.toBeNull();
    // hand math: ceil((105 + 40)/4) + 80 (answer block) + 48 (template) = 37 + 128 = 165 in, 8 out
    expect(call!.model).toBe('judge-class');
    expect(call!.inputTokens).toBe(165);
    expect(call!.outputTokens).toBe(8);
    // deterministic scorers → no judge call
    expect(estimateJudgeScoringCall(itemWithContent('x'.repeat(100)))).toBeNull();
    expect(estimateItemJudgeCostUsd(itemWithContent('x'.repeat(100)), prices)).toBe(0);
  });

  it('item cost = strategy cost + judge cost, hand-computed', () => {
    // judge-class $3/$15 per 1M: (165·3 + 8·15)/1e6 = 615e-6
    expect(estimateItemJudgeCostUsd(judgeItem, prices)).toBeCloseTo(615 / 1e6, 12);
    // frontier-class single: 27 in + 80 out → (27·15 + 80·75)/1e6 = 6405e-6
    // item total = (6405 + 615)/1e6 = 7020e-6
    const cost = estimateItemCostUsd({ type: 'single', model: 'frontier-class' }, judgeItem, prices);
    expect(cost).toBeCloseTo(7020 / 1e6, 12);
  });

  it('projection over a 14-item llm-judge suite includes every judge call', () => {
    const items14 = Array.from({ length: 14 }, (_, i) => ({ ...judgeItem, id: `t-${String(i).padStart(2, '0')}` }));
    const projected = projectRunCostUsd([{ type: 'single', model: 'frontier-class' }], items14, prices);
    // 14 × 7020e-6 = 0.09828  (strategy-only would be 14 × 6405e-6 = 0.08967)
    expect(projected).toBeCloseTo((14 * 7020) / 1e6, 12);
    expect(projected).toBeGreaterThan((14 * 6405) / 1e6);
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
