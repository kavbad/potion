// DEMAND CELLS — the k-anonymity gate (SERVING-ROADMAP S7 L2, migration 0042).
//
// The load-bearing tests here are about ABSENCE. Anyone can accumulate
// counters; the property that makes cross-org learning legitimate is that a
// cell fed by one customer is NOT WRITTEN to the table anything else reads —
// not written and hidden, not written and filtered, not written at all — and
// that what does get written carries no org identity and no recoverable
// prompt.
import { describe, expect, it } from 'vitest';
import { DemandAccumulator, demandCellKey } from '@potion/core';
import { createDb, migrate } from './index.js';
import { listDemandCells, mergeDemandDeltas } from './repos/demand.js';
import { demandCellContributors, demandCellStaging } from './schema.js';

const AT = new Date('2026-08-19T12:00:00Z');
const WEEK = '2026-08-17';
const SMALL = { minOrgs: 3, minRequests: 5 };

async function fresh() {
  const h = await createDb();
  await migrate(h.db);
  return h;
}

function deltasFor(
  orgs: string[],
  perOrg: number,
  over: { bucket?: string; shapeClass?: string; embedding?: number[] } = {},
) {
  const acc = new DemandAccumulator();
  for (const orgId of orgs) {
    for (let i = 0; i < perOrg; i++) {
      acc.observe({
        bucket: over.bucket ?? 'code-gen',
        shapeClass: over.shapeClass ?? 'no-tools/sync/0-1k',
        at: AT,
        orgId,
        confidence: 0.8,
        ...(over.embedding !== undefined ? { embedding: over.embedding } : {}),
      });
    }
  }
  return acc.drain();
}

describe('publication is a WRITE gate, not a read filter', () => {
  it('does not write a cell that one org could recognize as its own traffic', async () => {
    const h = await fresh();
    // One org, plenty of volume. Volume is not anonymity.
    const report = await mergeDemandDeltas(h.db, deltasFor(['org-a'], 500), SMALL);
    expect(report.withheld).toBe(1);
    expect(report.published).toBe(0);

    // Nothing in the readable table…
    expect(await listDemandCells(h.db)).toHaveLength(0);
    // …and the accumulation is real, so it can reach k later.
    const staged = await h.db.select().from(demandCellStaging);
    expect(staged).toHaveLength(1);
    expect(staged[0]!.requests).toBe(500);
  });

  it('publishes the moment enough distinct orgs have fed the same cell', async () => {
    const h = await fresh();
    await mergeDemandDeltas(h.db, deltasFor(['org-a', 'org-b'], 10), SMALL);
    expect(await listDemandCells(h.db)).toHaveLength(0);

    // The third org crosses the threshold and the cell appears — carrying
    // the WHOLE history, including the traffic that was withheld.
    const report = await mergeDemandDeltas(h.db, deltasFor(['org-c'], 10), SMALL);
    expect(report.published).toBe(1);
    const cells = await listDemandCells(h.db);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.requests).toBe(30);
    expect(cells[0]!.orgCount).toBe(3);
  });

  it('needs volume as well as breadth — three orgs sending one request is noise', async () => {
    const h = await fresh();
    const report = await mergeDemandDeltas(h.db, deltasFor(['a', 'b', 'c'], 1), SMALL);
    expect(report.published).toBe(0);
    expect(report.withheld).toBe(1);
  });

  it('a published row carries a COUNT of orgs and no org identity', async () => {
    const h = await fresh();
    await mergeDemandDeltas(h.db, deltasFor(['acme-corp', 'globex', 'initech'], 10), SMALL);
    const cell = (await listDemandCells(h.db))[0]!;
    expect(cell.orgCount).toBe(3);
    const serialized = JSON.stringify(cell);
    for (const org of ['acme-corp', 'globex', 'initech']) {
      expect(serialized).not.toContain(org);
    }
    // The identities exist — privately, where the count comes from.
    expect(await h.db.select().from(demandCellContributors)).toHaveLength(3);
  });
});

