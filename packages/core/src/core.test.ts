import { describe, expect, it } from 'vitest';
import { canonicalJson, strategyHash } from './hash.js';
import { costUsd, roundCost } from './prices.js';
import { selectPoint, expectedCostPer1K, baselineInputTokens, underpoweredExclusions } from './select.js';
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
    // minSamples (G0.3) is additive with a HARD floor of 5
    expect(
      PolicySchema.parse({
        type: 'min_cost',
        qualityFloor: 0.8,
        guarantee: { ...g, minSamples: 20 },
      }).guarantee?.minSamples,
    ).toBe(20);
    expect(
      PolicySchema.safeParse({
        type: 'min_cost',
        qualityFloor: 0.8,
        guarantee: { ...g, minSamples: 3 },
      }).success,
    ).toBe(false); // below the floor — contract-grade means raise, never lower
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

// 2026-09-06 — the defect a design partner's benchmark exposed, in miniature.
//
// costPer1K is measured at the SUITE's prompt size. A strategy that prefixes
// the prompt carries a FIXED input overhead, so it is a modest surcharge on a
// 125-token suite item and a crushing one on the 24-token prompts a real
// customer sends. Ranking on the scalar ranks for someone else's prompt
// length: in production a min_cost policy selected the arm that cost 19x its
// alternative on the customer's own corpus.
//
// THE FIXTURE MUST MAKE THE TWO BASES DISAGREE, or it proves nothing. A first
// version of this test had the transform pricier on both bases, so it passed
// with the correction deliberately removed. Here the transform runs on a
// 10x CHEAPER model, which makes it the cheaper point on the suite and the
// dearer one on a short request — the exact inversion the scalar cannot see.
describe('cost is evaluated at the size the caller actually sends', () => {
  const prices = {
    version: 't', updatedAt: '',
    entries: [
      { alias: 'dear', provider: 'openrouter' as const, model: 'dear', inputPer1M: 10, outputPer1M: 10 },
      { alias: 'cheap', provider: 'openrouter' as const, model: 'cheap', inputPer1M: 1, outputPer1M: 1 },
    ],
  };
  const pt = (hash: string, model: string, inputMean: number, costPer1K: number) => ({
    clusterId: 'classification',
    strategyHash: hash,
    strategyConfig: { type: 'single' as const, model },
    quality: 0.9,
    costPer1K,
    latencyP95: 500,
    providerMode: 'live' as const,
    evidence: {
      cacheKeys: [], runIds: ['r'], n: 30, qualityCi95: 0.01, qualityCi: [0.89, 0.91] as [number, number],
      tokens: { inputMean, outputMean: 5 },
    },
  });
  // On the suite (125-token items):
  //   plain     dear model, no transform : (125*10 + 5*10)/1e6*1000 = $1.30
  //   transform cheap model, +400 tokens : (525*1  + 5*1 )/1e6*1000 = $0.53  ← cheaper
  const plain = pt('plain', 'dear', 125, 1.3);
  const transform = pt('transform', 'cheap', 525, 0.53);
  const frontier = {
    id: 'f', clusterId: 'classification', version: 1, parentId: null,
    trigger: 'manual' as const, points: [transform, plain], pricesVersion: 't',
    createdAt: new Date(0).toISOString(),
  };
  const policy = { type: 'min_cost' as const, qualityFloor: 0.5 };

  it('the measured scalar prefers the transform — it was cheaper on the suite', () => {
    expect(selectPoint(policy, frontier)?.strategyHash).toBe('transform');
  });

  it('at the request its overhead dominates, and min_cost picks the other point', () => {
    // 24-token request: plain (24*10+5*10)/1e6*1000 = $0.29
    //                   transform (24+400)*1 + 5 = $0.429
    const picked = selectPoint(policy, frontier, { requestInputTokens: 24, prices });
    expect(
      picked?.strategyHash,
      'a fixed prompt overhead is priced against the request, not the suite',
    ).toBe('plain');
  });

  it('and at a LONG request the transform is right again — this is not a thumb on the scale', () => {
    const picked = selectPoint(policy, frontier, { requestInputTokens: 2000, prices });
    expect(picked?.strategyHash).toBe('transform');
  });

  it('reconstructs the overhead from the least-transforming point', () => {
    const base = baselineInputTokens(frontier.points);
    expect(base).toBe(125);
    expect(expectedCostPer1K(transform, 24, prices, base!)).toBeCloseTo(0.429, 3);
    expect(expectedCostPer1K(plain, 24, prices, base!)).toBeCloseTo(0.29, 3);
  });

  it('falls back to the measured scalar when any point lacks a token profile', () => {
    const legacy = { ...plain, strategyHash: 'legacy', costPer1K: 0.01, evidence: undefined };
    const mixed = { ...frontier, points: [transform, legacy] };
    expect(baselineInputTokens(mixed.points), 'one basis or the other, never both').toBeNull();
    expect(selectPoint(policy, mixed, { requestInputTokens: 24, prices })?.strategyHash).toBe('legacy');
  });
});

