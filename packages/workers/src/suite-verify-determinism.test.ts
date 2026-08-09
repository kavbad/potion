// Determinism of the CONTRACTUAL verdict path (post-G2.8).
//
// WHY THIS FILE EXISTS. G2.8 produced two suite-verify results over what
// appeared to be the same evidence — retention 0.2707 / contractual-breach and
// 1.0645 / all-clear — and the project could not say which was right, because
// nothing recorded the inputs. The seeded bootstrap was reproducible GIVEN its
// inputs; nothing proved the INPUT SELECTION was.
//
// So these tests assert the property the seed does not cover: that the verdict
// is a function of the evidence SET, not of the order it arrives in, nor of
// which physical row a scan happened to return first.
//
// Each test below fails against the pre-fix code. Verified by reverting:
//   · order-independence  → fails (seed was sha256 over the raw ratio array)
//   · seed-coverage       → fails (same reason)
//   · duplicate refusal   → fails (m.set silently kept the last row)
//   · unpairable report   → fails (the branch dropped them invisibly)
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createDb,
  insertEvalResult,
  orgs,
  pairedQualities,
  migrate,
  type DbHandle,
} from '@potion/db';
import type { EvalResult } from '@potion/core';
import { computeRetention } from './handlers.js';

let db: DbHandle;

beforeEach(async () => {
  db = await createDb();
  await migrate(db.db);
  await db.db.insert(orgs).values({ id: 'org_det', name: 'Determinism' }).onConflictDoNothing();
});

afterEach(async () => {
  await db.close();
});

const CLUSTER = 'agent-det-0001';
const INCUMBENT = 'hash-incumbent';
const CANDIDATE = 'hash-candidate';

function evalRow(itemId: string, strategyHash: string, quality: number): EvalResult {
  return {
    runId: 'run-det',
    itemId,
    clusterId: CLUSTER,
    strategyHash,
    strategyConfig: { type: 'single', model: 'mock-cheap' },
    quality,
    scorer: 'llm-judge',
    usage: { inputTokens: 10, outputTokens: 5, costUsd: 0, latencyMs: 1 },
    latencyMs: { p50: 1, p95: 1, mean: 1 },
    modelVersions: {},
    pricesVersion: 'pv-det',
    providerMode: 'live',
    orgId: 'org_det',
    cacheKey: `ck-${strategyHash}-${itemId}`,
    createdAt: '2026-08-09T00:00:00.000Z',
  };
}

/** Deliberately uneven per-item ratios: a bootstrap over a permuted array
 * lands on different items, so an order-sensitive interval MOVES. Uniform
 * ratios would hide the bug. */
const EVIDENCE: Array<{ item: string; inc: number; cand: number }> = [
  { item: 'item-05', inc: 0.9, cand: 0.9 },
  { item: 'item-01', inc: 0.8, cand: 0.2 },
  { item: 'item-09', inc: 0.7, cand: 0.7 },
  { item: 'item-03', inc: 0.6, cand: 0.1 },
  { item: 'item-07', inc: 0.5, cand: 0.5 },
  { item: 'item-02', inc: 0.9, cand: 0.3 },
  { item: 'item-08', inc: 0.4, cand: 0.4 },
  { item: 'item-04', inc: 0.7, cand: 0.15 },
];

const SEED_KEY = 'suite-verify|org_det|pol-det|agent-det-0001|cand|inc';

function pairsFrom(order: typeof EVIDENCE) {
  return order.map((e) => ({
    itemId: e.item,
    candidateQuality: e.cand,
    incumbentQuality: e.inc,
  }));
}

async function seedRows(order: typeof EVIDENCE): Promise<void> {
  for (const e of order) {
    await insertEvalResult(db.db, evalRow(e.item, INCUMBENT, e.inc));
    await insertEvalResult(db.db, evalRow(e.item, CANDIDATE, e.cand));
  }
}

async function pair() {
  return pairedQualities(db.db, {
    clusterId: CLUSTER,
    candidateHash: CANDIDATE,
    incumbentHash: INCUMBENT,
    pricesVersion: 'pv-det',
    providerMode: 'live',
    orgId: 'org_det',
  });
}

