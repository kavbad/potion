import { describe, expect, it } from 'vitest';
import { canonicalJson, strategyHash } from './hash.js';
import { costUsd, roundCost } from './prices.js';
import { selectPoint } from './select.js';
import { StrategyConfigSchema, PolicySchema } from './schemas.js';
import type { Frontier, StrategyConfig } from './types.js';

describe('canonicalJson / strategyHash', () => {
  it('is stable under key reordering', () => {
    const a = { type: 'single', model: 'haiku-class' };
    const b = { model: 'haiku-class', type: 'single' };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(strategyHash(a)).toBe(strategyHash(b));
  });

  it('differs for different configs', () => {
    expect(strategyHash({ type: 'single', model: 'a' })).not.toBe(
      strategyHash({ type: 'single', model: 'b' }),
    );
  });
});

describe('costUsd', () => {
  it('computes exact token cost', () => {
    const e = { alias: 'x', provider: 'mock' as const, model: 'm', inputPer1M: 3, outputPer1M: 15 };
    // 1000 in, 500 out -> (1000*3 + 500*15)/1e6 = 0.0105
    expect(costUsd({ inputTokens: 1000, outputTokens: 500 }, e)).toBe(0.0105);
  });

  it('roundCost keeps 6 decimals', () => {
    expect(roundCost(0.123456789)).toBe(0.123457);
  });
});

describe('selectPoint', () => {
  const frontier: Frontier = {
    id: 'f1',
    clusterId: 'code-gen',
    version: 1,
    parentId: null,
    trigger: 'manual',
    pricesVersion: 'test',
    createdAt: new Date(0).toISOString(),
    points: [
      { clusterId: 'code-gen', strategyHash: 'a', strategyConfig: { type: 'single', model: 'cheap' }, quality: 0.7, costPer1K: 1, latencyP95: 500 },
      { clusterId: 'code-gen', strategyHash: 'b', strategyConfig: { type: 'single', model: 'mid' }, quality: 0.85, costPer1K: 4, latencyP95: 1200 },
      { clusterId: 'code-gen', strategyHash: 'c', strategyConfig: { type: 'single', model: 'best' }, quality: 0.95, costPer1K: 12, latencyP95: 2500 },
    ],
  };

  it('max_quality respects cost ceiling', () => {
    expect(selectPoint({ type: 'max_quality', costCeilingPer1K: 5 }, frontier)?.strategyHash).toBe('b');
    expect(selectPoint({ type: 'max_quality', costCeilingPer1K: 100 }, frontier)?.strategyHash).toBe('c');
  });

  it('min_cost respects quality floor', () => {
    expect(selectPoint({ type: 'min_cost', qualityFloor: 0.8 }, frontier)?.strategyHash).toBe('b');
    expect(selectPoint({ type: 'min_cost', qualityFloor: 0.6 }, frontier)?.strategyHash).toBe('a');
  });

  it('latency_bound filters then maximizes quality', () => {
    expect(selectPoint({ type: 'latency_bound', p95Ms: 1500 }, frontier)?.strategyHash).toBe('b');
  });

  it('returns null when nothing feasible', () => {
    expect(selectPoint({ type: 'max_quality', costCeilingPer1K: 0.5 }, frontier)).toBeNull();
  });
});

