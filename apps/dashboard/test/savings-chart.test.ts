// Unit tests for the savings bar mapping (M3 #21 shadow mode, SPEC §12.4).
import { describe, expect, it } from 'vitest';
import type { SavingsReportDto } from '../lib/types';
import {
  ACTUAL_COLOR,
  ALTERNATIVE_COLORS,
  buildSavingsBars,
  confidenceHint,
} from '../lib/savings-chart';

const REPORT: SavingsReportDto = {
  orgId: 'org_demo',
  from: '2026-08-01',
  to: '2026-08-30',
  actualSpendUsd: 12.5,
  alternatives: [
    {
      strategyHash: 'aaaabbbbccccdddd',
      label: 'single · mock-cheap',
      projectedSpendUsd: 3.25,
      projectedQuality: 0.61,
      deltaUsd: 9.25,
      sampleSize: 42,
      confidence: 'medium',
    },
    {
      strategyHash: 'eeeeffff00001111',
      label: 'cascade · mock-mid→mock-frontier',
      projectedSpendUsd: 14.0,
      projectedQuality: 0.9,
      deltaUsd: -1.5,
      sampleSize: 12,
      confidence: 'low',
    },
  ],
};

describe('buildSavingsBars', () => {
  it('puts the actual bar first in the accent color, alternatives after', () => {
    const { bars } = buildSavingsBars(REPORT);
    expect(bars).toHaveLength(3);
    expect(bars[0]).toMatchObject({
      key: 'actual',
      axisLabel: 'actual',
      kind: 'actual',
      spendUsd: 12.5,
      color: ACTUAL_COLOR,
      deltaUsd: null,
    });
    expect(bars[1]).toMatchObject({
      key: 'aaaabbbbccccdddd',
      axisLabel: 'aaaabbbb',
      kind: 'alternative',
      spendUsd: 3.25,
      deltaUsd: 9.25,
    });
    expect(bars[2]).toMatchObject({ key: 'eeeeffff00001111', deltaUsd: -1.5 });
  });

  it('cycles the muted alternative palette past the accent slot', () => {
    const { bars } = buildSavingsBars(REPORT);
    expect(bars[1]!.color).toBe(ALTERNATIVE_COLORS[0]);
    expect(bars[2]!.color).toBe(ALTERNATIVE_COLORS[1]);
    expect(bars.slice(1).map((b) => b.color)).not.toContain(ACTUAL_COLOR);
  });

  it('reports the y-axis ceiling as the max bar value', () => {
    expect(buildSavingsBars(REPORT).maxSpend).toBe(14.0);
    expect(
      buildSavingsBars({ ...REPORT, alternatives: [] }).maxSpend,
    ).toBe(12.5);
  });

  it('handles an empty window (zero actual, no alternatives)', () => {
    const { bars, maxSpend } = buildSavingsBars({
      orgId: 'org_demo',
      from: '2026-08-01',
      to: '2026-08-30',
      actualSpendUsd: 0,
      alternatives: [],
    });
    expect(bars).toHaveLength(1); // actual bar only → component shows empty state
    expect(bars[0]!.spendUsd).toBe(0);
    expect(maxSpend).toBe(0);
  });
});

describe('confidenceHint', () => {
  it('maps each tier to plain-language copy', () => {
    expect(confidenceHint('low')).toContain('directional');
    expect(confidenceHint('medium')).toContain('reasonable');
    expect(confidenceHint('high')).toContain('solid');
  });
});
