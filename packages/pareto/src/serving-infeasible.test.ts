// The quality-infeasible fallback serves the cheapest point the evidence
// cannot rank below the best (2026-09-11), not the priciest point outright.
import { describe, expect, it } from 'vitest';
import type { Frontier, FrontierPoint } from '@potion/core';
import { infeasibleFallbackPoint, resolveOperatingPoint } from './serving.js';

function pt(hash: string, quality: number, costPer1K: number, half?: number): FrontierPoint {
  return {
    clusterId: 'agentic-tool-use',
    strategyHash: hash,
    strategyConfig: { type: 'single', model: hash },
    quality,
    costPer1K,
    latencyP95: 800,
    providerMode: 'live',
    ...(half !== undefined ? { evidence: { cacheKeys: [], runIds: ['r'], n: 40, qualityCi95: half } } : {}),
  };
}
const frontierOf = (points: FrontierPoint[]): Frontier => ({
  id: 'f', clusterId: 'agentic-tool-use', version: 4, parentId: null, trigger: 'manual', points, pricesVersion: 'v', createdAt: new Date(0).toISOString(),
});

describe('infeasibleFallbackPoint', () => {
  // The production frontier that found it: terra-pro q 0.972 at $44.15/1K
  // beside solar-pro4 q 0.950 at $0.14/1K, both ±0.03 — a 300x price gap
  // for a difference the evidence cannot resolve.
  const terra = pt('terra-pro', 0.972, 44.1479, 0.03);
  const solar = pt('solar-pro4', 0.95, 0.1449, 0.03);
  const ling = pt('ling-flash', 0.886, 0.1094, 0.03);

  it('serves the cheapest point whose interval reaches the best point’s lower bound', () => {
    expect(infeasibleFallbackPoint([terra, solar, ling], terra).strategyHash).toBe('solar-pro4');
  });
  it('never admits a point the evidence CAN rank below the best', () => {
    // ling: upper 0.916 < terra lower 0.942 — excluded even though cheapest
    expect(infeasibleFallbackPoint([terra, ling], terra).strategyHash).toBe('terra-pro');
  });
  it('a CI-less frontier behaves as before: only equal-or-better quality qualifies', () => {
    const a = pt('best', 0.95, 4.0);
    const b = pt('mid', 0.9, 1.0);
    expect(infeasibleFallbackPoint([a, b], a).strategyHash).toBe('best');
    const tie = pt('best-cheaper-tie', 0.95, 2.0);
    expect(infeasibleFallbackPoint([a, b, tie], a).strategyHash).toBe('best-cheaper-tie');
  });
  it('rides resolveOperatingPoint: an unreachable floor serves the tied-cheapest point, flagged policy_infeasible', () => {
    const op = resolveOperatingPoint({ type: 'min_cost', qualityFloor: 0.99 }, frontierOf([terra, solar, ling]), null, {});
    expect(op.fallback).toBe(1);
    expect(op.fallbackReason).toBe('policy_infeasible');
    expect((op.config as { model?: string } | null)?.model).toBe('solar-pro4');
  });
});

// 2026-09-17: two tightenings of the tie rule were tried on the head-to-head
// and both lost. Pinned so the third attempt starts from the numbers.
describe('the tie rule stays the upper-bound tie (2026-09-17, #42)', () => {
  // rewrite-edit v5 in production, intervals verbatim: opus-fast 0.950 ±0.022
  // ($29.9/1K), sonnet 0.906 ±0.044 ($3.65/1K), gpt-mini 0.866 ±0.046, n=32.
  // Floor 0.95 is unreachable. opus lower = 0.928; sonnet upper = 0.950.
  const opus = pt('opus-fast', 0.95, 29.9265, 0.022);
  const sonnet = pt('sonnet', 0.90625, 3.6515, 0.044);
  const gptMini = pt('gpt-mini', 0.8656, 1.7076, 0.046);
  it('serves sonnet: its interval reaches opus’s lower bound, so the evidence cannot rank it below — 8x cheaper', () => {
    expect(infeasibleFallbackPoint([opus, sonnet, gptMini], opus).strategyHash).toBe('sonnet');
  });
  it('a MEAN-vs-lower-bound tie (tried as clause b) would have served opus-fast here — 6.79x against the auto-router — and is not the rule', () => {
    // sonnet mean 0.906 < opus lower 0.928: (b) excluded it; sonnet upper 0.950 ≥ 0.928: the upper-bound tie does not.
    expect(sonnet.quality).toBeLessThan(opus.quality - (opus.evidence?.qualityCi95 ?? 0));
    expect(infeasibleFallbackPoint([opus, sonnet, gptMini], opus).strategyHash).toBe('sonnet');
  });
  it('a MEASURED-at-bar clause (tried as clause a) would have served opus-fast too — 8.95x — and is not the rule', () => {
    const measuredAtBar = [opus, sonnet, gptMini].filter((p) => p.quality >= 0.95);
    expect(measuredAtBar.map((p) => p.strategyHash)).toEqual(['opus-fast']);
    expect(infeasibleFallbackPoint([opus, sonnet, gptMini], opus).strategyHash).toBe('sonnet');
  });
});
