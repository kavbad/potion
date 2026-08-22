// THE DEMAND ACCUMULATOR (S7 L2) — where "what customers ask for" stops
// being per-request and becomes an aggregate.
//
// This is the module the whole privacy posture rests on (S7 §4 D1(b)), so
// what it does NOT do is the specification:
//
//   It never keeps a prompt. It is never given one — `observe` takes an
//   embedding, a shape and a confidence, and the caller has already dropped
//   the text.
//
//   It never PERSISTS an embedding. Vectors enter, are added into a running
//   sum, and are unreachable afterwards: there is no array of them, so
//   nothing downstream can be handed one. A sum over many requests is not a
//   request, which is precisely what makes the result shareable across orgs
//   when the k-gate opens.
//
//   It never lets one org's traffic become a published fact. Contributor org
//   ids are held to COUNT them, and a cell that has not been fed by ≥K
//   distinct orgs is not eligible for publication. The gate is on the write,
//   not on the read — a "hidden" row is still a row somebody can query.
//
// Everything here is in-memory and per-process: the serve path pays a Map
// update, never a database write, and the deltas are drained on a timer.
import { isLshBucket } from './lsh.js';

/** Distinct orgs that must feed a cell before it may be published. */
export const DEFAULT_MIN_ORGS = 5;
/** Requests a cell needs before publication, independent of org count. */
export const DEFAULT_MIN_REQUESTS = 20;

/**
 * Cells one process may hold between flushes.
 *
 * Unassigned demand is bucketed by a 16-bit LSH label, so the key space is
 * 65_536 buckets × shape classes — and each cell holding a centroid sum is
 * ~3KB of Float64. A diverse (or adversarial) minute of traffic could
 * therefore pin hundreds of megabytes between two flushes. The cap bounds
 * that, and observations it turns away are COUNTED and reported rather than
 * dropped quietly: a bound nobody can see is indistinguishable from demand
 * that never happened.
 */
export const DEFAULT_MAX_CELLS = 5_000;

export interface DemandObservation {
  /** Taxonomy cluster id, or an `lsh:` bucket for unassigned traffic. */
  bucket: string;
  /** `shapeClass(shape)` — the content-free structure key. */
  shapeClass: string;
  /** ISO date (UTC) of the observation; bucketed to its week internally. */
  at: Date;
  /** Contributor — counted for k-anonymity, never published. */
  orgId: string;
  /**
   * Cosine to the best centroid, thresholded or not.
   *
   * ABSENT for a cluster-hinted request (X-Potion-Cluster), where the
   * customer asserted the cluster and no centroid was consulted. Recording
   * 1.0 there would be a fabricated certainty entering the same mean that
   * decides whether a cell looks well-served, so an absent fit stays absent
   * and the cell reports how many of its requests actually measured one.
   */
  confidence?: number | undefined;
  /**
   * The request embedding. Added into a sum and forgotten. Optional because
   * a hinted cluster (X-Potion-Cluster) skips the embedder entirely, and a
   * cell fed only by hints is a real cell with no centroid — which the
   * delta reports honestly rather than filling in.
   */
  embedding?: readonly number[] | undefined;
}

/** One cell's accumulated delta, ready to merge into the database. */
export interface DemandDelta {
  cellKey: string;
  bucket: string;
  bucketKind: 'cluster' | 'unassigned';
  shapeClass: string;
  weekStart: string;
  requests: number;
  /** Distinct contributing orgs IN THIS DELTA (the merge unions them). */
  orgIds: string[];
  confidenceSum: number;
  /** Observations that carried a confidence (≤ requests). */
  confidenceCount: number;
  /** Worst fit seen, or null when nothing measured one. */
  confidenceMin: number | null;
  /** Sum of embeddings, or null when no observation carried one. */
  centroidSum: number[] | null;
  centroidCount: number;
}

