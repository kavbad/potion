// AUDIT DIRECTION 3 — THE DRAW FENCE (spec §3): the draw layer consumes
// FormState + theme and NOTHING else. A pixel that wants new data must
// route through deriveFormState and therefore through the audit. Same
// structural-fence pattern as replay.ts's import fence.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const srcOf = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url).href.replace('/dist/', '/src/')), 'utf8');

describe('draw.ts is fenced to FormState + theme', () => {
  const src = srcOf('draw.ts');

  it('imports only form-state and theme', () => {
    const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]!);
    for (const i of imports) {
      expect(
        i === './form-state.js' || i === './theme.js',
        `draw.ts imports '${i}' — outside the fence`,
      ).toBe(true);
    }
  });

  it('references no DTO type, no fetch, no db, no fabricated randomness', () => {
    expect(src).not.toMatch(/HarnessDto|MemoryDto|RunDto|dto\.js/);
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/@potion\/db|drizzle/);
    // The interpolation honesty rule at the code level: the draw layer may
    // phase eases with the clock but may not invent events with randomness.
    expect(src).not.toMatch(/Math\.random/);
    expect(src).not.toMatch(/Date\.now/);
  });
});

describe('deriveFormState is pure of I/O', () => {
  const src = srcOf('form-state.ts');
  it('no fetch, no db, no clock reads (pollAgeMs is an ARGUMENT)', () => {
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/@potion\/db/);
    expect(src).not.toMatch(/Date\.now|performance\.now/);
  });
});
