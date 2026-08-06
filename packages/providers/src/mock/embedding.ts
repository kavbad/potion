// Mock embeddings (SPEC §2/§4): deterministic 384-dim vectors that are
// *semantically clustered* — embedding(text) = L2-normalize(centroid(seedCluster(text))
// + seeded noise) with ‖noise‖ ≤ 0.15. seedCluster comes from keyword matching
// in fixtures.ts. Same text → same vector, always.
import { seedClusterOf } from './fixtures.js';
import { hashString, mulberry32 } from './rng.js';

export const EMBEDDING_DIM = 384;
/** Max L2 norm of the seeded noise added to the base centroid (SPEC §4). */
export const NOISE_MAX_NORM = 0.15;

function l2Normalize(v: number[]): number[] {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm === 0) return v;
  return v.map((x) => x / norm);
}

/**
 * Deterministic unit base centroid per cluster id, derived from the cluster id
 * hash. Random unit vectors in 384-d are near-orthogonal, so distinct clusters
 * have cosine ≈ 0 while same-cluster texts stay ≈ 1 even after noise.
 */
export function baseCentroid(clusterId: string): number[] {
  const rng = mulberry32(hashString(`potion-centroid:${clusterId}`));
  const v: number[] = new Array<number>(EMBEDDING_DIM);
  for (let i = 0; i < EMBEDDING_DIM; i++) v[i] = rng() * 2 - 1;
  return l2Normalize(v);
}

/** Deterministic noise vector for a text with L2 norm ≤ NOISE_MAX_NORM. */
function noiseFor(text: string): number[] {
  const rng = mulberry32(hashString(`potion-noise:${text}`));
  const v: number[] = new Array<number>(EMBEDDING_DIM);
  for (let i = 0; i < EMBEDDING_DIM; i++) v[i] = rng() * 2 - 1;
  const unit = l2Normalize(v);
  const magnitude = NOISE_MAX_NORM * rng(); // in [0, 0.15)
  return unit.map((x) => x * magnitude);
}

/** Mock embedding: semantically clustered, deterministic, 384-dim, unit norm. */
export function mockEmbedText(text: string): number[] {
  const centroid = baseCentroid(seedClusterOf(text));
  const noise = noiseFor(text);
  const v = centroid.map((c, i) => c + (noise[i] ?? 0));
  return l2Normalize(v);
}