// 2026-09-06, second finding from the same head-to-head. After the reasoning
// guard stopped empty answers, 8 failures remained — all the same shape: the
// routed model wrote ~200 characters of "Let's break this down…" and was cut
// off at max_tokens=64 before reaching the answer. The incumbent answered the
// identical items in a median of THREE characters and got 8/8 right.
//
// Quality was measured with no regard for whether an answer fits the budget
// the caller gives it — the same blind spot the cost model had about request
// size. The evidence needed was already being collected (outputMean); nothing
// consulted it.
describe('a point that cannot answer within the budget is not feasible', () => {
  const prices = {
    version: 't', updatedAt: '',
    entries: [
      { alias: 'cheap', provider: 'openrouter' as const, model: 'cheap', inputPer1M: 0.1, outputPer1M: 0.1 },
      { alias: 'dear', provider: 'openrouter' as const, model: 'dear', inputPer1M: 1, outputPer1M: 1 },
    ],
  };
  // The fixture has to keep 'verbose' genuinely cheaper under BOTH cost bases,
  // or the request-aware cost model picks 'terse' for cost reasons and the
  // budget filter is never exercised. (A first version got this wrong and the
  // cost model caught it — 300 output tokens is not cheap on the same model.)
  const pt = (hash: string, quality: number, cost: number, outputMean: number, model: string) => ({
    clusterId: 'multi-step-reasoning',
    strategyHash: hash,
    strategyConfig: { type: 'single' as const, model },
    quality, costPer1K: cost, latencyP95: 500, providerMode: 'live' as const,
    evidence: {
      cacheKeys: [], runIds: ['r'], n: 30, qualityCi95: 0.01,
      qualityCi: [quality - 0.01, Math.min(1, quality + 0.01)] as [number, number],
      tokens: { inputMean: 120, outputMean },
    },
  });
  // 'verbose' is cheaper and scores higher — and averages 300 output tokens,
  // so under a 64-token budget it truncates. 'terse' averages 8.
  // verbose: cheap model, 300 output tokens  → (100 + 300) × 0.1 = $0.04/1K
  // terse:    dear model,    8 output tokens  → (100 +   8) × 1.0 = $0.108/1K
  const verbose = pt('verbose', 0.95, 0.04, 300, 'cheap');
  const terse = pt('terse', 0.90, 0.108, 8, 'dear');
  const frontier = {
    id: 'f', clusterId: 'multi-step-reasoning', version: 1, parentId: null,
    trigger: 'manual' as const, points: [verbose, terse], pricesVersion: 't',
    createdAt: new Date(0).toISOString(),
  };
  const policy = { type: 'min_cost' as const, qualityFloor: 0.5 };

  it('with no stated budget, nothing changes — the cheaper point still wins', () => {
    expect(selectPoint(policy, frontier, { requestInputTokens: 100, prices })?.strategyHash).toBe('verbose');
  });

  it('under a budget it cannot fit, the truncating point is not selected', () => {
    const picked = selectPoint(policy, frontier, { requestInputTokens: 100, prices, maxOutputTokens: 64 });
    expect(
      picked?.strategyHash,
      'a mean output above the budget means most answers are cut off before the answer',
    ).toBe('terse');
  });

  it('a generous budget admits it again — this is feasibility, not a penalty', () => {
    expect(selectPoint(policy, frontier, { requestInputTokens: 100, prices, maxOutputTokens: 4096 })?.strategyHash).toBe('verbose');
  });

  it('when NOTHING fits the budget, it says so rather than serving a truncation', () => {
    const allVerbose = { ...frontier, points: [verbose, { ...terse, strategyHash: 'terse2', evidence: { ...terse.evidence, tokens: { inputMean: 120, outputMean: 250 } } }] };
    expect(selectPoint(policy, allVerbose, { requestInputTokens: 100, prices, maxOutputTokens: 64 })).toBeNull();
  });

  it('a frontier without profiles is not judged on evidence it does not have', () => {
    const legacy = { ...terse, strategyHash: 'legacy', evidence: undefined };
    const mixed = { ...frontier, points: [verbose, legacy] };
    expect(selectPoint(policy, mixed, { requestInputTokens: 100, prices, maxOutputTokens: 64 })?.strategyHash).toBe('verbose');
  });
});

