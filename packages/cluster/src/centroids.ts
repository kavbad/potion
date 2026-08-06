// Centroid construction (SPEC §4): centroid = mean of exemplar embeddings,
// L2-normalized. Embedder calls are memoized by content hash so repeated
// builds (e.g. evaluate + tests) never re-embed the same text.
import type { ClusterId } from '@potion/core';
import type { Embedder } from './assigner.js';
import { assertCanonicalDims } from './embed-dims.js';
import type { Taxonomy } from './taxonomy.js';

/** FNV-1a 32-bit content hash (hex) — cache key only, not cryptographic. */
export function contentHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

interface CacheEntry {
  text: string; // stored to guard against (astronomically unlikely) hash collisions
  vector: number[];
}

/** In-memory embedding cache keyed by content hash. */
export type EmbeddingCache = Map<string, CacheEntry>;

/**
 * Wrap an embedder with a content-hash memoization layer. Texts already in
 * the cache are not re-embedded; misses are embedded in a single batch call.
 * On a hash collision (stored text differs), the fresh embedding wins.
 */
export function createCachingEmbedder(
  embedder: Embedder,
  cache: EmbeddingCache = new Map(),
): Embedder & { cache: EmbeddingCache } {
  return {
    cache,
    async embed(texts: string[]): Promise<number[][]> {
      const out: Array<number[] | undefined> = new Array<number[] | undefined>(texts.length);
      const uniqueMisses: string[] = [];
      const missIndexByText = new Map<string, number>(); // text → slot in uniqueMisses
      const slotByPosition: number[] = new Array<number>(texts.length); // position → miss slot
      for (let i = 0; i < texts.length; i++) {
        const text = texts[i]!;
        const hit = cache.get(contentHash(text));
        if (hit && hit.text === text) {
          out[i] = hit.vector;
          slotByPosition[i] = -1;
          continue;
        }
        // Dedupe misses within this call: identical texts are embedded once
        // even before the cache is populated.
        let slot = missIndexByText.get(text);
        if (slot === undefined) {
          slot = uniqueMisses.length;
          uniqueMisses.push(text);
          missIndexByText.set(text, slot);
        }
        slotByPosition[i] = slot;
      }
      if (uniqueMisses.length > 0) {
        const fresh = await embedder.embed(uniqueMisses);
        if (fresh.length !== uniqueMisses.length) {
          throw new Error(
            `embedder returned ${fresh.length} embeddings for ${uniqueMisses.length} texts`,
          );
        }
        for (let j = 0; j < uniqueMisses.length; j++) {
          const text = uniqueMisses[j]!;
          cache.set(contentHash(text), { text, vector: fresh[j]! });
        }
        for (let i = 0; i < texts.length; i++) {
          const slot = slotByPosition[i]!;
          if (slot >= 0) out[i] = fresh[slot]!;
        }
      }
      return out as number[][];
    },
  };
}

function l2Normalize(v: number[]): number[] {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  return norm === 0 ? v : v.map((x) => x / norm);
}

/**
 * Build one L2-normalized centroid per taxonomy cluster: the mean of its
 * exemplar embeddings, re-normalized to unit length (SPEC §4). All exemplars
 * across all clusters are embedded through a content-hash cache in as few
 * embedder calls as possible (duplicates are embedded once).
 */
export async function centroidsFromTaxonomy(
  taxonomy: Taxonomy | { clusters: ReadonlyArray<{ id: ClusterId; exemplars: readonly string[] }> },
  embedder: Embedder,
  cache: EmbeddingCache = new Map(),
): Promise<Map<ClusterId, number[]>> {
  const cached = createCachingEmbedder(embedder, cache);
  const centroids = new Map<ClusterId, number[]>();
  for (const cluster of taxonomy.clusters) {
    const embeddings = await cached.embed([...cluster.exemplars]);
    if (embeddings.length === 0) continue;
    const dim = embeddings[0]?.length ?? 0;
    const mean = new Array<number>(dim).fill(0);
    for (const emb of embeddings) {
      if (emb.length !== dim) {
        throw new Error(
          `centroidsFromTaxonomy: inconsistent embedding dim for cluster "${cluster.id}" (${emb.length} != ${dim})`,
        );
      }
      for (let i = 0; i < dim; i++) mean[i] = (mean[i] ?? 0) + (emb[i] ?? 0);
    }
    // Dimension guard (M1a): centroids must be canonical 384-dim. Checked
    // AFTER the intra-cluster consistency check so a mixed-dim embedder still
    // reports the more specific inconsistency error.
    assertCanonicalDims(mean, `centroidsFromTaxonomy: cluster '${cluster.id}'`);
    for (let i = 0; i < dim; i++) mean[i] = (mean[i] ?? 0) / embeddings.length;
    centroids.set(cluster.id, l2Normalize(mean));
  }
  return centroids;
}
