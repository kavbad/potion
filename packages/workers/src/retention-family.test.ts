// The learning period's verdicts belong to a comparison FAMILY (P1-1,
// extended 2026-09-11): the interval widens with the family, so a trigger
// every eight samples cannot promote by repeated looks.
import { describe, expect, it } from 'vitest';
import { computeRetention } from './handlers.js';
import { isoWeekRange, observatoryRunFromLedger } from './observatory.js';

const pairs = Array.from({ length: 40 }, (_, i) => ({ itemId: `it-${String(i).padStart(2, '0')}`, candidateQuality: 0.8 + ((i * 7) % 10) / 50, incumbentQuality: 0.9 }));

describe('computeRetention — family-wise correction', () => {
  it('records alpha and comparisons, and a bigger family gives a LOWER lower bound (never a higher one)', () => {
    const one = computeRetention(pairs, { seedKey: 'k', floor: 0.9 }).retention!;
    const four = computeRetention(pairs, { seedKey: 'k', floor: 0.9, comparisons: 4 }).retention!;
    expect(one.alpha).toBeCloseTo(0.05, 12);
    expect(one.comparisons).toBe(1);
    expect(four.alpha).toBeCloseTo(0.0125, 12);
    expect(four.comparisons).toBe(4);
    expect(four.mean).toBeCloseTo(one.mean, 12);
    expect(four.ci95[0]).toBeLessThanOrEqual(one.ci95[0]);
    expect(four.ci95[1]).toBeGreaterThanOrEqual(one.ci95[1]);
  });
  it('a family below 1 is treated as 1', () => {
    expect(computeRetention(pairs, { seedKey: 'k', floor: 0.9, comparisons: 0 }).retention!.comparisons).toBe(1);
  });
});

describe('the run record from the ledgers', () => {
  it('isoWeekRange brackets the ISO week in UTC, Monday to Monday', () => {
    const r = isoWeekRange('2026-W37');
    expect(r.from.toISOString()).toBe('2026-09-07T00:00:00.000Z');
    expect(r.to.toISOString()).toBe('2026-09-14T00:00:00.000Z');
    expect(() => isoWeekRange('2026-09-07')).toThrow(/ISO week/);
  });
  it('composes the same shape the weekly script wrote, with no auditions and the proposals attached', () => {
    const run = observatoryRunFromLedger(
      '2026-W37',
      [{ clusterId: 'classification', model: 'or-ling-3.0-flash', strategyHash: 'h', storedQuality: 0.98, storedCi95: 0.02, observedMean: 0.7, n: 4, verdict: 'drift', spendUsd: 0.12 }],
      [{ clusterId: 'code-review', incumbentModel: 'or-gpt-full', servingModel: 'or-gpt-mini', incumbentQuality: 0.97, servingQuality: 0.95, suggestedFloor: 0.97, projectedSaving: 0.8, items: 40, status: 'proposed', createdAt: '2026-09-07T22:13:01Z' }],
      new Date('2026-09-11T00:00:00Z'),
    );
    expect(run.week).toBe('2026-W37');
    expect(run.auditions).toEqual([]);
    expect(run.canaries).toHaveLength(1);
    expect(run.proposals).toHaveLength(1);
    expect(run.spendUsd).toBeCloseTo(0.12, 9);
    expect(run.envelopeBefore.monthKey).toBe('2026-09');
  });
});
