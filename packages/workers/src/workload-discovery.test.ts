// G2 rung 1 — workload discovery: the pure grouping and the handler end to
// end (fake embedder, deterministic keyword geometry). Observed-only rows,
// snapshot replace, org scoping, noise gate.
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, insertTraceSpans, listOrgWorkloads, migrate, orgs, type DbHandle } from '@potion/db';
import { LEARNING_SPAN_NAME } from './learning-period.js';
import {
  WORKLOAD_MIN_SAMPLES,
  discoverGroups,
  workloadsDiscoverHandler,
  type DiscoverySample,
} from './workload-discovery.js';
import type { JobContext } from './handlers.js';

const REPO_PRICES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../prices.json');

let db: DbHandle;
let pricesPath: string;

beforeEach(async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'potion-wd-'));
  pricesPath = path.join(root, 'prices.json');
  copyFileSync(REPO_PRICES, pricesPath);
  db = await createDb();
  await migrate(db.db);
  await db.db.insert(orgs).values([{ id: 'org_wd', name: 'WD' }, { id: 'org_wd_b', name: 'WDB' }]).onConflictDoNothing();
});
afterEach(async () => {
  await db.close();
});

/** Deterministic keyword geometry: three orthogonal directions. */
const fakeEmbedder = {
  embed: async (texts: string[]): Promise<number[][]> =>
    texts.map((t) => (t.includes('invoice') ? [1, 0, 0] : t.includes('poem') ? [0, 1, 0] : [0, 0, 1])),
};

function ctx(): JobContext {
  return { db: db.db, dbHandle: db, pricesPath, embedder: fakeEmbedder, embedderKind: 'mock' };
}

function span(orgId: string, traceId: string, text: string, cluster = 'classification') {
  return {
    orgId, traceId, spanId: 'chat', parentId: null, name: LEARNING_SPAN_NAME, model: 'mock-cheap', usage: {}, costUsd: 0,
    attrs: {
      'gen_ai.operation.name': 'chat',
      'potion.messages': [{ role: 'user', content: text }],
      'gen_ai.completion': 'ok',
      'potion.cluster_id': cluster,
    },
    ts: new Date(),
  };
}

describe('discoverGroups (pure)', () => {
  it('groups by geometry within a parent, drops sub-minimum noise, picks the medoid exemplar', () => {
    const samples: DiscoverySample[] = [
      ...Array.from({ length: 6 }, (_, i) => ({ id: `a${i}`, parentCluster: 'classification', text: `invoice ${i}` })),
      ...Array.from({ length: 5 }, (_, i) => ({ id: `b${i}`, parentCluster: 'classification', text: `poem ${i}` })),
      { id: 'z0', parentCluster: 'classification', text: 'something else entirely' },
    ];
    const vectors = samples.map((s) => (s.text.includes('invoice') ? [1, 0, 0] : s.text.includes('poem') ? [0, 1, 0] : [0, 0, 1]));
    const { groups, noiseSamples } = discoverGroups(samples, vectors, 0.62);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.members.length).sort()).toEqual([5, 6]);
    expect(noiseSamples).toBe(1); // the singleton is noise, counted, never a workload
    for (const g of groups) {
      expect(g.cohesion).toBeCloseTo(1, 6); // orthogonal fixture: perfect groups
      expect(g.members).toContain(g.exemplarIndex);
    }
  });

  it('is a function of the sample SET, not arrival order', () => {
    const mk = (ids: string[]): DiscoverySample[] => ids.map((id) => ({ id, parentCluster: 'x', text: id.startsWith('a') ? 'invoice' : 'poem' }));
    const a = mk(['a1', 'a2', 'a3', 'a4', 'a5', 'b1', 'b2', 'b3', 'b4', 'b5']);
    const b = mk(['b5', 'a3', 'b1', 'a1', 'b4', 'a5', 'b2', 'a2', 'b3', 'a4']);
    const vec = (ss: DiscoverySample[]) => ss.map((s) => (s.text === 'invoice' ? [1, 0] : [0, 1]));
    const ga = discoverGroups(a, vec(a), 0.62).groups.map((g) => g.members.length).sort();
    const gb = discoverGroups(b, vec(b), 0.62).groups.map((g) => g.members.length).sort();
    expect(ga).toEqual(gb);
  });
});

describe('workloads:discover (handler)', () => {
  it('discovers the org structure, snapshot-replaces on re-run, never leaks across orgs', async () => {
    await insertTraceSpans(db.db, [
      ...Array.from({ length: 6 }, (_, i) => span('org_wd', `wd-inv${i}`, `invoice field ${i} please extract`)),
      ...Array.from({ length: 5 }, (_, i) => span('org_wd', `wd-poem${i}`, `write a short poem about ${i}`)),
      span('org_wd', 'wd-noise', 'one-off request unlike the others'),
      ...Array.from({ length: WORKLOAD_MIN_SAMPLES }, (_, i) => span('org_wd_b', `wdb-${i}`, `invoice ${i}`)),
    ]);
    const result = await workloadsDiscoverHandler({ orgId: 'org_wd' }, ctx());
    expect(result).toMatchObject({ orgs: 1, samplesSeen: 12, discovered: 2, noiseSamples: 1 });

    const rows = await listOrgWorkloads(db.db, 'org_wd');
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === 'observed')).toBe(true); // never routed by discovery
    expect(rows.every((r) => r.parentCluster === 'classification')).toBe(true);
    expect(rows.map((r) => r.sampleCount).sort()).toEqual([5, 6]);
    const exemplars = rows.map((r) => r.exemplarText).join(' ');
    expect(exemplars).toContain('invoice');
    expect(exemplars).toContain('poem');
    expect(rows.every((r) => /^wl-[a-z0-9]+-classification-\d$/.test(r.id))).toBe(true);
    // org B untouched by an org-scoped run
    expect(await listOrgWorkloads(db.db, 'org_wd_b')).toHaveLength(0);

    // snapshot semantics: fewer samples on re-run → the old structure is
    // replaced, not accumulated
    await db.db.delete((await import('@potion/db')).traceSpans).where(
      (await import('drizzle-orm')).like((await import('@potion/db')).traceSpans.traceId, 'wd-poem%'),
    );
    await workloadsDiscoverHandler({ orgId: 'org_wd' }, ctx());
    const again = await listOrgWorkloads(db.db, 'org_wd');
    expect(again).toHaveLength(1);
    expect(again[0]!.sampleCount).toBe(6);
  });

  it('refuses without an embedder — a discovery that cannot embed must say so, not no-op', async () => {
    const bare: JobContext = { db: db.db, dbHandle: db, pricesPath };
    await expect(workloadsDiscoverHandler({ orgId: 'org_wd' }, bare)).rejects.toThrow('requires JobContext.embedder');
  });
});
