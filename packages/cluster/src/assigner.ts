// Cluster assigner (SPEC §4): cosine similarity to L2-normalized cluster
// centroids; best match wins unless its confidence falls below the threshold,
// in which case the prompt routes to the 'general' fallback cluster.
import type { ClusterId } from '@potion/core';
import { assertCanonicalDims } from './embed-dims.js';

export interface Assignment {
  clusterId: ClusterId;
  confidence: number; // cosine to best centroid; < threshold → 'general'
}

export interface ClusterAssigner {
  assign(text: string): Promise<Assignment>;
  assignBatch(texts: string[]): Promise<Assignment[]>;
  /**
   * EVERY cluster scored, best first — the same cosines `assign` picks its
   * winner from, without discarding the losers.
   *
   * `assign` returns one id and one number, which is all serving needs and
   * strictly less than a person needs. When we tell someone "this looks like
   * code generation", the useful question is immediately "and what else did
   * it nearly match?" — a confident-looking single answer hides both a near
   * tie and a weak best. Returning the ranking lets a surface show the
   * runner-up and the margin, so a wrong classification is VISIBLE rather
   * than silently acted on.
   *
   * Deliberately NOT thresholded: this is the raw ranking, and the caller
   * decides what to do with a weak best. `assign`'s 'general' fallback is a
   * routing decision, not a fact about the text, so it does not belong here.
   */
  rank(text: string): Promise<Assignment[]>;
  /**
   * The routing decision AND the ranking it came from, off ONE embedding
   * (S7 L1).
   *
   * Serving needs the decision; learning needs to know how good it was.
   * Calling `assign` then `rank` would embed the same text twice — on the
   * serve path, for a number we already computed and threw away. `pickBest`
   * scores every centroid on every request; this returns what it saw.
   *
   * `assignment` is byte-identical to what `assign` would have returned,
   * threshold and 'general' fallback included; `ranking` is the raw,
   * unthresholded ordering `rank` would have returned.
   */
  assignRanked(text: string): Promise<RankedAssignment>;
}

/** A routing decision plus the evidence behind it. */
export interface RankedAssignment {
  /** What `assign` returns: thresholded, 'general' on a weak best. */
  assignment: Assignment;
  /** Every cluster scored, best first — the losers `assign` discards. */
  ranking: Assignment[];
  /**
   * TRUE when the best centroid was below threshold, so the decision is the
   * 'general' fallback rather than a match.
   *
   * Not derivable by the caller: 'general' is also a real taxonomy cluster,
   * so a decision of 'general' is ambiguous between "this genuinely is
   * general-purpose work" and "nothing we have measured fits this". S7's
   * demand cells split precisely on that distinction, so the assigner —
   * which is the only place the threshold lives — reports it.
   */
  fellBack: boolean;
  /**
   * The request embedding, for in-process aggregation only (S7 L2).
   *
   * It is returned rather than stored: the accumulator adds it into a
   * running sum and drops it, and nothing persists a per-request vector.
   * Anything that keeps one is outside the privacy posture this was built
   * under (S7 §4 D1(b)).
   */
  embedding: number[];
}

export interface Embedder {
  embed(t: string[]): Promise<number[][]>;
}

/**
 * Default routing threshold on centroid cosine similarity.
 *
 * Rationale: with the deterministic mock embedder (SPEC §2/§4), a prompt's
 * embedding is baseCentroid(seedCluster(text)) + seeded noise with ‖noise‖ ≤
 * 0.15, renormalized. Same-cluster cosine vs. the exemplar-mean centroid is
 * therefore ≳ 0.97, while distinct 384-dim random unit centroids are
 * near-orthogonal (cross-cluster cosine typically |c| < 0.1). Any threshold
 * in the wide (0.1, 0.97) gap separates the two regimes; 0.62 sits near the
 * midpoint of that gap on the similarity scale, giving maximum margin against
 * both false accepts (off-distribution prompts routed to a specialty cluster)
 * and false rejects (in-cluster prompts dumped to 'general'). Gate 2's
 * held-out evaluation (src/evaluate.ts) confirms ≥85% accuracy at this value.
 * For real embedding models, re-tune against the held-out set: pick the
 * threshold maximizing accuracy subject to an acceptable 'general' rate.
 */
