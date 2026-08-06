// diffFrontiers unit tests on constructed frontiers (incl. empty-diff case).
import { describe, expect, it } from 'vitest';
import type { Frontier, FrontierPoint, StrategyConfig } from '@potion/core';
import { describeStrategy, diffFrontiers, formatPoint } from './diff.js';

const CASCADE: StrategyConfig = {
  type: 'cascade',
  stages: [
    { model: 'cheap-class', escalateIf: { confidenceBelow: 0.7 } },
    { model: 'frontier-class' },
  ],
  confidenceMethod: 'self-report-calibrated',
};
const DRAFT_VERIFY: StrategyConfig = {
  type: 'draft-verify',
  draftModel: 'cheap-class',
  verifierModel: 'frontier-class',
};
const SINGLE_FRONTIER: StrategyConfig = { type: 'single', model: 'frontier-class' };
const SINGLE_NEW: StrategyConfig = { type: 'single', model: 'mock-new-x' };

function point(hash: string, cfg: StrategyConfig, quality: number, cost: number, lat: number): FrontierPoint {
  return { clusterId: 'code-gen', strategyHash: hash, strategyConfig: cfg, quality, costPer1K: cost, latencyP95: lat };
}

function frontier(id: string, version: number, parentId: string | null, points: FrontierPoint[]): Frontier {
  return {
    id,
    clusterId: 'code-gen',
    version,
    parentId,
    trigger: 'recompute',
    points,
    pricesVersion: 'pv',
    createdAt: '2026-08-04T00:00:00.000Z',
  };
}

describe('diffFrontiers', () => {
  it('appeared / vanished / dominatedBy + full narrative', () => {
    // v1: cascade(cheap→frontier) mid-curve, single(frontier) top.
    const cascade = point('h-cascade', CASCADE, 0.82, 2.1, 2400);
    const singleF = point('h-single-f', SINGLE_FRONTIER, 0.95, 6.0, 1800);
    const from = frontier('fr-1', 1, null, [cascade, singleF]);

    // v2: draft-verify(cheap→frontier) appears and dominates the cascade
    // (higher quality, cheaper, faster); single(frontier) stays.
    const dv = point('h-dv', DRAFT_VERIFY, 0.88, 1.4, 2100);
    const to = frontier('fr-2', 2, 'fr-1', [dv, singleF]);

    const diff = diffFrontiers(from, to);
    expect(diff.clusterId).toBe('code-gen');
    expect(diff.fromVersion).toBe(1);
    expect(diff.toVersion).toBe(2);

    expect(diff.appeared.map((p) => p.strategyHash)).toEqual(['h-dv']);
    expect(diff.vanished.map((p) => p.strategyHash)).toEqual(['h-cascade']);
    expect(diff.dominatedBy).toHaveLength(1);
    expect(diff.dominatedBy[0]!.point.strategyHash).toBe('h-cascade');
    expect(diff.dominatedBy[0]!.dominatedBy.strategyHash).toBe('h-dv');

    expect(diff.narrative).toHaveLength(2);
    expect(diff.narrative[0]).toBe(
      'Strategy draft-verify(cheap-class→frontier-class) is new on the frontier: quality 0.88 at $1.40/1K, p95 2100ms.',
    );
    expect(diff.narrative[1]).toContain('cascade(cheap-class→frontier-class) fell off the frontier');
    expect(diff.narrative[1]).toContain('dominated by draft-verify(cheap-class→frontier-class)');
    expect(diff.narrative[1]).toContain('cheaper and higher quality and lower p95 latency');
  });

  it('empty diff: identical frontiers → no movement, single no-change sentence', () => {
    const pts = [point('h-a', SINGLE_FRONTIER, 0.9, 3, 1800)];
    const from = frontier('fr-1', 1, null, pts);
    const to = frontier('fr-2', 2, 'fr-1', pts);
    const diff = diffFrontiers(from, to);
    expect(diff.appeared).toEqual([]);
    expect(diff.vanished).toEqual([]);
    expect(diff.dominatedBy).toEqual([]);
    expect(diff.narrative).toEqual(['No change: the frontier is identical between v1 and v2.']);
  });

  it('vanished without a dominator (not re-evaluated) gets a plain sentence', () => {
    const a = point('h-a', SINGLE_FRONTIER, 0.9, 3, 1800);
    const b = point('h-b', CASCADE, 0.7, 1, 1200);
    const from = frontier('fr-1', 1, null, [a, b]);
    // b vanished but nothing in `to` dominates it (a is worse on cost AND quality mix:
    // a has higher quality but higher cost → no domination).
    const to = frontier('fr-2', 2, 'fr-1', [a]);
    const diff = diffFrontiers(from, to);
    expect(diff.vanished.map((p) => p.strategyHash)).toEqual(['h-b']);
    expect(diff.dominatedBy).toEqual([]);
    expect(diff.narrative.some((s) => s.includes('no longer among the non-dominated strategies'))).toBe(true);
  });

  it('dominatedBy can include a still-present point when its coordinates changed', () => {
    // Same hash survives in `to` but with worse coordinates; the OLD point is
    // dominated by a NEW entrant. (from-points are evaluated against to-points.)
    const oldA = point('h-a', SINGLE_FRONTIER, 0.9, 3, 1800);
    const from = frontier('fr-1', 1, null, [oldA]);
    const newA = point('h-a', SINGLE_FRONTIER, 0.85, 4, 2000);
    const newB = point('h-b', SINGLE_NEW, 0.92, 2, 1700);
    const to = frontier('fr-2', 2, 'fr-1', [newA, newB]);
    const diff = diffFrontiers(from, to);
    expect(diff.appeared.map((p) => p.strategyHash)).toEqual(['h-b']);
    expect(diff.vanished).toEqual([]);
    expect(diff.dominatedBy).toHaveLength(1);
    expect(diff.dominatedBy[0]!.dominatedBy.strategyHash).toBe('h-b');
  });
});

describe('describeStrategy / formatPoint', () => {
  it('labels all seven strategy types', () => {
    expect(describeStrategy({ type: 'single', model: 'm' })).toBe('single(m)');
    expect(describeStrategy(CASCADE)).toBe('cascade(cheap-class→frontier-class)');
    expect(
      describeStrategy({ type: 'best-of-n', model: 'm', n: 3, judge: { model: 'judge-class' } }),
    ).toBe('best-of-n(m×3, judge judge-class)');
    expect(describeStrategy(DRAFT_VERIFY)).toBe('draft-verify(cheap-class→frontier-class)');
    expect(
      describeStrategy({
        type: 'ensemble',
        models: ['a', 'b'],
        fusion: { method: 'judge-pick', judge: { model: 'judge-class' } },
      }),
    ).toBe('ensemble(a+b, judge judge-class)');
    expect(
      describeStrategy({ type: 'decompose', decomposerModel: 'm', routing: { '*': 'a' } }),
    ).toBe('decompose(m)');
    // M3 #23 (SPEC §12.6)
    expect(
      describeStrategy({
        type: 'composite',
        startModel: 'cheap-class',
        upgradeModel: 'frontier-class',
        upgradeIf: { confidenceBelow: 0.6 },
      }),
    ).toBe('composite(cheap-class→frontier-class@<0.6)');
  });

  it('formatPoint renders buyer units', () => {
    expect(formatPoint(point('h', SINGLE_FRONTIER, 0.823, 2.1, 2400))).toBe(
      'quality 0.82 at $2.10/1K, p95 2400ms',
    );
  });
});
