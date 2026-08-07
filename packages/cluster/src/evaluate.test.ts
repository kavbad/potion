// Gate-2 evaluate CLI plumbing (G0.5): sweep parsing. The evaluation flow
// itself is exercised by the script (mock run pinned in the Gate-2 proof);
// resolveEmbedder + createCachingEmbedder carry their own tests.
import { describe, expect, it } from 'vitest';
import { parseArgs } from './evaluate.js';
import { DEFAULT_THRESHOLD } from './assigner.js';

describe('evaluate parseArgs', () => {
  it('defaults to a single DEFAULT_THRESHOLD evaluation', () => {
    expect(parseArgs([]).thresholds).toEqual([DEFAULT_THRESHOLD]);
  });

  it('--sweep parses a comma list; bounds enforced', () => {
    expect(parseArgs(['--sweep', '0.1,0.2,0.35']).thresholds).toEqual([0.1, 0.2, 0.35]);
    expect(() => parseArgs(['--sweep', '0.1,1.5'])).toThrow(/invalid --sweep/);
    expect(() => parseArgs(['--sweep', 'abc'])).toThrow(/invalid --sweep/);
  });

  it('--threshold still selects exactly one', () => {
    expect(parseArgs(['--threshold', '0.4']).thresholds).toEqual([0.4]);
  });
});