describe('schemas', () => {
  it('validates all seven strategy types', () => {
    const cfgs: StrategyConfig[] = [
      { type: 'single', model: 'm' },
      { type: 'cascade', stages: [{ model: 'a' }, { model: 'b' }], confidenceMethod: 'logprob' },
      { type: 'best-of-n', model: 'm', n: 3, judge: { model: 'j' } },
      { type: 'draft-verify', draftModel: 'd', verifierModel: 'v' },
      { type: 'ensemble', models: ['a', 'b'], fusion: { method: 'judge-pick' } },
      { type: 'decompose', decomposerModel: 'd', routing: { '*': 'm' } },
      // M3 #23 (SPEC §12.6)
      { type: 'composite', startModel: 'cheap', upgradeModel: 'frontier', upgradeIf: { confidenceBelow: 0.6 } },
    ];
    for (const c of cfgs) expect(StrategyConfigSchema.parse(c)).toBeTruthy();
  });

  it('rejects invalid composite configs (M3 #23)', () => {
    const base = { type: 'composite', startModel: 'cheap', upgradeModel: 'frontier' };
    expect(() => StrategyConfigSchema.parse({ ...base, upgradeIf: { confidenceBelow: 1.5 } })).toThrow();
    expect(() => StrategyConfigSchema.parse({ ...base, upgradeIf: { confidenceBelow: -0.1 } })).toThrow();
    expect(() => StrategyConfigSchema.parse({ ...base, upgradeIf: {} })).toThrow();
    expect(() => StrategyConfigSchema.parse({ ...base })).toThrow(); // missing upgradeIf
    expect(() =>
      StrategyConfigSchema.parse({ type: 'composite', startModel: 'cheap', upgradeIf: { confidenceBelow: 0.5 } }),
    ).toThrow(); // missing upgradeModel
  });

  it('rejects invalid policy', () => {
    expect(() => PolicySchema.parse({ type: 'min_cost', qualityFloor: 2 })).toThrow();
  });

  // ---- M3 #21 shadow mode (SPEC §12.4) ----
  it('accepts policies with and without a shadow config (additive)', () => {
    // untouched legacy shape still parses
    expect(PolicySchema.parse({ type: 'max_quality', costCeilingPer1K: 1 })).toEqual({
      type: 'max_quality',
      costCeilingPer1K: 1,
    });
    const withFrontier = PolicySchema.parse({
      type: 'min_cost',
      qualityFloor: 0.8,
      shadow: { sampleRate: 0.25, candidates: 'frontier' },
    });
    expect(withFrontier.shadow).toEqual({ sampleRate: 0.25, candidates: 'frontier' });
    const withHashes = PolicySchema.parse({
      type: 'latency_bound',
      p95Ms: 500,
      shadow: { sampleRate: 1, candidates: ['abc123', 'def456'] },
    });
    expect(withHashes.shadow).toEqual({ sampleRate: 1, candidates: ['abc123', 'def456'] });
  });

  it('rejects invalid shadow configs', () => {
    expect(() =>
      PolicySchema.parse({
        type: 'max_quality',
        costCeilingPer1K: 1,
        shadow: { sampleRate: 1.5, candidates: 'frontier' },
      }),
    ).toThrow(); // sampleRate out of range
    expect(() =>
      PolicySchema.parse({
        type: 'max_quality',
        costCeilingPer1K: 1,
        shadow: { sampleRate: 0.5, candidates: [] },
      }),
    ).toThrow(); // empty hash list
    expect(() =>
      PolicySchema.parse({
        type: 'max_quality',
        costCeilingPer1K: 1,
        shadow: { sampleRate: 0.5, candidates: 'bogus' },
      }),
    ).toThrow(); // candidates must be 'frontier' or hashes
  });

  // ---- M3 #22 quality guarantee (SPEC §12.5) ----
  it('accepts policies with and without a guarantee config (additive, backward-compatible)', () => {
    // policies without it parse identically to before
    expect(PolicySchema.parse({ type: 'max_quality', costCeilingPer1K: 1 })).toEqual({
      type: 'max_quality',
      costCeilingPer1K: 1,
    });
    expect(PolicySchema.parse({ type: 'min_cost', qualityFloor: 0.8 })).toEqual({
      type: 'min_cost',
      qualityFloor: 0.8,
    });
    const g = { minQuality: 0.7, windowMin: 15, sampleRate: 0.1, action: 'rollback' as const };
    for (const base of [
      { type: 'max_quality', costCeilingPer1K: 1 },
      { type: 'min_cost', qualityFloor: 0.8 },
      { type: 'latency_bound', p95Ms: 500 },
    ] as const) {
      expect(PolicySchema.parse({ ...base, guarantee: g }).guarantee).toEqual(g);
    }
    // judgeModel (G0.1) is additive: absent stays absent, present round-trips
    expect(PolicySchema.parse({ type: 'min_cost', qualityFloor: 0.8, guarantee: g }).guarantee)
      .not.toHaveProperty('judgeModel');
    expect(
      PolicySchema.parse({
        type: 'min_cost',
        qualityFloor: 0.8,
        guarantee: { ...g, judgeModel: 'judge-class' },
      }).guarantee?.judgeModel,
    ).toBe('judge-class');
    // guarantee composes with shadow on the same policy
    const both = PolicySchema.parse({
      type: 'min_cost',
      qualityFloor: 0.5,
      shadow: { sampleRate: 0.2, candidates: 'frontier' },
      guarantee: { minQuality: 0.6, windowMin: 30, sampleRate: 1, action: 'alert' },
    });
    expect(both.shadow?.sampleRate).toBe(0.2);
    expect(both.guarantee?.action).toBe('alert');
  });

  it('rejects invalid guarantee configs', () => {
    const base = { type: 'max_quality', costCeilingPer1K: 1 } as const;
    expect(() =>
      PolicySchema.parse({ ...base, guarantee: { minQuality: 1.5, windowMin: 15, sampleRate: 0.1, action: 'rollback' } }),
    ).toThrow(); // minQuality out of range
    expect(() =>
      PolicySchema.parse({ ...base, guarantee: { minQuality: 0.7, windowMin: 0, sampleRate: 0.1, action: 'rollback' } }),
    ).toThrow(); // windowMin must be positive
    expect(() =>
      PolicySchema.parse({ ...base, guarantee: { minQuality: 0.7, windowMin: 15, sampleRate: 2, action: 'alert' } }),
    ).toThrow(); // sampleRate out of range
    expect(() =>
      PolicySchema.parse({ ...base, guarantee: { minQuality: 0.7, windowMin: 15, sampleRate: 0.1, action: 'page' } }),
    ).toThrow(); // action must be rollback|alert
    expect(() =>
      PolicySchema.parse({ ...base, guarantee: { minQuality: 0.7, windowMin: 15, action: 'alert' } }),
    ).toThrow(); // sampleRate required
  });
});

