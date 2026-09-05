// The price-table version must key cache cells without publishing identities.
//
// Regression cover for the 2026-09-05 outage: mergePriceEntry built the
// version as `${base.version}+${alias}`, so the live registry's version became
// a 6,549-character list of 333 model names — one of them a sibling of the
// withheld winner, which took /api/public/answers down when the redaction
// sweep found it in the published payload.
import { describe, expect, it } from 'vitest';
import type { PriceEntry, PriceTable } from '@potion/core';
import { mergePriceEntry, nextPricesVersion } from './recompute.js';

const entry = (over: Partial<PriceEntry> = {}): PriceEntry => ({
  alias: 'or-new-model',
  provider: 'openrouter',
  model: 'vendor/new-model',
  inputPer1M: 1,
  outputPer1M: 2,
  ...over,
});

const table = (version: string): PriceTable => ({
  version,
  updatedAt: '2026-09-05',
  entries: [entry({ alias: 'or-known', model: 'vendor/known' })],
});

const SEED = '2026-08-04-or2+tranche-2026-08-19';

describe('the version never carries a model identity', () => {
  it('does not embed the alias — the bug that leaked a withheld name', () => {
    const v = nextPricesVersion(SEED, entry({ alias: 'or-solar-pro-3', model: 'upstage/solar-pro-3' }));
    expect(v).not.toContain('solar');
    expect(v).not.toContain('upstage');
    expect(v).not.toContain('or-solar-pro-3');
  });

  it('does not embed the model id or provider either', () => {
    const v = nextPricesVersion(SEED, entry({ alias: 'or-x', provider: 'openrouter', model: 'acme/secret-7b' }));
    expect(v).not.toContain('secret-7b');
    expect(v).not.toContain('acme');
  });

  it('stays bounded across many additions — one rolling segment, not 333', () => {
    let t = table(SEED);
    for (let i = 0; i < 400; i++) t = mergePriceEntry(t, entry({ alias: `or-model-${i}`, model: `v/model-${i}` }));
    expect(t.version.startsWith(`${SEED}+r`)).toBe(true);
    expect(t.version.split('+')).toHaveLength(3);
    expect(t.version.length).toBeLessThan(SEED.length + 16);
  });
});

describe('the cache-invalidation contract still holds', () => {
  it('a NEW model moves the version', () => {
    expect(nextPricesVersion(SEED, entry({ alias: 'or-a' }))).not.toBe(
      nextPricesVersion(SEED, entry({ alias: 'or-b' })),
    );
    expect(nextPricesVersion(SEED, entry())).not.toBe(SEED);
  });

  it('RE-PRICING a known model moves it — a bare +n<count> would not have', () => {
    const cheap = nextPricesVersion(SEED, entry({ inputPer1M: 1, outputPer1M: 2 }));
    const dear = nextPricesVersion(SEED, entry({ inputPer1M: 9, outputPer1M: 20 }));
    expect(cheap).not.toBe(dear);
  });

  it('is deterministic: same base, same entry, same version', () => {
    expect(nextPricesVersion(SEED, entry())).toBe(nextPricesVersion(SEED, entry()));
  });

  it('is chained — the same entry on a different history gives a different version', () => {
    expect(nextPricesVersion(SEED, entry())).not.toBe(nextPricesVersion(`${SEED}+rdeadbeef01`, entry()));
  });

  it('leaves versions already stored alone: minting is pure, nothing is re-derived', () => {
    const before = table(SEED);
    const after = mergePriceEntry(before, entry());
    expect(before.version).toBe(SEED);
    expect(after.version).not.toBe(SEED);
  });
});

describe('mergePriceEntry still merges entries the way it always did', () => {
  it('replaces a re-priced alias rather than duplicating it', () => {
    const t = mergePriceEntry(table(SEED), entry({ alias: 'or-known', model: 'vendor/known', inputPer1M: 99 }));
    expect(t.entries.filter((e) => e.alias === 'or-known')).toHaveLength(1);
    expect(t.entries.find((e) => e.alias === 'or-known')?.inputPer1M).toBe(99);
  });

  it('appends a genuinely new alias', () => {
    const t = mergePriceEntry(table(SEED), entry());
    expect(t.entries.map((e) => e.alias).sort()).toEqual(['or-known', 'or-new-model']);
  });
});
