// The learning period measures on CHANGE, not on a clock (2026-09-11).
import { describe, expect, it } from 'vitest';
import { LEARNING_RETRIGGER_MIN_NEW_SAMPLES, measurementTrigger } from './learning-period.js';
import { MEASUREMENT_MONTHLY_CAP_USD, MEASUREMENT_MONTHLY_FLOOR_USD, measurementCeilingUsd } from './measurement-budget.js';

const at = (iso: string) => new Date(iso);
const many = (iso: string, n: number) => Array.from({ length: n }, () => at(iso));

describe('measurementTrigger — when a kind of work is worth re-measuring', () => {
  const prev = { createdAt: at('2026-09-06T04:00:00Z'), frontierVersion: 5 };
  it('measures once when nothing has ever been proposed', () => {
    expect(measurementTrigger(undefined, { frontierVersion: 5, sampleTs: [], challengerQualified: false })).toBe('first measurement');
  });
  it('does NOT re-measure when the frontier, the samples and the challengers are unchanged — however old the proposal', () => {
    expect(measurementTrigger(prev, { frontierVersion: 5, sampleTs: many('2026-09-05T00:00:00Z', 40), challengerQualified: false })).toBeNull();
    expect(measurementTrigger(prev, { frontierVersion: 5, sampleTs: [], challengerQualified: false })).toBeNull();
  });
  it('re-measures when the frontier it measured against has moved', () => {
    expect(measurementTrigger(prev, { frontierVersion: 6, sampleTs: [], challengerQualified: false })).toMatch(/frontier moved v5 → v6/);
  });
  it('re-measures when ENOUGH samples arrived after the proposal — a trickle does not re-run the judge', () => {
    const before = many('2026-09-05T00:00:00Z', 10);
    const trickle = many('2026-09-07T00:00:00Z', LEARNING_RETRIGGER_MIN_NEW_SAMPLES - 1);
    expect(measurementTrigger(prev, { frontierVersion: 5, sampleTs: [...before, ...trickle], challengerQualified: false })).toBeNull();
    const enough = many('2026-09-07T00:00:00Z', LEARNING_RETRIGGER_MIN_NEW_SAMPLES);
    expect(measurementTrigger(prev, { frontierVersion: 5, sampleTs: [...before, ...enough], challengerQualified: false })).toMatch(/new samples/);
  });
  it('re-measures when a challenger qualified', () => {
    expect(measurementTrigger(prev, { frontierVersion: 5, sampleTs: [], challengerQualified: true })).toMatch(/challenger/);
  });
  it('re-measures on PROVIDER DRIFT — the only external trigger — when the tripwire fired after the proposal', () => {
    const drift = { detectedAt: at('2026-09-08T06:00:00Z'), model: 'or-ling-3.0-flash' };
    expect(measurementTrigger(prev, { frontierVersion: 5, sampleTs: [], challengerQualified: false, drift })).toMatch(/provider drift on or-ling-3.0-flash/);
    // a drift the proposal already post-dates is not news
    const old = { detectedAt: at('2026-09-01T06:00:00Z'), model: 'or-ling-3.0-flash' };
    expect(measurementTrigger(prev, { frontierVersion: 5, sampleTs: [], challengerQualified: false, drift: old })).toBeNull();
  });
  it('a proposal written before versions were tracked is re-measured once', () => {
    expect(measurementTrigger({ ...prev, frontierVersion: null }, { frontierVersion: 5, sampleTs: [], challengerQualified: false })).toMatch(/predates/);
  });
});

describe('measurementCeilingUsd — cost of goods sized to the revenue it serves', () => {
  it('is a share of trailing serving spend, floored so a new org can be measured at all', () => {
    expect(measurementCeilingUsd(0)).toBe(MEASUREMENT_MONTHLY_FLOOR_USD);
    expect(measurementCeilingUsd(0.51)).toBe(MEASUREMENT_MONTHLY_FLOOR_USD); // the org that found this: $0.51 serving, $2.95 measured
    expect(measurementCeilingUsd(40)).toBeCloseTo(10, 9);
  });
  it('is capped', () => {
    expect(measurementCeilingUsd(1_000_000)).toBe(MEASUREMENT_MONTHLY_CAP_USD);
  });
});

describe('looksSinceLastApplied — the repeated-look half of the comparison family', () => {
  it('counts proposals for the cluster newer than its last applied one', async () => {
    const { looksSinceLastApplied } = await import('./learning-period.js');
    const rows = [
      { clusterId: 'code-review', status: 'proposed' },
      { clusterId: 'summarization', status: 'proposed' },
      { clusterId: 'code-review', status: 'proposed' },
      { clusterId: 'code-review', status: 'applied' },
      { clusterId: 'code-review', status: 'proposed' },
    ];
    expect(looksSinceLastApplied(rows, 'code-review')).toBe(2);
    expect(looksSinceLastApplied(rows, 'summarization')).toBe(1);
    expect(looksSinceLastApplied(rows, 'extraction')).toBe(0);
  });
});