describe('what a cell knows', () => {
  it('accumulates across merges and keeps the worst fit ever seen', async () => {
    const h = await fresh();
    const acc = new DemandAccumulator();
    for (const orgId of ['a', 'b', 'c']) {
      for (let i = 0; i < 5; i++) {
        acc.observe({
          bucket: 'general',
          shapeClass: 'no-tools/sync/0-1k',
          at: AT,
          orgId,
          confidence: orgId === 'c' ? 0.05 : 0.9,
        });
      }
    }
    await mergeDemandDeltas(h.db, acc.drain(), SMALL);
    const cell = (await listDemandCells(h.db))[0]!;
    expect(cell.confidenceMean!).toBeCloseTo((0.9 * 10 + 0.05 * 5) / 15, 12);
    // The mean would let a badly-served third of the cell disappear; the min
    // is what says "something in here fits nothing we measured".
    expect(cell.confidenceMin!).toBeCloseTo(0.05, 12);
  });

  it('publishes a normalized centroid built from a SUM, never the vectors', async () => {
    const h = await fresh();
    const vec = Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
    await mergeDemandDeltas(h.db, deltasFor(['a', 'b', 'c'], 10, { embedding: vec }), SMALL);
    const cell = (await listDemandCells(h.db))[0]!;
    expect(cell.centroid).not.toBeNull();
    expect(cell.centroid).toHaveLength(384);
    expect(cell.centroid![0]).toBeCloseTo(1, 6); // 30 identical unit vectors
    // Staging holds one sum for thirty requests — there is no per-request
    // vector anywhere to leak.
    const staged = (await h.db.select().from(demandCellStaging))[0]!;
    expect(staged.centroidCount).toBe(30);
    expect(staged.centroidSum![0]).toBeCloseTo(30, 6);
  });

  it('publishes cells without a centroid when traffic was cluster-hinted', async () => {
    const h = await fresh();
    await mergeDemandDeltas(h.db, deltasFor(['a', 'b', 'c'], 10), SMALL);
    const cell = (await listDemandCells(h.db))[0]!;
    // No embedding was ever taken (X-Potion-Cluster skips the embedder). The
    // cell is still real demand; the centroid is honestly absent.
    expect(cell.centroid).toBeNull();
    expect(cell.requests).toBe(30);
  });

  it('publishes a NULL fit for a cell fed only by cluster-hinted traffic', async () => {
    const h = await fresh();
    const acc = new DemandAccumulator();
    for (const orgId of ['a', 'b', 'c']) {
      for (let i = 0; i < 5; i++) {
        acc.observe({
          bucket: 'agent-shared',
          shapeClass: 'tools/sync/0-1k',
          at: AT,
          orgId,
          // No confidence: the customer pinned the cluster, nothing measured
          // the fit. A 0 here would read as "fits nothing we serve".
        });
      }
    }
    await mergeDemandDeltas(h.db, acc.drain(), SMALL);
    const cell = (await listDemandCells(h.db))[0]!;
    expect(cell.requests).toBe(15);
    expect(cell.confidenceMean).toBeNull();
    expect(cell.confidenceMin).toBeNull();
    expect(cell.confidenceCount).toBe(0);
  });

  it('separates unassigned regions from measured clusters', async () => {
    const h = await fresh();
    await mergeDemandDeltas(h.db, deltasFor(['a', 'b', 'c'], 10), SMALL);
    await mergeDemandDeltas(
      h.db,
      deltasFor(['a', 'b', 'c'], 10, { bucket: 'lsh:00ff' }),
      SMALL,
    );
    expect(await listDemandCells(h.db, { bucketKind: 'cluster' })).toHaveLength(1);
    const unassigned = await listDemandCells(h.db, { bucketKind: 'unassigned' });
    expect(unassigned).toHaveLength(1);
    expect(unassigned[0]!.bucket).toBe('lsh:00ff');
    expect(unassigned[0]!.cellKey).toBe(
      demandCellKey('lsh:00ff', 'no-tools/sync/0-1k', WEEK),
    );
  });

  it('keeps shapes apart — the same subject in two shapes is two cells', async () => {
    const h = await fresh();
    await mergeDemandDeltas(h.db, deltasFor(['a', 'b', 'c'], 10), SMALL);
    await mergeDemandDeltas(
      h.db,
      deltasFor(['a', 'b', 'c'], 10, { shapeClass: 'tools/sync/0-1k' }),
      SMALL,
    );
    const cells = await listDemandCells(h.db);
    expect(cells).toHaveLength(2);
    expect(new Set(cells.map((c) => c.shapeClass))).toEqual(
      new Set(['no-tools/sync/0-1k', 'tools/sync/0-1k']),
    );
  });
});
