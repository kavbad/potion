// Hash identity for harness specs — the assertReproducible discipline from
// post-capstone item (0): if the hash is not byte-stable across re-reads of
// unchanged content, the gate built on it becomes a random refusal generator.
import { describe, expect, it } from 'vitest';
import { harnessSpecHash } from './hash.js';
import type { HarnessSpec } from './types.js';

const SPEC: HarnessSpec = {
  specVersion: 1,
  name: 'Hash test harness',
  brain: { policy: { type: 'min_cost', qualityFloor: 0.8 } },
  mission: { kind: 'task', goal: 'g', doneDefinition: 'd' },
  superpowers: [{ id: 'catalog/x', scopes: ['a', 'b'] }],
  memory: { enabled: true, retentionDays: 30 },
  rules: ['r1', 'r2'],
  fuel: { maxUsdPerRun: 1, maxUsdPerDay: 5, hardStop: true },
  checkIns: [{ trigger: 'on-budget-fraction', fraction: 0.5 }],
};

describe('harnessSpecHash', () => {
  it('is byte-stable across repeated computation', () => {
    expect(harnessSpecHash(SPEC)).toBe(harnessSpecHash(SPEC));
  });

  it('is independent of key insertion order', () => {
    // Same content, keys inserted in a different order.
    const shuffled = JSON.parse(
      JSON.stringify({
        checkIns: SPEC.checkIns,
        fuel: { hardStop: true, maxUsdPerDay: 5, maxUsdPerRun: 1 },
        rules: SPEC.rules,
        memory: { retentionDays: 30, enabled: true },
        superpowers: SPEC.superpowers,
        mission: { doneDefinition: 'd', goal: 'g', kind: 'task' },
        brain: { policy: { qualityFloor: 0.8, type: 'min_cost' } },
        name: 'Hash test harness',
        specVersion: 1,
      }),
    ) as HarnessSpec;
    expect(harnessSpecHash(shuffled)).toBe(harnessSpecHash(SPEC));
  });

  it('excludes the embedded hash field from the hashed content', () => {
    const base = harnessSpecHash(SPEC);
    expect(harnessSpecHash({ ...SPEC, hash: base })).toBe(base);
    expect(harnessSpecHash({ ...SPEC, hash: '0'.repeat(64) })).toBe(base);
  });

  it('changes when ANY slot changes', () => {
    const base = harnessSpecHash(SPEC);
    const mutations: Array<Partial<HarnessSpec>> = [
      { name: 'Renamed' },
      { brain: { policy: { type: 'min_cost', qualityFloor: 0.81 } } },
      { mission: { kind: 'task', goal: 'g2', doneDefinition: 'd' } },
      { superpowers: [] },
      { memory: { enabled: false } },
      { rules: ['r1'] },
      { fuel: { maxUsdPerRun: 2, hardStop: true } },
      { checkIns: [] },
    ];
    for (const m of mutations) {
      expect(harnessSpecHash({ ...SPEC, ...m }), JSON.stringify(m)).not.toBe(base);
    }
  });

  it('array ORDER is identity — rules in a different order are a different harness', () => {
    // Rules are read in order by the runtime, so order is meaning, not noise.
    const reordered = { ...SPEC, rules: ['r2', 'r1'] };
    expect(harnessSpecHash(reordered)).not.toBe(harnessSpecHash(SPEC));
  });
});