// 2026-09-07. A re-measurement moved or-gemini-flash on classification to a
// MEAN of 0.950 with a LOWER BOUND of 0.849 — missing an 0.85 floor by one
// thousandth, because 40 suite items give a ±0.10 Jeffreys interval. Every
// point under $0.05/1K was excluded the same way, min_cost was forced onto a
// point 19x dearer, and the customer's routing became 5x more expensive.
// Nothing in the receipt, the logs or the dashboard said why.
//
// "Not good enough" and "not measured enough to promise" are opposite
// problems — replace the model, or measure more. The floor cannot tell them
// apart, and it should not: a floor is a promise. But the SYSTEM must.
describe('a floor excluding points on interval width says so', () => {
  const pt = (hash: string, mean: number, half: number) => ({
    clusterId: 'classification',
    strategyHash: hash,
    strategyConfig: { type: 'single' as const, model: 'm' },
    quality: mean, costPer1K: 0.04, latencyP95: 400, providerMode: 'live' as const,
    evidence: {
      cacheKeys: [], runIds: ['r'], n: 40, qualityCi95: half,
      qualityCi: [mean - half, Math.min(1, mean + half)] as [number, number],
    },
  });
  const frontier = {
    id: 'f', clusterId: 'classification', version: 6, parentId: null, trigger: 'manual' as const,
    // the production shape: a strong mean, an interval too wide to promise it
    points: [pt('underpowered', 0.95, 0.101), pt('confident', 1.0, 0.06)],
    pricesVersion: 'v', createdAt: new Date(0).toISOString(),
  };

  it('counts the point whose MEAN clears the floor but whose interval does not', () => {
    expect(underpoweredExclusions({ type: 'min_cost', qualityFloor: 0.85 }, frontier)).toBe(1);
  });

  it('counts nothing when the evidence is strong enough to promise the floor', () => {
    const tight = { ...frontier, points: [pt('a', 0.95, 0.04), pt('b', 1.0, 0.02)] };
    expect(underpoweredExclusions({ type: 'min_cost', qualityFloor: 0.85 }, tight)).toBe(0);
  });

  it('counts nothing for a point that is simply below the bar', () => {
    const weak = { ...frontier, points: [pt('weak', 0.60, 0.05)] };
    expect(
      underpoweredExclusions({ type: 'min_cost', qualityFloor: 0.85 }, weak),
      'a genuinely bad model is not an evidence problem',
    ).toBe(0);
  });

  it('applies to compound too, and not to policies without a floor', () => {
    expect(underpoweredExclusions({ type: 'compound', qualityFloor: 0.85, p95Ms: 1000 }, frontier)).toBe(1);
    expect(underpoweredExclusions({ type: 'max_quality', costCeilingPer1K: 5 }, frontier)).toBe(0);
  });
});