/** Monday-anchored UTC week start, as YYYY-MM-DD. */
export function weekStart(at: Date): string {
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  // getUTCDay: 0=Sunday. Shift so Monday is the anchor.
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

export function demandCellKey(bucket: string, shapeClass: string, week: string): string {
  return `${bucket}|${shapeClass}|${week}`;
}

interface Cell {
  bucket: string;
  shapeClass: string;
  weekStart: string;
  requests: number;
  orgIds: Set<string>;
  confidenceSum: number;
  confidenceCount: number;
  confidenceMin: number | null;
  centroidSum: Float64Array | null;
  centroidCount: number;
}

export class DemandAccumulator {
  private cells = new Map<string, Cell>();
  private droppedCount = 0;

  constructor(private readonly maxCells: number = DEFAULT_MAX_CELLS) {}

  /** Cells currently held (diagnostic; a drained accumulator reports 0). */
  get size(): number {
    return this.cells.size;
  }

  /**
   * Observations turned away since the last drain because the cell cap was
   * full. Non-zero means this window UNDER-COUNTS demand — the safe
   * direction (a delayed measurement, never a phantom one) but never a
   * silent one.
   */
  get dropped(): number {
    return this.droppedCount;
  }

  observe(o: DemandObservation): void {
    const week = weekStart(o.at);
    const key = demandCellKey(o.bucket, o.shapeClass, week);
    let cell = this.cells.get(key);
    if (!cell && this.cells.size >= this.maxCells) {
      // Full. Existing cells keep accumulating; a NEW one waits for the next
      // window, and the fact that it waited is counted.
      this.droppedCount++;
      return;
    }
    if (!cell) {
      cell = {
        bucket: o.bucket,
        shapeClass: o.shapeClass,
        weekStart: week,
        requests: 0,
        orgIds: new Set(),
        confidenceSum: 0,
        confidenceCount: 0,
        confidenceMin: null,
        centroidSum: null,
        centroidCount: 0,
      };
      this.cells.set(key, cell);
    }
    cell.requests++;
    cell.orgIds.add(o.orgId);
    if (o.confidence !== undefined) {
      cell.confidenceSum += o.confidence;
      cell.confidenceCount++;
      if (cell.confidenceMin === null || o.confidence < cell.confidenceMin) {
        cell.confidenceMin = o.confidence;
      }
    }
    if (o.embedding !== undefined) {
      if (cell.centroidSum === null) cell.centroidSum = new Float64Array(o.embedding.length);
      if (cell.centroidSum.length !== o.embedding.length) {
        // Mixed dimensionality means two different embedders fed one cell;
        // their sum would be arithmetic on incomparable spaces. Refuse the
        // vector, keep the count — the cell is still real.
        return;
      }
      for (let i = 0; i < o.embedding.length; i++) {
        cell.centroidSum[i] = cell.centroidSum[i]! + o.embedding[i]!;
      }
      cell.centroidCount++;
    }
  }

  /** Take everything accumulated so far and reset. */
  drain(): DemandDelta[] {
    const out: DemandDelta[] = [];
    for (const [cellKey, c] of this.cells) {
      out.push({
        cellKey,
        bucket: c.bucket,
        bucketKind: isLshBucket(c.bucket) ? 'unassigned' : 'cluster',
        shapeClass: c.shapeClass,
        weekStart: c.weekStart,
        requests: c.requests,
        orgIds: [...c.orgIds],
        confidenceSum: c.confidenceSum,
        confidenceCount: c.confidenceCount,
        confidenceMin: c.confidenceMin,
        centroidSum: c.centroidSum === null ? null : Array.from(c.centroidSum),
        centroidCount: c.centroidCount,
      });
    }
    this.cells.clear();
    this.droppedCount = 0;
    return out;
  }
}

/** L2 publication gate: is this cell an aggregate, or is it somebody's traffic? */
export function isPublishable(
  orgCount: number,
  requests: number,
  minOrgs: number = DEFAULT_MIN_ORGS,
  minRequests: number = DEFAULT_MIN_REQUESTS,
): boolean {
  return orgCount >= minOrgs && requests >= minRequests;
}

/** L2-normalize a centroid sum. Returns null for a zero or absent sum. */
export function normalizeCentroid(sum: readonly number[] | null): number[] | null {
  if (sum === null || sum.length === 0) return null;
  let norm = 0;
  for (const x of sum) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm === 0) return null;
  return sum.map((x) => x / norm);
}
