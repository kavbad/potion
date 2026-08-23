// The committed price table is the serving roster (909ee10). A mock scan that
// runs against the default path stamps mock aliases into it, and that file
// then ships to production by rsync (found 2026-08-22: or-mock-nova-1 and
// or-mock-apex-1 in the live table). The alias guards keep them unroutable;
// this test keeps them out of the commit in the first place.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');

describe('canonical prices.json', () => {
  const table = JSON.parse(readFileSync(resolve(ROOT, 'prices.json'), 'utf8')) as {
    version: string;
    entries: { alias: string; provider: string }[];
  };
  it('carries no scan-fixture aliases (the design-time mock aliases are allowed; the alias guards cover them)', () => {
    expect(table.entries.map((e) => e.alias).filter((a) => /^or-mock-/.test(a))).toEqual([]);
  });
  it('has no scan stamp in its version', () => {
    expect(table.version).not.toMatch(/mock/);
  });
});
