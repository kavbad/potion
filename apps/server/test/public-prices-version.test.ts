// /api/public/answers must never publish a version string it has not swept.
//
// The 2026-09-05 outage, exactly: the live registry's version had grown into a
// list of 333 aliases, `research:scan` added a sibling of the withheld winner,
// and `pricesVersion` carried it into the payload. findLeaks caught it and the
// route failed closed — correct behaviour, but the endpoint was down for every
// caller until the field stopped carrying identities.
import { describe, expect, it } from 'vitest';
import { findLeaks } from '@potion/workers';
import { publicPricesVersion } from '../src/routes/public-answers.js';

const SEED = '2026-08-04-or2+tranche-2026-08-19';
/** The shape of the string that was live in production when this broke. */
const LEAKY = `${SEED}+or-hy4-preview+or-qwen3-8-fla+or-solar-pro-3+or-palmyra-x5+or-gpt-audio`;

describe('the published version is swept', () => {
  it('the string that took production down is clean once published', () => {
    expect(findLeaks(LEAKY).length).toBeGreaterThan(0); // the bug, still reproducible
    expect(findLeaks(publicPricesVersion(LEAKY))).toHaveLength(0); // the fix
  });

  it('publishes no alias from the internal version', () => {
    const out = publicPricesVersion(LEAKY);
    expect(out).not.toContain('solar');
    expect(out).not.toContain('or-palmyra-x5');
    expect(out).not.toContain('or-gpt-audio');
  });

  it('drops even the readable head if that head is ever embargoed', () => {
    const out = publicPricesVersion('solar-pro-3+upstage-catalog+or-x');
    expect(findLeaks(out)).toHaveLength(0);
    expect(out).toMatch(/^r[0-9a-f]{10}$/);
  });

  it('stays short no matter how long the internal version is', () => {
    const huge = SEED + '+or-model'.repeat(400);
    expect(publicPricesVersion(huge).length).toBeLessThan(SEED.length + 16);
  });
});

describe('change detection survives the redaction', () => {
  it('a catalog change changes the published version', () => {
    expect(publicPricesVersion(`${SEED}+ra1b2c3d4e5`)).not.toBe(publicPricesVersion(`${SEED}+rf6e5d4c3b2`));
  });

  it('an unchanged catalog publishes an unchanged version — no spurious "prices moved" note', () => {
    expect(publicPricesVersion(LEAKY)).toBe(publicPricesVersion(LEAKY));
  });

  it('keeps the seed head readable so the field still means something', () => {
    expect(publicPricesVersion(LEAKY).startsWith(`${SEED}+r`)).toBe(true);
  });
});
