// M1a item 3 tests: resolveEmbedder priority order + throws, the canonical
// 384-dim guards (createAssigner / centroidsFromTaxonomy / the resolved
// embedder wrapper), and the fail-fast behavior on wrong-dim providers.
import { describe, expect, it } from 'vitest';
import { mockEmbedText } from '@potion/providers';
import { createAssigner, type Embedder } from './assigner.js';
import { centroidsFromTaxonomy } from './centroids.js';
import { CANONICAL_EMBED_DIMS, EmbeddingDimensionError } from './embed-dims.js';
import {
  EmbedderConfigError,
  MOCK_EMBEDDINGS_WARNING,
  MOCK_EMBED_MODEL,
  OPENAI_PLATFORM_EMBED_MODEL,
  resolveEmbedder,
  type EmbedderProviders,
} from './embedder-config.js';

function stubProviders(opts: { openaiDims?: number } = {}): {
  providers: EmbedderProviders;
  openaiCalls: string[][];
} {
  const openaiCalls: string[][] = [];
  const openaiDims = opts.openaiDims ?? CANONICAL_EMBED_DIMS;
  return {
    openaiCalls,
    providers: {
      mock: { embed: async (texts) => texts.map(mockEmbedText) },
      openai: {
        embed: async (texts) => {
          openaiCalls.push(texts);
          return texts.map(() => new Array<number>(openaiDims).fill(0.5));
        },
      },
    },
  };
}

function warner() {
  const messages: string[] = [];
  return { messages, warn: (m: string) => messages.push(m) };
}

describe('resolveEmbedder', () => {
  it('(a) POTION_EMBEDDER=openai + OPENAI_API_KEY → openai mode, model, 384 dims', () => {
    const { providers } = stubProviders();
    const { warn, messages } = warner();
    const resolved = resolveEmbedder(
      { POTION_EMBEDDER: 'openai', OPENAI_API_KEY: 'sk-test' },
      providers,
      { warn },
    );
    expect(resolved.mode).toBe('openai');
    expect(resolved.model).toBe(OPENAI_PLATFORM_EMBED_MODEL);
    expect(resolved.model).toBe('text-embedding-3-small');
    expect(resolved.dims).toBe(384);
    expect(messages).toEqual([]); // no mock warning on the production path
  });

  it('(a-default) no POTION_EMBEDDER but OPENAI_API_KEY set → openai (historical default)', () => {
    const { providers } = stubProviders();
    const resolved = resolveEmbedder({ OPENAI_API_KEY: 'sk-test' }, providers, { warn: () => {} });
    expect(resolved.mode).toBe('openai');
  });

  it('(b) POTION_EMBEDDER=mock → mock embedder + loud simulated-routing warning', () => {
    const { providers } = stubProviders();
    const { warn, messages } = warner();
    const resolved = resolveEmbedder({ POTION_EMBEDDER: 'mock' }, providers, { warn });
    expect(resolved.mode).toBe('mock');
    expect(resolved.model).toBe(MOCK_EMBED_MODEL);
    expect(resolved.dims).toBe(384);
    expect(messages.some((m) => m.includes('mock embeddings: cluster assignment is simulated'))).toBe(
      true,
    );
    expect(messages).toContain(MOCK_EMBEDDINGS_WARNING);
  });

  it('(b) nothing configured (no POTION_EMBEDDER, no key) → mock + warning', () => {
    const { providers } = stubProviders();
    const { warn, messages } = warner();
    const resolved = resolveEmbedder({}, providers, { warn });
    expect(resolved.mode).toBe('mock');
    expect(messages).toContain(MOCK_EMBEDDINGS_WARNING);
  });

  it('(b) POTION_EMBEDDER=openai WITHOUT a key → loud fallback to mock', () => {
    const { providers } = stubProviders();
    const { warn, messages } = warner();
    const resolved = resolveEmbedder({ POTION_EMBEDDER: 'openai' }, providers, { warn });
    expect(resolved.mode).toBe('mock');
    expect(messages.some((m) => m.includes('falling back to mock'))).toBe(true);
    expect(messages).toContain(MOCK_EMBEDDINGS_WARNING);
  });

  it('(c) POTION_EMBEDDER=google → clear non-canonical 768-dim error', () => {
    const { providers } = stubProviders();
    expect(() =>
      resolveEmbedder({ POTION_EMBEDDER: 'google', OPENAI_API_KEY: 'sk' }, providers, {
        warn: () => {},
      }),
    ).toThrowError(EmbedderConfigError);
    expect(() =>
      resolveEmbedder({ POTION_EMBEDDER: 'google' }, providers, { warn: () => {} }),
    ).toThrowError(/768-dim.*canonical 384-dim|non-canonical|cannot be the platform embedder/i);
  });

  it('(c) unknown POTION_EMBEDDER value → EmbedderConfigError', () => {
    const { providers } = stubProviders();
    expect(() =>
      resolveEmbedder({ POTION_EMBEDDER: 'cohere' }, providers, { warn: () => {} }),
    ).toThrowError(EmbedderConfigError);
  });

  it('resolved embedder actually embeds through the selected provider', async () => {
    const { providers, openaiCalls } = stubProviders();
    const resolved = resolveEmbedder(
      { POTION_EMBEDDER: 'openai', OPENAI_API_KEY: 'sk-test' },
      providers,
      { warn: () => {} },
    );
    const vectors = await resolved.embedder.embed(['hello world']);
    expect(openaiCalls).toEqual([['hello world']]);
    expect(vectors[0]).toHaveLength(384);
  });

  it('openai wrapper asserts 384 and fails fast on a wrong-dim provider', async () => {
    const { providers } = stubProviders({ openaiDims: 768 });
    const resolved = resolveEmbedder(
      { POTION_EMBEDDER: 'openai', OPENAI_API_KEY: 'sk-test' },
      providers,
      { warn: () => {} },
    );
    await expect(resolved.embedder.embed(['x'])).rejects.toThrowError(EmbeddingDimensionError);
    await expect(resolved.embedder.embed(['x'])).rejects.toThrowError(/384-dim.*768-dim/);
  });

  it('throws when openai is selected but the providers record lacks openai.embed', () => {
    expect(() =>
      resolveEmbedder(
        { POTION_EMBEDDER: 'openai', OPENAI_API_KEY: 'sk-test' },
        { mock: { embed: async (t) => t.map(mockEmbedText) } },
        { warn: () => {} },
      ),
    ).toThrowError(EmbedderConfigError);
  });
});

