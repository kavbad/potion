// Canonical embedding space (ROADMAP M1a item 3 — DECISION, documented here):
//
//   · canonical embedding space = 384 dimensions (CANONICAL_EMBED_DIMS)
//   · primary production model = OpenAI text-embedding-3-small requested with
//     API-supported `dimensions: 384` truncation, so production vectors live in
//     the SAME vector space as everything below
//   · the mock embedder stays 384-dim for CI/dev (zero network)
//   · Google's text-embedding-004 (768-dim) is NON-CANONICAL — it can never be
//     selected as the platform embedder (see embedder-config.ts)
//
// Every centroid, stored exemplar embedding, and request-time embedding MUST
// be exactly CANONICAL_EMBED_DIMS long. Mixing dims across embedders would
// silently corrupt cosine routing, so all constructors/embed paths fail fast
// with EmbeddingDimensionError instead.

/** Canonical platform embedding dimension (mock + OpenAI dimensions:384). */
export const CANONICAL_EMBED_DIMS = 384;

/** Named error thrown whenever a vector's length is not the canonical dim. */
export class EmbeddingDimensionError extends Error {
  readonly expected: number;
  readonly actual: number;

  constructor(context: string, expected: number, actual: number) {
    super(
      `${context}: expected a ${expected}-dim embedding (canonical space), ` +
        `got ${actual}-dim — refusing to mix embedding spaces`,
    );
    this.name = 'EmbeddingDimensionError';
    this.expected = expected;
    this.actual = actual;
  }
}

/** Throw EmbeddingDimensionError unless `vector.length === expected`. */
export function assertCanonicalDims(
  vector: readonly number[],
  context: string,
  expected: number = CANONICAL_EMBED_DIMS,
): void {
  if (vector.length !== expected) {
    throw new EmbeddingDimensionError(context, expected, vector.length);
  }
}
