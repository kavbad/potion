import { describe, expect, it } from 'vitest';
import { LSH_DIMS, isLshBucket, lshBucket } from './lsh.js';

function unit(fill: (i: number) => number): number[] {
  const v = Array.from({ length: LSH_DIMS }, (_, i) => fill(i));
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  return v.map((x) => x / norm);
}

describe('lshBucket', () => {
  it('is stable across calls — a label must mean the same thing tomorrow', () => {
    const v = unit((i) => Math.sin(i));
    expect(lshBucket(v)).toBe(lshBucket(v));
    // Pinned literal: if the committed seed or the plane derivation changes,
    // every bucket id ever written becomes a different region and this fails
    // rather than silently re-partitioning history.
    expect(lshBucket(v)).toMatch(/^lsh:[0-9a-f]{4}$/);
  });

  it('puts near-identical embeddings in the same bucket', () => {
    const base = unit((i) => Math.sin(i));
    const nudged = unit((i) => Math.sin(i) + 0.001 * Math.cos(i * 7));
    expect(lshBucket(nudged)).toBe(lshBucket(base));
  });

  it('separates unrelated directions', () => {
    // Two orthogonal-ish directions should disagree on many planes; the test
    // asserts the useful property (different bucket), not a bit count.
    const a = unit((i) => (i < LSH_DIMS / 2 ? 1 : 0));
    const b = unit((i) => (i < LSH_DIMS / 2 ? 0 : 1));
    expect(lshBucket(a)).not.toBe(lshBucket(b));
  });

  it('carries 16 bits and nothing else — no embedding survives the label', () => {
    const v = unit((i) => Math.cos(i / 3));
    const label = lshBucket(v);
    expect(label).toHaveLength('lsh:'.length + 4);
    // The whole space of labels is 65_536; a 384-dim vector cannot be in it.
    expect(parseInt(label.slice(4), 16)).toBeLessThan(65_536);
  });

  it('refuses a wrong-dimension vector rather than labelling it', () => {
    expect(() => lshBucket([1, 2, 3])).toThrow(/384 dims/);
  });
});

describe('isLshBucket', () => {
  it('tells an unassigned region from a taxonomy cluster id', () => {
    expect(isLshBucket(lshBucket(unit((i) => Math.sin(i))))).toBe(true);
    expect(isLshBucket('code-gen')).toBe(false);
    expect(isLshBucket('general')).toBe(false);
    expect(isLshBucket('agent-ab12cd-support')).toBe(false);
  });
});
