import { describe, expect, it } from 'vitest';
import { scanRawValue } from './security.js';

// Step 12 (pass 3): the two copies of the credential vocabulary must not
// drift again. This is a divergence pin, not a duplicate of the scanner
// tests: it reads the CONVERTER's own source and asserts that every keyword
// it scrubs is a keyword this gate also refuses. A future copy that learns
// a word alone fails here rather than quietly opening a hole on one path.
describe('the duplicated secret vocabulary cannot drift (Step 12)', () => {
  it('every env-assignment keyword the converter scrubs is refused here too', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../../../scripts/claude-code-to-traces.ts', import.meta.url)),
      'utf8',
    );
    const m = /\(\?:KEY\|TOKEN\|SECRET\|PASSWORD([^)]*)\)/.exec(src);
    expect(m, 'the converter no longer has a recognisable env-assignment alternation').not.toBeNull();
    const extra = m![1]!.split('|').filter((w) => w.length > 0);
    for (const word of ['KEY', 'TOKEN', 'SECRET', 'PASSWORD', ...extra]) {
      const issues = scanRawValue({ rules: [`AWS_${word}=AKIAIOSFODNN7EXAMPLE`] });
      expect(
        issues.some((i) => i.code === 'secret-material'),
        `the converter scrubs ${word} but this gate accepts it`,
      ).toBe(true);
    }
  });
});
