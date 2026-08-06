import { describe, expect, it } from 'vitest';
import { mockEmbedText } from '@potion/providers';
import {
  centroidsFromTaxonomy,
  contentHash,
  createCachingEmbedder,
  type EmbeddingCache,
} from './centroids.js';
import type { Embedder } from './assigner.js';

const TAXONOMY = {
  version: 'test-v1',
  clusters: [
    { id: 'code-gen', name: 'c', description: 'c', exemplars: ['Write a Python function', 'Fix the bug in this code'] },
    { id: 'summarization', name: 's', description: 's', exemplars: ['Summarize this article', 'Write a Python function'] }, // dup exemplar across clusters
  ],
} as const;

function countingEmbedder() {
  const texts: string[] = [];
  const embedder: Embedder = {
    embed: async (ts) => {
      texts.push(...ts);
      return ts.map(mockEmbedText);
    },
  };
  return { embedder, texts };
}

describe('centroidsFromTaxonomy', () => {
  it('means exemplar embeddings and L2-normalizes each centroid', async () => {
    const { embedder } = countingEmbedder();
    const centroids = await centroidsFromTaxonomy(TAXONOMY, embedder);
    expect(centroids.size).toBe(2);
    const codeGen = centroids.get('code-gen')!;
    const expected = mockEmbedText('Write a Python function')
      .map((x, i) => (x + mockEmbedText('Fix the bug in this code')[i]!) / 2);
    const norm = Math.sqrt(expected.reduce((s, x) => s + x * x, 0));
    for (let i = 0; i < 384; i++) {
      expect(codeGen[i]).toBeCloseTo(expected[i]! / norm, 10);
    }
    for (const c of centroids.values()) {
      expect(Math.sqrt(c.reduce((s, x) => s + x * x, 0))).toBeCloseTo(1, 6);
    }
  });

  it('embeds duplicate exemplar content only once (content-hash cache)', async () => {
    const { embedder, texts } = countingEmbedder();
    await centroidsFromTaxonomy(TAXONOMY, embedder);
    // 3 unique exemplars, though 4 exemplar slots exist across the 2 clusters.
    expect([...new Set(texts)]).toHaveLength(3);
    expect(texts).toHaveLength(3);
  });

  it('reuses a caller-supplied cache across builds without re-embedding', async () => {
    const { embedder, texts } = countingEmbedder();
    const cache: EmbeddingCache = new Map();
    const first = await centroidsFromTaxonomy(TAXONOMY, embedder, cache);
    expect(texts.length).toBe(3);
    const second = await centroidsFromTaxonomy(TAXONOMY, embedder, cache);
    expect(texts.length).toBe(3); // no new embedder calls
    expect(second).toEqual(first);
  });

  it('rejects inconsistent embedding dimensions', async () => {
    const bad: Embedder = { embed: async (ts) => ts.map((_, i) => (i === 0 ? [1, 2] : [1, 2, 3])) };
    await expect(
      centroidsFromTaxonomy(
        { clusters: [{ id: 'x', exemplars: ['a', 'b'] }] },
        bad,
      ),
    ).rejects.toThrowError(/inconsistent embedding dim/);
  });
});

describe('createCachingEmbedder', () => {
  it('serves repeat texts from cache and keeps result order', async () => {
    const { embedder, texts } = countingEmbedder();
    const cached = createCachingEmbedder(embedder);
    const out = await cached.embed(['alpha', 'beta', 'alpha', 'gamma', 'beta']);
    expect(texts.sort()).toEqual(['alpha', 'beta', 'gamma']);
    expect(out.map((v) => v.length)).toEqual([384, 384, 384, 384, 384]);
    expect(out[0]).toEqual(out[2]);
    expect(out[1]).toEqual(out[4]);
    expect(out[0]).not.toEqual(out[1]);
  });
});

describe('contentHash', () => {
  it('is deterministic and content-sensitive', () => {
    expect(contentHash('hello')).toBe(contentHash('hello'));
    expect(contentHash('hello')).not.toBe(contentHash('hellp'));
  });
});
