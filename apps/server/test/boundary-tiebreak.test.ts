import { describe, expect, it } from 'vitest';
import { boundaryClusterId, boundaryServes, pickSafer } from '../src/routing/ambiguity.js';

describe('the boundary frontier stands in for the tiebreak when it has a measured point', () => {
  it('names the boundary the same way from either side', () => {
    expect(boundaryClusterId('multi-step-reasoning', 'extraction')).toBe('extraction+multi-step-reasoning');
    expect(boundaryClusterId('extraction', 'multi-step-reasoning')).toBe('extraction+multi-step-reasoning');
  });
  it('a measured boundary point serves', () => {
    expect(boundaryServes({ op: { fallback: 0 as const, config: { type: 'single', model: 'x' } } })).toBe(true);
  });
  it('a fallback, an empty frontier, or no frontier at all does NOT — the tiebreak still decides', () => {
    expect(boundaryServes({ op: { fallback: 1 as const, config: { type: 'single', model: 'x' } } })).toBe(false);
    expect(boundaryServes({ op: { fallback: 0 as const, config: null } })).toBe(false);
    expect(boundaryServes(null)).toBe(false);
    // and the tiebreak it falls back to is unchanged
    expect(pickSafer({ clusterId: 'a', quality: 0.9, costPer1K: 1 }, { clusterId: 'b', quality: 0.8, costPer1K: 0.1 }).clusterId).toBe('a');
  });
});
