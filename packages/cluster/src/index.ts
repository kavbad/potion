// @potion/cluster public API (SPEC §4).
//
// Phase 2: the Phase-0 STUB_TAXONOMY was removed from the public API — the
// real 10-cluster taxonomy lives in data/taxonomy.json and is loaded via
// loadTaxonomy() (see taxonomy.ts). Tests use small inline fixtures instead.
export {
  cosine,
  createAssigner,
  DEFAULT_THRESHOLD,
  BATCH_CHUNK_SIZE,
  type Assignment,
  type ClusterAssigner,
  type Embedder,
} from './assigner.js';

export {
  TAXONOMY_PATH,
  HELDOUT_PATH,
  TaxonomySchema,
  TaxonomyClusterSchema,
  HeldoutExampleSchema,
  loadTaxonomy,
  loadHeldout,
  type Taxonomy,
  type TaxonomyCluster,
  type HeldoutExample,
} from './taxonomy.js';

export {
  centroidsFromTaxonomy,
  createCachingEmbedder,
  contentHash,
  type EmbeddingCache,
} from './centroids.js';

// M1a item 3: canonical embedding space + platform embedder selection.
export {
  CANONICAL_EMBED_DIMS,
  EmbeddingDimensionError,
  assertCanonicalDims,
} from './embed-dims.js';

export {
  resolveEmbedder,
  withDimensionGuard,
  EmbedderConfigError,
  OPENAI_PLATFORM_EMBED_MODEL,
  MOCK_EMBED_MODEL,
  MOCK_EMBEDDINGS_WARNING,
  type EmbedderEnv,
  type EmbedderMode,
  type EmbedderProviders,
  type ResolvedEmbedder,
} from './embedder-config.js';

export {
  buildConfusionMatrix,
  precisionRecall,
  accuracy,
  formatConfusionMatrix,
  formatMetrics,
  type ConfusionMatrix,
  type LabelMetrics,
} from './confusion.js';

// ---- back-compat shim (Phase 0 signature; prefer centroidsFromTaxonomy) ----
import type { ClusterId } from '@potion/core';
import type { Embedder } from './assigner.js';
import { centroidsFromTaxonomy } from './centroids.js';

/**
 * @deprecated Use centroidsFromTaxonomy(taxonomy, embedder). Kept so Phase 0/1
 * callers keep working; identical math (mean of exemplar embeddings,
 * L2-normalized).
 */
export async function buildCentroids(
  embedder: Embedder,
  taxonomy: ReadonlyArray<{ id: ClusterId; exemplars: readonly string[] }>,
): Promise<Map<ClusterId, number[]>> {
  return centroidsFromTaxonomy({ clusters: taxonomy }, embedder);
}
