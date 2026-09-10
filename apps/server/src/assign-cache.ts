// THE ASSIGNMENT CACHE (P0-2, external review 2026-09-05).
//
// It was a plain `Map`, created once and never evicted, while a comment in
// chat.ts called it "the assignment LRU (context.ts)" — which is what let it
// pass review. Each entry holds a 384-dimension embedding plus the full
// ten-cluster ranking, roughly 3–4KB, one per distinct prompt prefix, forever,
// written from three routes. Under sustained traffic that is an OOM with a
// reassuring name.
//
// This is the LRU the comment claimed. Two bounds, because one is not enough:
//
//   SIZE  — the memory ceiling. JS Map iterates in insertion order, so
//           "oldest" is the first key, and a `get` that re-inserts moves an
//           entry to the end. That is the whole LRU.
//   TTL   — the correctness bound. A cached ranking is a decision made against
//           the centroids as they were; the taxonomy moves, and an entry that
//           never expires can outlive the classification it encodes. A size
//           cap alone evicts by traffic mix, which on a low-cardinality
//           workload means never.
//
// Stats are counted here rather than derived, because a hit rate reconstructed
// from request logs cannot see an eviction.
export interface AssignCacheStats {
  entries: number;
  hits: number;
  misses: number;
  /** Dropped for the size cap. */
  evictions: number;
  /** Dropped for age — read as a miss by the caller, counted separately. */
  expiries: number;
  maxEntries: number;
  ttlMs: number;
}

/** ~3–4KB an entry: 10k caps the cache near 35MB. */
export const ASSIGN_CACHE_MAX_ENTRIES = 10_000;
/** An hour: long enough that a busy prompt stays hot, short enough that a
 *  taxonomy change reaches every route within one. */
export const ASSIGN_CACHE_TTL_MS = 60 * 60 * 1000;

interface Entry<V> {
  value: V;
  storedAt: number;
}

/**
 * Bounded, TTL'd, least-recently-USED (not merely least-recently-written).
 *
 * The `get`/`set` surface is deliberately Map-compatible so the three call
 * sites did not have to change — the defect was the container, not the
 * callers, and rewriting the callers would have widened the blast radius of a
 * P0 for no benefit.
 */
export class AssignCache<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private expiries = 0;

  constructor(
    private readonly maxEntries: number = ASSIGN_CACHE_MAX_ENTRIES,
    private readonly ttlMs: number = ASSIGN_CACHE_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): V | undefined {
    const hit = this.entries.get(key);
    if (hit === undefined) {
      this.misses++;
      return undefined;
    }
    if (this.now() - hit.storedAt >= this.ttlMs) {
      this.entries.delete(key);
      this.expiries++;
      this.misses++;
      return undefined;
    }
    // Re-insert to move it to the end: this is what makes it least-recently
    // USED. Without it a hot key written early is evicted before a cold key
    // written late, which is a FIFO wearing an LRU's name — the same class of
    // mislabel that hid the unbounded Map.
    this.entries.delete(key);
    this.entries.set(key, hit);
    this.hits++;
    return hit.value;
  }

  set(key: string, value: V): void {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, { value, storedAt: this.now() });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
      this.evictions++;
    }
  }

  get size(): number {
    return this.entries.size;
  }

  stats(): AssignCacheStats {
    return {
      entries: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      expiries: this.expiries,
      maxEntries: this.maxEntries,
      ttlMs: this.ttlMs,
    };
  }
}
