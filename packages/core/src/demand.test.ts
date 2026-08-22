import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MIN_ORGS,
  DEFAULT_MIN_REQUESTS,
  DemandAccumulator,
  demandCellKey,
  isPublishable,
  normalizeCentroid,
  weekStart,
} from './demand.js';

const AT = new Date('2026-08-19T12:00:00Z'); // a Wednesday

function obs(over: Partial<Parameters<DemandAccumulator['observe']>[0]> = {}) {
  return {
    bucket: 'code-gen',
    shapeClass: 'no-tools/sync/0-1k',
    at: AT,
    orgId: 'org-a',
    confidence: 0.9,
    ...over,
  };
}

describe('weekStart', () => {
  it('anchors on Monday, UTC', () => {
    expect(weekStart(new Date('2026-08-19T12:00:00Z'))).toBe('2026-08-17'); // Wed → Mon
    expect(weekStart(new Date('2026-08-17T00:00:00Z'))).toBe('2026-08-17'); // Mon → itself
    expect(weekStart(new Date('2026-08-23T23:59:59Z'))).toBe('2026-08-17'); // Sun → prior Mon
    expect(weekStart(new Date('2026-08-24T00:00:00Z'))).toBe('2026-08-24'); // next Mon
  });
});

describe('DemandAccumulator', () => {
  it('groups by (bucket, shape, week) and counts requests and distinct orgs', () => {
    const acc = new DemandAccumulator();
    acc.observe(obs({ orgId: 'org-a' }));
    acc.observe(obs({ orgId: 'org-b' }));
    acc.observe(obs({ orgId: 'org-a' })); // repeat contributor
    acc.observe(obs({ shapeClass: 'tools/sync/0-1k' })); // different cell

    const deltas = acc.drain();
    expect(deltas).toHaveLength(2);
    const main = deltas.find((d) => d.shapeClass === 'no-tools/sync/0-1k')!;
    expect(main.cellKey).toBe(demandCellKey('code-gen', 'no-tools/sync/0-1k', '2026-08-17'));
    expect(main.requests).toBe(3);
    expect(main.orgIds.sort()).toEqual(['org-a', 'org-b']);
    expect(main.bucketKind).toBe('cluster');
  });

  it('labels an lsh bucket as unassigned demand', () => {
    const acc = new DemandAccumulator();
    acc.observe(obs({ bucket: 'lsh:00ff' }));
    expect(acc.drain()[0]!.bucketKind).toBe('unassigned');
  });

  it('keeps the WORST confidence, not just the mean — the tail is the finding', () => {
    const acc = new DemandAccumulator();
    acc.observe(obs({ confidence: 0.9 }));
    acc.observe(obs({ confidence: 0.1 }));
    const d = acc.drain()[0]!;
    expect(d.confidenceSum / d.confidenceCount).toBeCloseTo(0.5, 12);
    expect(d.confidenceMin).toBeCloseTo(0.1, 12);
  });

  // THE property (S7 §4 D1(b)): vectors go in, a SUM comes out. If a future
  // edit ever exposes the individual embeddings, the cross-org aggregation
  // built on this stops being an aggregation.
  it('sums embeddings and never yields the individual vectors', () => {
    const acc = new DemandAccumulator();
    acc.observe(obs({ embedding: [1, 0, 0] }));
    acc.observe(obs({ embedding: [0, 2, 0] }));
    const d = acc.drain()[0]!;
    expect(d.centroidSum).toEqual([1, 2, 0]);
    expect(d.centroidCount).toBe(2);
    // Two observations, one vector out: the sum cannot be un-mixed.
    expect(Object.values(d).filter(Array.isArray)).toHaveLength(2); // orgIds, centroidSum
  });

  it('reports NO centroid when nothing carried an embedding (hinted clusters)', () => {
    const acc = new DemandAccumulator();
    acc.observe(obs());
    const d = acc.drain()[0]!;
    expect(d.centroidSum).toBeNull();
    expect(d.centroidCount).toBe(0);
    expect(d.requests).toBe(1); // the cell is still real
  });

  it('counts a hinted request without inventing a fit for it', () => {
    const acc = new DemandAccumulator();
    acc.observe(obs({ confidence: 0.8 }));
    acc.observe(obs({ confidence: undefined })); // X-Potion-Cluster: no centroid consulted
    const d = acc.drain()[0]!;
    expect(d.requests).toBe(2);
    // Two requests, ONE measured fit — the mean must divide by the fits, or
    // telling Potion the answer would make the cell look worse-served.
    expect(d.confidenceCount).toBe(1);
    expect(d.confidenceSum).toBeCloseTo(0.8, 12);
    expect(d.confidenceMin).toBeCloseTo(0.8, 12);
  });

  it('reports a NULL worst-fit when nothing measured one', () => {
    const acc = new DemandAccumulator();
    acc.observe(obs({ confidence: undefined }));
    const d = acc.drain()[0]!;
    expect(d.confidenceMin).toBeNull();
    expect(d.confidenceCount).toBe(0);
  });

  it('refuses to mix embedding spaces rather than summing incomparable vectors', () => {
    const acc = new DemandAccumulator();
    acc.observe(obs({ embedding: [1, 0, 0] }));
    acc.observe(obs({ embedding: [1, 0] })); // different embedder
    const d = acc.drain()[0]!;
    expect(d.centroidSum).toEqual([1, 0, 0]);
    expect(d.centroidCount).toBe(1);
    expect(d.requests).toBe(2);
  });

  it('drains to empty — a delta is delivered once, never twice', () => {
    const acc = new DemandAccumulator();
    acc.observe(obs());
    expect(acc.size).toBe(1);
    expect(acc.drain()).toHaveLength(1);
    expect(acc.size).toBe(0);
    expect(acc.drain()).toHaveLength(0);
  });
});

