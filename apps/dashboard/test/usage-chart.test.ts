// Unit tests for the usage stacked-bar mapping (M2 Wave 2, ROADMAP #17/#18).
import { describe, expect, it } from 'vitest';
import type { UsageDayRowDto } from '../lib/types';
import {
  buildUsageStacks,
  clusterColor,
  CLUSTER_COLORS,
  formatDay,
  formatUsd,
} from '../lib/usage-chart';

const ROWS: UsageDayRowDto[] = [
  {
    day: '2026-08-02',
    requests: 5,
    inputTokens: 310,
    outputTokens: 155,
    costUsd: 0.031,
    platformCostUsd: 0.031,
    clusters: [
      { clusterId: 'extraction', requests: 2, inputTokens: 10, outputTokens: 5, costUsd: 0.001, platformCostUsd: 0.001 },
      { clusterId: 'code-gen', requests: 3, inputTokens: 300, outputTokens: 150, costUsd: 0.03, platformCostUsd: 0.03 },
    ],
  },
  {
    day: '2026-08-01',
    requests: 1,
    inputTokens: 7,
    outputTokens: 3,
    costUsd: 0.0007,
    platformCostUsd: 0.0007,
    clusters: [
      { clusterId: 'code-gen', requests: 1, inputTokens: 7, outputTokens: 3, costUsd: 0.0007, platformCostUsd: 0.0007 },
    ],
  },
];

describe('buildUsageStacks', () => {
  it('orders days ascending and stacks segments in sorted cluster order', () => {
    const s = buildUsageStacks(ROWS);
    expect(s.bars.map((b) => b.day)).toEqual(['2026-08-01', '2026-08-02']);
    expect(s.clusters).toEqual(['code-gen', 'extraction']);
    const d2 = s.bars[1]!;
    expect(d2.total).toBe(5);
    expect(d2.segments.map((seg) => [seg.clusterId, seg.y0, seg.y1])).toEqual([
      ['code-gen', 0, 3],
      ['extraction', 3, 5],
    ]);
    // segments tile the bar exactly: sum of segment heights == day total
    expect(d2.segments.reduce((sum, seg) => sum + (seg.y1 - seg.y0), 0)).toBe(d2.total);
    expect(s.maxTotal).toBe(5);
    expect(s.grandTotal).toBe(6);
  });

  it('handles empty input', () => {
    expect(buildUsageStacks([])).toEqual({ bars: [], maxTotal: 0, clusters: [], grandTotal: 0 });
  });

  it('colors are deterministic by sorted cluster order', () => {
    const order = ['code-gen', 'extraction'];
    expect(clusterColor('code-gen', order)).toBe(CLUSTER_COLORS[0]);
    expect(clusterColor('extraction', order)).toBe(CLUSTER_COLORS[1]);
    expect(clusterColor('unknown', order)).toBe(CLUSTER_COLORS[2]); // falls past known ids
  });
});

describe('formatters', () => {
  it('formatDay renders UTC month-day', () => {
    expect(formatDay('2026-08-02')).toBe('Aug 2');
    expect(formatDay('2026-12-31')).toBe('Dec 31');
  });
  it('formatUsd keeps sub-cent precision only when needed', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.0007)).toBe('$0.0007');
    expect(formatUsd(0.031)).toBe('$0.03');
    expect(formatUsd(12.5)).toBe('$12.50');
  });
});
