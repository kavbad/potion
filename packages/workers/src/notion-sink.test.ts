import { describe, expect, it } from 'vitest';
import { observatoryEntryBlocks, postObservatoryEntry } from './notion-sink.js';
import type { ObservatoryRun } from './observatory.js';

const run: ObservatoryRun = {
  week: '2026-W35', at: '2026-08-24T06:00:00Z',
  envelopeBefore: { monthKey: '2026-08', capUsd: 50, mtdUsd: 0, remainingUsd: 50 },
  plan: { canaryClusters: ['code-gen'], canaryBudgetUsd: 0.15, auditions: 1, auditionBudgetUsd: 2, notes: ['x'] },
  canaries: [{ clusterId: 'code-gen', model: 'm', strategyHash: 'h', storedQuality: 0.9, storedCi95: 0.05, observedMean: 0.88, n: 4, verdict: 'ok', spendUsd: 0.02 }],
  auditions: [{ alias: 'or-x', clusterId: 'extraction', lane: 'extraction/json', why: 'w', spendUsd: 1.2, earnedSlot: false, frontierVersion: null }],
  catalogue: { listings: 300, newSinceRegistry: 10, skippedNoPricing: 0, freeTierExcluded: 2, ranked: 1 },
  spendUsd: 1.22,
  envelopeAfter: { monthKey: '2026-08', capUsd: 50, mtdUsd: 1.22, remainingUsd: 48.78 },
};

describe('notion sink', () => {
  it('builds a dated entry: heading, digest, canaries, auditions, spend', () => {
    const blocks = observatoryEntryBlocks(run) as Array<{ type: string }>;
    expect(blocks[0]!.type).toBe('heading_2');
    expect(blocks.map((b) => b.type)).toContain('bulleted_list_item');
    expect(JSON.stringify(blocks)).toContain('2026-W35');
    expect(JSON.stringify(blocks)).toContain('did not earn a slot');
  });
  it('posting is best-effort: a failing fetch returns a status, never throws', async () => {
    const bad = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    expect(await postObservatoryEntry({ token: 't', pageId: 'p', fetchImpl: bad }, run)).toMatch(/offline/);
    const ok = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    expect(await postObservatoryEntry({ token: 't', pageId: 'p', fetchImpl: ok }, run)).toBe('notion: posted');
  });
});
