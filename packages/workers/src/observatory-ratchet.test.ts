import { describe, expect, it } from 'vitest';
import { ratchetReport, type RatchetRun } from './observatory-ratchet.js';

const run = (week: string, at: string, earned: boolean): RatchetRun => ({
  week, at, spendUsd: 2,
  canaries: [{ clusterId: 'code-gen', model: 'm1', verdict: 'ok', spendUsd: 1 }, { clusterId: 'extraction', model: 'm2', verdict: 'drift', spendUsd: 1 }],
  auditions: [{ alias: 'a1', clusterId: 'code-gen', lane: 'code', earnedSlot: earned, spendUsd: 0.5 }],
  catalogue: { newSinceRegistry: 12 },
});

describe('ratchetReport', () => {
  it('states the roster against the line, the month’s spend by lane, drift and earned slots', () => {
    const now = new Date('2026-08-30T00:00:00Z'); // day 10 of 30 → line at 28 + 17/3 ≈ 33.7
    const r = ratchetReport([run('2026-W34', '2026-08-22T07:00:00Z', false), run('2026-W35', '2026-08-29T07:00:00Z', true)], [
      { at: '2026-08-22T07:00:00Z', week: '2026-W34', lane: 'canary', spendUsd: 1.5, detail: '' },
      { at: '2026-08-22T07:00:00Z', week: '2026-W34', lane: 'audition', spendUsd: 0.5, detail: '' },
      { at: '2026-07-30T07:00:00Z', week: '2026-W31', lane: 'canary', spendUsd: 9, detail: 'last month — excluded' },
    ], Array.from({ length: 30 }, (_, i) => `m${i}`), now);
    expect(r).toContain('**30** models');
    expect(r).toContain('33.7');
    expect(r).toContain('behind by 3.7');
    expect(r).toContain('| canary | $1.50 |');
    expect(r).toContain('**$2.00** of the $50 envelope');
    expect(r).toContain('2 drift alarms');
    expect(r).toContain('2 tried, 1 earned a slot (a1 on code-gen)');
    expect(r).not.toContain('last month');
  });
});