describe('computeRetention is a function of the evidence SET, not its order', () => {
  it('ORDER-INDEPENDENCE: permuting the pairs changes nothing — mean, CI, and seed', () => {
    const forward = computeRetention(pairsFrom(EVIDENCE), { seedKey: SEED_KEY, floor: 0.9 });
    const reversed = computeRetention(pairsFrom([...EVIDENCE].reverse()), {
      seedKey: SEED_KEY,
      floor: 0.9,
    });
    const shuffled = computeRetention(
      pairsFrom([...EVIDENCE].sort((a, b) => (a.cand === b.cand ? 0 : a.cand < b.cand ? 1 : -1))),
      { seedKey: SEED_KEY, floor: 0.9 },
    );
    for (const other of [reversed, shuffled]) {
      // Object.is equality on every float — "close enough" would pass on a
      // drift that flips a verdict at the floor.
      expect(other.retention!.mean).toBe(forward.retention!.mean);
      expect(other.retention!.ci95[0]).toBe(forward.retention!.ci95[0]);
      expect(other.retention!.ci95[1]).toBe(forward.retention!.ci95[1]);
      expect(other.retention!.seed).toBe(forward.retention!.seed);
    }
  });

  it('SEED COVERAGE: the seed is derived from item-keyed content, not the ratio array', () => {
    const a = computeRetention(pairsFrom(EVIDENCE), { seedKey: SEED_KEY, floor: 0.9 });
    const b = computeRetention(pairsFrom([...EVIDENCE].reverse()), { seedKey: SEED_KEY, floor: 0.9 });
    expect(b.retention!.seed).toBe(a.retention!.seed);

    // …and DIFFERENT evidence that happens to share the same ratio multiset
    // must NOT collide: 0.2/0.8 and 0.1/0.4 are both 0.25, but they are not
    // the same measurement.
    const sameRatiosDifferentEvidence = computeRetention(
      pairsFrom(EVIDENCE.map((e) => ({ ...e, inc: e.inc / 2, cand: e.cand / 2 }))),
      { seedKey: SEED_KEY, floor: 0.9 },
    );
    expect(sameRatiosDifferentEvidence.retention!.seed).not.toBe(a.retention!.seed);
  });

  it('pairEvidence is emitted, ordered by itemId, and reconstructs the mean', () => {
    const r = computeRetention(pairsFrom(EVIDENCE), { seedKey: SEED_KEY, floor: 0.9 }).retention!;
    const ids = r.pairEvidence.map((p) => p.itemId);
    expect(ids).toEqual([...ids].sort());
    expect(r.pairEvidence).toHaveLength(r.pairs);
    const mean = r.pairEvidence.reduce((a, p) => a + p.ratio, 0) / r.pairEvidence.length;
    expect(mean).toBeCloseTo(r.mean, 12);
  });

  it('run-twice-diff: the same call twice is byte-identical', () => {
    const a = computeRetention(pairsFrom(EVIDENCE), { seedKey: SEED_KEY, floor: 0.9 });
    const b = computeRetention(pairsFrom(EVIDENCE), { seedKey: SEED_KEY, floor: 0.9 });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});

describe('pairedQualities pairs deterministically', () => {
  it('returns pairs ordered by itemId regardless of physical insert order', async () => {
    await seedRows(EVIDENCE);
    const first = await pair();
    expect(first.pairs.map((p) => p.itemId)).toEqual([...first.pairs.map((p) => p.itemId)].sort());

    // Same evidence, opposite physical insert order, fresh database.
    await db.close();
    db = await createDb();
    await migrate(db.db);
    await db.db.insert(orgs).values({ id: 'org_det', name: 'Determinism' }).onConflictDoNothing();
    await seedRows([...EVIDENCE].reverse());
    const second = await pair();
    expect(second.pairs).toEqual(first.pairs);
  });

  it('END-TO-END: physical insert order does not move the verdict', async () => {
    await seedRows(EVIDENCE);
    const a = computeRetention((await pair()).pairs, { seedKey: SEED_KEY, floor: 0.9 }).retention!;

    await db.close();
    db = await createDb();
    await migrate(db.db);
    await db.db.insert(orgs).values({ id: 'org_det', name: 'Determinism' }).onConflictDoNothing();
    await seedRows([...EVIDENCE].reverse());
    const b = computeRetention((await pair()).pairs, { seedKey: SEED_KEY, floor: 0.9 }).retention!;

    expect(b.mean).toBe(a.mean);
    expect(b.ci95).toEqual(a.ci95);
    expect(b.seed).toBe(a.seed);
    expect(b.pairEvidence).toEqual(a.pairEvidence);
  });

  it('REPORTS unpairable items instead of dropping them silently', async () => {
    await seedRows(EVIDENCE);
    // An item the incumbent was scored on but the candidate never was — a
    // coverage gap. Pre-fix this vanished and the verdict looked complete.
    await insertEvalResult(db.db, evalRow('item-99', INCUMBENT, 0.7));
    const { pairs, unpairable } = await pair();
    expect(pairs).toHaveLength(EVIDENCE.length);
    expect(unpairable).toEqual([{ itemId: 'item-99', has: 'incumbent' }]);
  });

  it('REFUSES duplicate evidence rather than letting scan order pick a value', async () => {
    await seedRows(EVIDENCE);
    // A second row for the same (item, strategy) with a DIFFERENT quality:
    // pre-fix, `m.set` kept whichever the scan returned last.
    await insertEvalResult(db.db, {
      ...evalRow('item-01', CANDIDATE, 0.95),
      cacheKey: 'ck-duplicate-collision',
    });
    await expect(pair()).rejects.toThrow(/duplicate eval evidence for item 'item-01'/);
  });
});
