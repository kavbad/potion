import { describe, expect, it } from 'vitest';
import { priceDriftReport } from './price-drift.js';
import type { PriceTable } from '@potion/core';

const roster: PriceTable = { version: 't', updatedAt: '2026-08-23T00:00:00Z', entries: [
  { alias: 'or-a', provider: 'openrouter', model: 'x/a', inputPer1M: 1, outputPer1M: 4 },
  { alias: 'or-b', provider: 'openrouter', model: 'x/b', inputPer1M: 2, outputPer1M: 8 },
  { alias: 'or-gone', provider: 'openrouter', model: 'x/gone', inputPer1M: 1, outputPer1M: 1 },
  { alias: 'mock-cheap', provider: 'mock', model: 'mock', inputPer1M: 0, outputPer1M: 0 },
] };

describe('priceDriftReport', () => {
  it('flags movers past the threshold, names the vanished, skips the stable and the mock', () => {
    const r = priceDriftReport(roster, [
      { id: 'x/a', promptPerToken: 0.5e-6, completionPerToken: 2e-6 }, // −50%
      { id: 'x/b', promptPerToken: 2.1e-6, completionPerToken: 8.2e-6 }, // ~+2.6%
    ], 10, '2026-08-23');
    expect(r.checked).toBe(3);
    expect(r.movers.map((m) => m.alias)).toEqual(['or-a']);
    expect(r.movers[0]!.blendedDelta).toBeCloseTo(-0.5, 5);
    expect(r.missing).toEqual(['or-gone']);
    expect(r.markdown).toContain('1 mover');
    expect(r.markdown).toContain('or-gone');
  });
  it('a quiet catalog is a quiet report', () => {
    const r = priceDriftReport(roster, [
      { id: 'x/a', promptPerToken: 1e-6, completionPerToken: 4e-6 },
      { id: 'x/b', promptPerToken: 2e-6, completionPerToken: 8e-6 },
      { id: 'x/gone', promptPerToken: 1e-6, completionPerToken: 1e-6 },
    ]);
    expect(r.movers).toEqual([]);
    expect(r.missing).toEqual([]);
    expect(r.markdown).toContain('No movers');
  });
});
