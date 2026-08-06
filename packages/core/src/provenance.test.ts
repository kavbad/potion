// Provenance contract tests (ROADMAP M1a item 4): the ProviderMode type and
// its zod schema. Only 'mock' | 'live' are recordable; 'unknown' is the db's
// explicit representation of ABSENCE, not a core value.
import { describe, expect, it } from 'vitest';
import { ProviderModeSchema } from './schemas.js';
import type { EvalResult, ProviderMode, StrategyAggregate } from './types.js';

describe('ProviderModeSchema', () => {
  it("accepts 'mock' and 'live'", () => {
    expect(ProviderModeSchema.parse('mock')).toBe('mock');
    expect(ProviderModeSchema.parse('live')).toBe('live');
  });

  it("rejects 'unknown' and anything else — absence is not a mode", () => {
    expect(ProviderModeSchema.safeParse('unknown').success).toBe(false);
    expect(ProviderModeSchema.safeParse('').success).toBe(false);
    expect(ProviderModeSchema.safeParse(undefined).success).toBe(false);
  });
});

describe('ProviderMode on value objects (compile-time contract)', () => {
  it('EvalResult/StrategyAggregate carry an optional providerMode', () => {
    const mode: ProviderMode = 'mock';
    const result: EvalResult = {
      runId: 'run-1',
      itemId: 'item-1',
      clusterId: 'code-gen',
      strategyHash: 'sh',
      strategyConfig: { type: 'single', model: 'mock-cheap' },
      quality: 0.9,
      scorer: 'exact',
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 10 },
      latencyMs: { p50: 10, p95: 10, mean: 10 },
      modelVersions: {},
      pricesVersion: 'v1',
      providerMode: mode,
      cacheKey: 'ck',
      createdAt: '2026-08-04T00:00:00.000Z',
    };
    expect(result.providerMode).toBe('mock');
    // Absence stays representable (pre-M1a rows).
    const legacy: EvalResult = { ...result };
    delete legacy.providerMode;
    expect(legacy.providerMode).toBeUndefined();

    const agg: StrategyAggregate = {
      clusterId: 'code-gen',
      strategyHash: 'sh',
      strategyConfig: { type: 'single', model: 'mock-cheap' },
      qualityMean: 0.9,
      qualityCi95: 0,
      n: 1,
      costPer1K: 0.01,
      latencyP50: 10,
      latencyP95: 10,
      pricesVersion: 'v1',
      providerMode: 'live',
    };
    expect(agg.providerMode).toBe('live');
  });
});
