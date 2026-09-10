// 2026-09-08, the first cascade on a serving frontier (code-review v7). The
// request-aware cost model prices a multi-model strategy at the MEAN of its
// members' prices — "an approximation, labelled as one". Measured on the
// first serve: a cascade that runs gpt-mini 75% of the time was costed as a
// half-price model run 100% of the time, so min_cost picked it only when the
// request exceeded ~114 input tokens. Three of five code-review items (109–111
// tokens) were served gpt-full at $0.000236; the two the cascade served cost
// $0.000056. Every number below is from that frontier.
import { describe, expect, it } from 'vitest';
import { selectPoint, expectedCostPer1K, baselineInputTokens } from './select.js';
import type { StrategyConfig } from './types.js';

const prices = {
  version: 't', updatedAt: '',
  entries: [
    { alias: 'or-gpt-mini', provider: 'openrouter' as const, model: 'openai/gpt-4.1-mini', inputPer1M: 0.4, outputPer1M: 1.6 },
    { alias: 'or-gpt-full', provider: 'openrouter' as const, model: 'openai/gpt-4.1', inputPer1M: 2, outputPer1M: 8 },
  ],
};
const pt = (hash: string, config: StrategyConfig, quality: number, lb: number, costPer1K: number, inputMean: number, outputMean: number) => ({
  clusterId: 'code-review', strategyHash: hash, strategyConfig: config,
  quality, costPer1K, latencyP95: 12000, providerMode: 'live' as const,
  evidence: { cacheKeys: [], runIds: ['run-b35228ab'], n: 60, qualityCi95: quality - lb, qualityCi: [lb, 1] as [number, number], tokens: { inputMean, outputMean } },
});
const CASCADE: StrategyConfig = { type: 'cascade', confidenceMethod: 'logprob', stages: [{ model: 'or-gpt-mini', escalateIf: { confidenceBelow: 0.98 } }, { model: 'or-gpt-full' }] };
// gpt-full: (132.6×2 + 41.7×8)/1e6×1000 = 0.5988 ≈ the measured 0.5986 — a single's catalogue price IS its price.
const full = pt('full', { type: 'single', model: 'or-gpt-full' }, 0.960, 0.887, 0.5986, 132.6, 41.7);
// cascade: measured $0.5378/1K at the suite. Mean-of-prices reconstruction at the
// suite is (162.8×1.2 + 81×4.8)/1e6×1000 = 0.5842 — 8.6% above what was measured.
const cascade = pt('cascade', CASCADE, 0.928, 0.842, 0.5378, 162.8, 81.0);
const frontier = { id: 'f', clusterId: 'code-review', version: 7, parentId: null, trigger: 'manual' as const, points: [full, cascade], pricesVersion: 't', createdAt: new Date(0).toISOString() };
const policy = { type: 'min_cost' as const, qualityFloor: 0.84 };

describe('a multi-model point is priced around its measurement, not around the mean of its members', () => {
  it('at the suite size, the request-aware cost of the cascade IS its measured cost', () => {
    const base = baselineInputTokens(frontier.points)!;
    expect(base).toBe(132.6);
    expect(expectedCostPer1K(cascade, 132.6, prices, base)).toBeCloseTo(0.5378, 3);
  });

  it('a 110-token request is served the cascade — the point that measured cheaper — not gpt-full', () => {
    // Unanchored: cascade ((110+30.2)×1.2 + 81×4.8)/1000 = 0.5570 vs gpt-full (110×2 + 41.7×8)/1000 = 0.5536
    // → gpt-full by $0.003, on a strategy that measured $0.06 cheaper. That was run 6.
    const picked = selectPoint(policy, frontier, { requestInputTokens: 110, prices });
    expect(picked?.strategyHash).toBe('cascade');
  });

  it('and at 135 tokens, where it was already chosen, it still is', () => {
    expect(selectPoint(policy, frontier, { requestInputTokens: 135, prices })?.strategyHash).toBe('cascade');
  });

  it('a single is untouched: its request-aware cost is still pure catalogue arithmetic', () => {
    expect(expectedCostPer1K(full, 110, prices, 132.6)).toBeCloseTo(0.5536, 3);
  });
});
