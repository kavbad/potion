// Demand bucketing for UNASSIGNED traffic (S7 L2).
//
// When a request's best centroid falls below the routing threshold it goes to
// 'general', and 'general' is where every unlike thing piles up together: a
// legal-clause extraction, a SQL migration review and a Portuguese support
// reply are one undifferentiated heap. That heap is exactly the population
// S7 needs to split — "something we have not tested for" lives in it — and
// splitting it needs a way to say "these two requests are near each other"
// WITHOUT keeping either request.
//
// A sign-bit LSH does that. Each request contributes one 16-bit label: the
// signs of its embedding's dot products against 16 fixed hyperplanes. Nearby
// embeddings usually land on the same side of most planes, so demand for the
// same unmet thing accumulates in the same bucket while the label itself
// carries 16 bits — not a prompt, not an embedding, and nothing anyone could
// invert back toward either.
//
// The hyperplanes are DERIVED FROM A COMMITTED CONSTANT, not drawn at
// startup. A bucket id has to mean the same thing tomorrow, in another
// replica, and after a redeploy, or a demand cell's history is a sequence of
// unrelated labels and nothing ever accumulates to k.
import { createHash } from 'node:crypto';

/** Canonical embedding dimensionality (SPEC §4). */
export const LSH_DIMS = 384;
/** Bits per label. 16 → 65_536 buckets, ~1 in 65k collision for far pairs. */
export const LSH_BITS = 16;
/** Committed seed. CHANGING THIS INVALIDATES EVERY BUCKET ID EVER WRITTEN. */
export const LSH_SEED = 'potion-demand-lsh-v1';

/**
 * Deterministic Gaussian-ish hyperplanes from the seed.
 *
 * Each component is a byte of sha256(seed:plane:offset) mapped into [-1, 1).
 * Uniform rather than true Gaussian: the sign of a dot product against a
 * uniform random vector is the same coarse "which side" question, and
 * bucketing needs the SIDE, not a calibrated distance.
 */
function buildPlanes(): Float64Array[] {
  const planes: Float64Array[] = [];
  for (let p = 0; p < LSH_BITS; p++) {
    const plane = new Float64Array(LSH_DIMS);
    let filled = 0;
    let counter = 0;
    while (filled < LSH_DIMS) {
      const digest = createHash('sha256').update(`${LSH_SEED}:${p}:${counter++}`).digest();
      for (let i = 0; i < digest.length && filled < LSH_DIMS; i++) {
        plane[filled++] = digest[i]! / 127.5 - 1;
      }
    }
    planes.push(plane);
  }
  return planes;
}

const PLANES = buildPlanes();

/**
 * The bucket label for one embedding: `lsh:` + 4 lowercase hex digits.
 *
 * Prefixed so a bucket id can never be mistaken for a cluster id in a column
 * that holds both — an unassigned region must not be able to impersonate a
 * measured taxonomy cluster anywhere downstream.
 */
export function lshBucket(embedding: readonly number[]): string {
  if (embedding.length !== LSH_DIMS) {
    throw new Error(`lshBucket: expected ${LSH_DIMS} dims, got ${embedding.length}`);
  }
  let bits = 0;
  for (let p = 0; p < LSH_BITS; p++) {
    const plane = PLANES[p]!;
    let dot = 0;
    for (let i = 0; i < LSH_DIMS; i++) dot += embedding[i]! * plane[i]!;
    // Ties (dot exactly 0) resolve to 0 — arbitrary but FIXED, which is the
    // only property that matters for a label.
    if (dot > 0) bits |= 1 << p;
  }
  return `lsh:${bits.toString(16).padStart(4, '0')}`;
}

/** True for ids produced by {@link lshBucket} — never a taxonomy cluster id. */
export function isLshBucket(id: string): boolean {
  return /^lsh:[0-9a-f]{4}$/.test(id);
}