// ---- M3 #23 composite (SPEC §12.6): strategyHash covers the 7th union
// member via canonical JSON — no special-casing. ----
describe('strategyHash — composite golden', () => {
  const COMPOSITE = {
    type: 'composite',
    startModel: 'mock-cheap',
    upgradeModel: 'mock-frontier',
    upgradeIf: { confidenceBelow: 0.6 },
  } as const;
  // Golden: sha256 of canonicalJson(COMPOSITE) — keys sorted, no whitespace:
  //   {"startModel":"mock-cheap","type":"composite","upgradeIf":{"confidenceBelow":0.6},"upgradeModel":"mock-frontier"}
  const GOLDEN = 'c062b53ffbba0a0c46e882284a8abc541f85eb349c6da76af4f3c975299ed5ce';

  it('matches the golden hash (canonical JSON, no special-casing)', () => {
    expect(canonicalJson(COMPOSITE)).toBe(
      '{"startModel":"mock-cheap","type":"composite","upgradeIf":{"confidenceBelow":0.6},"upgradeModel":"mock-frontier"}',
    );
    expect(strategyHash(COMPOSITE)).toBe(GOLDEN);
  });

  it('is stable against key order', () => {
    const reordered = {
      upgradeIf: { confidenceBelow: 0.6 },
      upgradeModel: 'mock-frontier',
      type: 'composite',
      startModel: 'mock-cheap',
    };
    expect(strategyHash(reordered)).toBe(GOLDEN);
    expect(strategyHash(reordered)).toBe(strategyHash(COMPOSITE));
  });

  it('differs from every other strategy type / threshold', () => {
    expect(strategyHash({ ...COMPOSITE, upgradeIf: { confidenceBelow: 0.61 } })).not.toBe(GOLDEN);
    expect(strategyHash({ type: 'single', model: 'mock-cheap' })).not.toBe(GOLDEN);
  });
});