export const DEFAULT_THRESHOLD = 0.62;

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function pickBest(
  embedding: number[],
  centroids: Map<ClusterId, number[]>,
): { clusterId: ClusterId; confidence: number } {
  let bestId: ClusterId = 'general';
  let best = -1;
  for (const [id, centroid] of centroids) {
    const score = cosine(embedding, centroid);
    if (score > best) {
      best = score;
      bestId = id;
    }
  }
  return { clusterId: bestId, confidence: best };
}

/** Max texts per embedder call inside assignBatch (keeps batches cache-friendly). */
export const BATCH_CHUNK_SIZE = 64;

/**
 * Create a thresholded centroid assigner (SPEC §4). `assign` embeds one text;
 * `assignBatch` embeds all texts concurrently (chunks of BATCH_CHUNK_SIZE run
 * in parallel via Promise.all) and preserves input order.
 */
export function createAssigner(
  embedder: Embedder,
  centroids: Map<ClusterId, number[]>,
  threshold: number = DEFAULT_THRESHOLD,
): ClusterAssigner {
  // Dimension guard (M1a): every centroid must live in the canonical 384-dim
  // space; a wrong-dim centroid means the centroids were built with a
  // different embedder than requests will use — fail fast at construction.
  for (const [id, centroid] of centroids) {
    assertCanonicalDims(centroid, `createAssigner: centroid '${id}'`);
  }

  const toAssignment = (embedding: number[]): Assignment => {
    // Fail fast if the request-time embedder drifts from the canonical space.
    assertCanonicalDims(embedding, 'createAssigner: request embedding');
    const best = pickBest(embedding, centroids);
    if (best.confidence < threshold) {
      return { clusterId: 'general', confidence: best.confidence };
    }
    return best;
  };

  const embedOne = async (text: string): Promise<number[]> => {
    const [embedding] = await embedder.embed([text]);
    if (!embedding) throw new Error('embedder returned no embedding');
    assertCanonicalDims(embedding, 'createAssigner: request embedding');
    return embedding;
  };

  const rankEmbedding = (embedding: number[]): Assignment[] => {
    const scored: Assignment[] = [];
    for (const [id, centroid] of centroids) {
      scored.push({ clusterId: id, confidence: cosine(embedding, centroid) });
    }
    // Ties break on cluster id so the ranking is TOTAL and reproducible —
    // two centroids at an identical cosine must not reorder between calls,
    // or "your runner-up" becomes a coin flip the user cannot see.
    scored.sort((a, b) => b.confidence - a.confidence || a.clusterId.localeCompare(b.clusterId));
    return scored;
  };

  return {
    async assign(text: string): Promise<Assignment> {
      const [embedding] = await embedder.embed([text]);
      if (!embedding) throw new Error('embedder returned no embedding');
      return toAssignment(embedding);
    },
    async rank(text: string): Promise<Assignment[]> {
      return rankEmbedding(await embedOne(text));
    },
    async assignRanked(text: string): Promise<RankedAssignment> {
      const embedding = await embedOne(text);
      // The decision comes from toAssignment, NOT from ranking[0]: pickBest
      // breaks ties in centroid-map order and the ranking breaks them on
      // cluster id, so deriving one from the other could disagree with what
      // `assign` would have routed. Serving's answer stays serving's answer.
      const assignment = toAssignment(embedding);
      return {
        assignment,
        ranking: rankEmbedding(embedding),
        fellBack: assignment.confidence < threshold,
        embedding,
      };
    },
    async assignBatch(texts: string[]): Promise<Assignment[]> {
      if (texts.length === 0) return [];
      const chunks: string[][] = [];
      for (let i = 0; i < texts.length; i += BATCH_CHUNK_SIZE) {
        chunks.push(texts.slice(i, i + BATCH_CHUNK_SIZE));
      }
      // Concurrent embedding: all chunks in flight at once; order is preserved
      // because each chunk's results are written back at its offset.
      const embedded = await Promise.all(chunks.map((chunk) => embedder.embed(chunk)));
      const embeddings = embedded.flat();
      if (embeddings.length !== texts.length) {
        throw new Error(`embedder returned ${embeddings.length} embeddings for ${texts.length} texts`);
      }
      return embeddings.map(toAssignment);
    },
  };
}
