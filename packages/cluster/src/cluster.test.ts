import { describe, expect, it } from 'vitest';
import { mockEmbedText } from '@potion/providers';
import {
  cosine,
  createAssigner,
  centroidsFromTaxonomy,
  DEFAULT_THRESHOLD,
  type Embedder,
  type Taxonomy,
} from './index.js';

/**
 * Small inline taxonomy fixture (STUB_TAXONOMY was removed from the public
 * API in Phase 2). Exemplars use the keyword vocabulary of the mock embedder
 * contract (SPEC §4) so mock embeddings of exemplar-like texts land near
 * their cluster centroid.
 */
const TEST_TAXONOMY: Taxonomy = {
  version: 'test-v1',
  clusters: [
    {
      id: 'code-gen',
      name: 'Code generation',
      description: 'Write or fix code, functions, scripts, algorithms.',
      exemplars: [
        'Write a Python function that reverses a linked list',
        'Fix the bug in this JavaScript function',
        'Implement an algorithm to compile regex matches in code',
      ],
    },
    {
      id: 'extraction',
      name: 'Structured extraction',
      description: 'Extract fields/entities from text into JSON.',
      exemplars: [
        'Extract the invoice total and date as JSON',
        'Parse this email and extract all name fields into JSON',
        'Extract every entity mentioned in the contract as JSON',
      ],
    },
    {
      id: 'summarization',
      name: 'Summarization',
      description: 'Condense long text into brief summaries.',
      exemplars: [
        'Summarize this article in three sentences',
        'TL;DR of this meeting transcript',
        'Give me a brief summary of the quarterly report',
      ],
    },
  ],
};

const mockEmbedder: Embedder = { embed: async (texts) => texts.map(mockEmbedText) };

async function makeAssigner(threshold?: number) {
  const centroids = await centroidsFromTaxonomy(TEST_TAXONOMY, mockEmbedder);
  return createAssigner(mockEmbedder, centroids, threshold);
}

describe('centroidsFromTaxonomy', () => {
  it('produces one unit-norm centroid per cluster', async () => {
    const centroids = await centroidsFromTaxonomy(TEST_TAXONOMY, mockEmbedder);
    expect([...centroids.keys()].sort()).toEqual(['code-gen', 'extraction', 'summarization']);
    for (const c of centroids.values()) {
      expect(c).toHaveLength(384);
      expect(Math.sqrt(c.reduce((s, x) => s + x * x, 0))).toBeCloseTo(1, 6);
    }
  });
});

describe('createAssigner with mock embedder', () => {
  it('assigns exemplar-like prompts to their seeded cluster with high confidence', async () => {
    const assigner = await makeAssigner();
    const cases: Array<[string, string]> = [
      ['Write a Python function that checks whether a string is a palindrome', 'code-gen'],
      ['Extract all dates and amounts from this receipt as JSON', 'extraction'],
      ['Summarize this 10-page report into a brief TL;DR', 'summarization'],
    ];
    for (const [text, expected] of cases) {
      const a = await assigner.assign(text);
      expect(a.clusterId).toBe(expected);
      expect(a.confidence).toBeGreaterThan(DEFAULT_THRESHOLD);
    }
  });

  it('exposes confidence = cosine similarity to the best centroid', async () => {
    const centroids = await centroidsFromTaxonomy(TEST_TAXONOMY, mockEmbedder);
    const assigner = createAssigner(mockEmbedder, centroids);
    const text = 'Implement a function to fix the bug in this code';
    const a = await assigner.assign(text);
    const expected = cosine(mockEmbedText(text), centroids.get('code-gen')!);
    expect(a.clusterId).toBe('code-gen');
    expect(a.confidence).toBeCloseTo(expected, 12);
  });

  it('falls back to general below the default threshold (0.62)', async () => {
    const assigner = await makeAssigner();
    const a = await assigner.assign('the and of to a in is it'); // no cluster keywords
    expect(a.clusterId).toBe('general');
    expect(a.confidence).toBeLessThan(DEFAULT_THRESHOLD);
  });

  it('honors a custom threshold in both directions', async () => {
    const text = 'Write a Python function to sort a list';
    const strict = await makeAssigner(0.999);
    const a = await strict.assign(text);
    expect(a.clusterId).toBe('general'); // even same-cluster noise fails 0.999
    expect(a.confidence).toBeGreaterThan(0.9); // still high cosine, just under threshold

    const lax = await makeAssigner(0.01);
    const b = await lax.assign('the and of to a in is it');
    expect(b.clusterId).not.toBe('general'); // tiny threshold accepts nearest centroid
  });

  it('assignBatch matches assign, embeds concurrently, and preserves order', async () => {
    const calls: number[] = [];
    const countingEmbedder: Embedder = {
      embed: async (texts) => {
        calls.push(texts.length);
        return texts.map(mockEmbedText);
      },
    };
    const centroids = await centroidsFromTaxonomy(TEST_TAXONOMY, countingEmbedder);
    const assigner = createAssigner(countingEmbedder, centroids);
    const texts = [
      'Implement a function to fix the bug',
      'Extract the total as JSON',
      'Summarize this document briefly',
    ];
    calls.length = 0;
    const batch = await assigner.assignBatch(texts);
    expect(batch.map((b) => b.clusterId)).toEqual(['code-gen', 'extraction', 'summarization']);
    // 3 texts fit in one chunk → a single embedder call.
    expect(calls).toEqual([3]);

    const singles = await Promise.all(texts.map((t) => assigner.assign(t)));
    expect(batch).toEqual(singles);
    await expect(assigner.assignBatch([])).resolves.toEqual([]);
  });

  it('assignBatch chunks large inputs (> BATCH_CHUNK_SIZE) across concurrent calls', async () => {
    const calls: number[] = [];
    const countingEmbedder: Embedder = {
      embed: async (texts) => {
        calls.push(texts.length);
        return texts.map(mockEmbedText);
      },
    };
    const centroids = await centroidsFromTaxonomy(TEST_TAXONOMY, countingEmbedder);
    const assigner = createAssigner(countingEmbedder, centroids);
    const texts = Array.from({ length: 150 }, (_, i) => `Summarize this document briefly ${i}`);
    calls.length = 0;
    const batch = await assigner.assignBatch(texts);
    expect(batch).toHaveLength(150);
    expect(batch.every((b) => b.clusterId === 'summarization')).toBe(true);
    // 150 = 64 + 64 + 22 across three concurrent embed calls.
    expect(calls).toEqual([64, 64, 22]);
  });

  it('cosine is symmetric and self-similarity is 1', () => {
    const v = [1, 2, 3];
    const w = [4, -5, 6];
    expect(cosine(v, v)).toBeCloseTo(1, 12);
    expect(cosine(v, w)).toBeCloseTo(cosine(w, v), 12);
  });
});
