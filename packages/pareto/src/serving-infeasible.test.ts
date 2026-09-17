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

// 2026-09-17, from the head-to-head: two ways the tie rule misread thin
// evidence, and the two clauses that fix them.
describe('infeasibleFallbackPoint, tightened 2026-09-17', () => {
  // rewrite-edit v5 in production: opus-fast measured 0.950 ($29.9/1K),
  // sonnet 0.906 ($3.65/1K), both n=32 (±~0.05). Floor 0.95.
  const opus = pt('opus-fast', 0.95, 29.9265, 0.05);
  const sonnet = pt('sonnet', 0.90625, 3.6515, 0.05);
  const gptMini = pt('gpt-mini', 0.8656, 1.7076, 0.05);
  it('(a) a point that MEASURED at the bar is served — the ask, unproven — over a cheaper point the interval merely cannot separate', () => {
    expect(infeasibleFallbackPoint([opus, sonnet, gptMini], opus, 0.95).strategyHash).toBe('opus-fast');
    // and the cheapest such point, when several measured at the bar
    const cheaperAtBar = pt('cheap-at-bar', 0.951, 0.5, 0.05);
    expect(infeasibleFallbackPoint([opus, sonnet, cheaperAtBar], opus, 0.95).strategyHash).toBe('cheap-at-bar');
  });
  // extraction v5 in production: best inkling-small ~0.93 (lower ~0.89),
  // granite-micro 0.775 with an interval wide enough (±0.10) to REACH 0.89
  // from below. The old rule served granite 20/20 in the head-to-head.
  const inkling = pt('inkling-small', 0.93, 0.35, 0.04);
  const granite = pt('granite-micro', 0.775, 0.0027, 0.1);
  const solar = pt('solar-pro4', 0.90, 0.02, 0.04);
  it('(b) with nothing measured at the bar, the tie is judged by the point’s MEAN against the best’s lower bound — a wide interval no longer admits a weak point', () => {
    const served = infeasibleFallbackPoint([inkling, granite, solar], inkling, 0.95);
    expect(served.strategyHash, 'granite: mean 0.775 < best lower 0.89 — excluded even though its upper bound 0.875… and old rule reached').toBe('solar-pro4');
    // and the old semantics (upper-bound tie) would have served granite:
    expect(granite.quality + (granite.evidence?.qualityCi95 ?? 0)).toBeLessThan(inkling.quality - (inkling.evidence?.qualityCi95 ?? 0) + 0.02);
  });
  it('rides resolveOperatingPoint with the policy floor: the measured-at-bar point serves under policy_infeasible', () => {
    const op = resolveOperatingPoint({ type: 'min_cost', qualityFloor: 0.95 }, frontierOf([opus, sonnet, gptMini]), null, {});
    expect(op.fallback).toBe(1);
    expect(op.fallbackReason).toBe('policy_infeasible');
    expect((op.config as { model?: string } | null)?.model).toBe('opus-fast');
  });
});