describe('dimension guards (CANONICAL_EMBED_DIMS = 384)', () => {
  const wrongDimEmbedder: Embedder = { embed: async (texts) => texts.map(() => [1, 2, 3]) };

  it('createAssigner rejects a wrong-dim centroid at construction', () => {
    expect(() =>
      createAssigner(
        { embed: async (t) => t.map(mockEmbedText) },
        new Map([['code-gen', [0.1, 0.2]]]),
      ),
    ).toThrowError(EmbeddingDimensionError);
  });

  it('createAssigner rejects a wrong-dim request embedding at assign time', async () => {
    const assigner = createAssigner(wrongDimEmbedder, new Map([['code-gen', mockEmbedText('x')]]));
    await expect(assigner.assign('hello')).rejects.toThrowError(EmbeddingDimensionError);
    await expect(assigner.assignBatch(['a', 'b'])).rejects.toThrowError(EmbeddingDimensionError);
  });

  it('centroidsFromTaxonomy rejects a consistently wrong-dim embedder', async () => {
    await expect(
      centroidsFromTaxonomy(
        { clusters: [{ id: 'code-gen', exemplars: ['a', 'b'] }] },
        wrongDimEmbedder,
      ),
    ).rejects.toThrowError(EmbeddingDimensionError);
  });

  it('accepts the mock embedder end-to-end (sanity: 384-dim path unaffected)', async () => {
    const embedder: Embedder = { embed: async (t) => t.map(mockEmbedText) };
    const centroids = await centroidsFromTaxonomy(
      { clusters: [{ id: 'code-gen', exemplars: ['Write a Python function', 'Fix the bug'] }] },
      embedder,
    );
    const assigner = createAssigner(embedder, centroids);
    const a = await assigner.assign('Write a Python function that reverses a string');
    expect(a.clusterId).toBe('code-gen');
  });
});