describe('isPublishable — the k-anonymity gate', () => {
  it('needs BOTH enough distinct orgs and enough requests', () => {
    expect(isPublishable(DEFAULT_MIN_ORGS, DEFAULT_MIN_REQUESTS)).toBe(true);
    // One org hammering an endpoint is not a market signal, it is a customer.
    expect(isPublishable(1, 10_000)).toBe(false);
    // Five orgs sending one request each is noise, not demand.
    expect(isPublishable(DEFAULT_MIN_ORGS, 3)).toBe(false);
  });

  it('takes explicit thresholds so a deployment can be stricter, not looser', () => {
    expect(isPublishable(3, 100, 3, 50)).toBe(true);
    expect(isPublishable(3, 100, 10, 50)).toBe(false);
  });
});

describe('normalizeCentroid', () => {
  it('L2-normalizes a sum so cells are comparable regardless of volume', () => {
    expect(normalizeCentroid([3, 4])).toEqual([0.6, 0.8]);
  });

  it('returns null rather than a fabricated direction', () => {
    expect(normalizeCentroid(null)).toBeNull();
    expect(normalizeCentroid([])).toBeNull();
    expect(normalizeCentroid([0, 0, 0])).toBeNull();
  });
});

describe('the cell cap (memory bound)', () => {
  it('bounds what one process holds between flushes', () => {
    const acc = new DemandAccumulator(2);
    acc.observe(obs({ bucket: 'lsh:0001' }));
    acc.observe(obs({ bucket: 'lsh:0002' }));
    acc.observe(obs({ bucket: 'lsh:0003' })); // turned away
    expect(acc.size).toBe(2);
  });

  it('keeps feeding cells it already holds while full', () => {
    const acc = new DemandAccumulator(1);
    acc.observe(obs({ bucket: 'lsh:0001' }));
    acc.observe(obs({ bucket: 'lsh:0002' })); // turned away
    acc.observe(obs({ bucket: 'lsh:0001' })); // still counted
    const d = acc.drain()[0]!;
    expect(d.requests).toBe(2);
  });

  it('COUNTS what it turned away — a bound nobody can see is a lie', () => {
    const acc = new DemandAccumulator(1);
    acc.observe(obs({ bucket: 'lsh:0001' }));
    acc.observe(obs({ bucket: 'lsh:0002' }));
    acc.observe(obs({ bucket: 'lsh:0003' }));
    expect(acc.dropped).toBe(2);
    acc.drain();
    expect(acc.dropped).toBe(0); // reset with the window it belonged to
  });
});
