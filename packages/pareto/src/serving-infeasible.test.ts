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
