// R2: pre-spend p95 projection. Worst case by construction: sequential
// shapes sum, genuinely-parallel shapes take the max, probes count at full
// p95, and a model without measured latency yields null — never a guess.
import { describe, expect, it } from 'vitest';
import type { StrategyConfig } from '@potion/core';
import { MAX_SUBTASKS } from '@potion/strategies';
import { projectStrategyP95Ms } from './estimate.js';

const L = new Map<string, number>([
  ['cheap', 1000],
  ['strong', 5000],
  ['judge', 800],
]);

describe('projectStrategyP95Ms', () => {
  it('single = the model p95', () => {
    expect(projectStrategyP95Ms({ type: 'single', model: 'strong' } as StrategyConfig, L)).toBe(5000);
  });

  it('cascade sums every stage plus every probe (all-escalate worst case)', () => {
    const cfg: StrategyConfig = {
      type: 'cascade',
      stages: [{ model: 'cheap', escalateIf: { confidenceBelow: 0.5 } }, { model: 'strong' }],
      confidenceMethod: 'self-report-calibrated',
    } as StrategyConfig;
    // cheap answer + cheap probe + strong answer
    expect(projectStrategyP95Ms(cfg, L)).toBe(1000 + 1000 + 5000);
  });

  it('best-of-n credits parallel drafts: max(member), then the judge', () => {
    const cfg = { type: 'best-of-n', model: 'cheap', n: 3, judge: { model: 'judge' } } as StrategyConfig;
    expect(projectStrategyP95Ms(cfg, L)).toBe(1000 + 800);
  });

  it('ensemble = max over members + judge-pick', () => {
    const cfg = {
      type: 'ensemble',
      models: ['cheap', 'strong'],
      fusion: { method: 'judge-pick', judge: { model: 'judge' } },
    } as StrategyConfig;
    expect(projectStrategyP95Ms(cfg, L)).toBe(5000 + 800);
  });

  it('draft-verify is sequential', () => {
    const cfg = { type: 'draft-verify', draftModel: 'cheap', verifierModel: 'strong' } as StrategyConfig;
    expect(projectStrategyP95Ms(cfg, L)).toBe(1000 + 5000);
  });

  it('decompose sums sequential subtasks at the slowest routable model', () => {
    const cfg = {
      type: 'decompose',
      decomposerModel: 'cheap',
      routing: { default: 'strong' },
    } as StrategyConfig;
    expect(projectStrategyP95Ms(cfg, L)).toBe(1000 + MAX_SUBTASKS * 5000);
  });

  it('a model without measured latency yields null, never a guess', () => {
    const cfg = { type: 'draft-verify', draftModel: 'cheap', verifierModel: 'unmeasured' } as StrategyConfig;
    expect(projectStrategyP95Ms(cfg, L)).toBeNull();
  });
});
