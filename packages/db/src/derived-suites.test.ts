// Derived-suite storage (G1.3, migration 0021): merge/cap/version semantics
// mirror the pre-G1.3 file writer; retention purges by time window; the
// provenance row survives a full purge (retention-0 "metadata only").
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createDb,
  createOrg,
  loadDerivedSuite,
  listDerivedSuites,
  migrate,
  purgeDerivedSuiteItems,
  upsertDerivedSuite,
  type DbHandle,
} from './index.js';

let handle: DbHandle;
const db = () => handle.db;

const ORG = 'org_ds';
const SUITE = 'agent-abc123-def456-replays-v1';

function item(id: string, sourceTraceId?: string) {
  return {
    id,
    clusterId: 'agent-abc123-def456',
    prompt: [{ role: 'user' as const, content: `replay ${id}` }],
    scoring: { kind: 'llm-judge' as const, rubric: 'r', judgeModel: 'mock-judge', scale: [0, 1] as [number, number] },
    ...(sourceTraceId !== undefined ? { sourceTraceId } : {}),
  };
}

beforeEach(async () => {
  handle = await createDb();
  await migrate(handle.db);
  await createOrg(handle.db, { id: ORG, name: 'DS' });
});

afterEach(async () => {
  await handle.close();
});

describe('upsertDerivedSuite', () => {
  it('creates with provenance, merges idempotently, bumps patch only on roster change', async () => {
    const first = await upsertDerivedSuite(db(), {
      suiteId: SUITE,
      clusterId: 'agent-abc123-def456',
      orgId: ORG,
      manifest: { suiteId: SUITE, license: 'Proprietary (customer-derived, redacted)' },
      items: [item(`${SUITE}-aaaa`, 'tr_1')],
      itemCap: 25,
    });
    expect(first).toEqual({ created: true, itemsAdded: 1, version: '1.0.0' });

    // identical re-run: no changes, no bump
    const again = await upsertDerivedSuite(db(), {
      suiteId: SUITE,
      clusterId: 'agent-abc123-def456',
      orgId: ORG,
      manifest: {},
      items: [item(`${SUITE}-aaaa`)],
      itemCap: 25,
    });
    expect(again).toEqual({ created: false, itemsAdded: 0, version: '1.0.0' });

    // new item: added + patch bump
    const grown = await upsertDerivedSuite(db(), {
      suiteId: SUITE,
      clusterId: 'agent-abc123-def456',
      orgId: ORG,
      manifest: {},
      items: [item(`${SUITE}-bbbb`, 'tr_2')],
      itemCap: 25,
    });
    expect(grown).toEqual({ created: false, itemsAdded: 1, version: '1.0.1' });

    const loaded = await loadDerivedSuite(db(), SUITE);
    expect(loaded?.suite.orgId).toBe(ORG);
    expect(loaded?.items.map((i) => i.id)).toEqual([`${SUITE}-aaaa`, `${SUITE}-bbbb`]);
    expect(await loadDerivedSuite(db(), 'agent-nope-replays-v1')).toBeNull();
  });

  it('caps the roster deterministically (id-ordered head)', async () => {
    const res = await upsertDerivedSuite(db(), {
      suiteId: SUITE,
      clusterId: 'agent-abc123-def456',
      orgId: ORG,
      manifest: {},
      items: [item(`${SUITE}-cc`), item(`${SUITE}-aa`), item(`${SUITE}-bb`)],
      itemCap: 2,
    });
    expect(res.itemsAdded).toBe(2);
    const loaded = await loadDerivedSuite(db(), SUITE);
    expect(loaded?.items.map((i) => i.id)).toEqual([`${SUITE}-aa`, `${SUITE}-bb`]);
  });
});

describe('purgeDerivedSuiteItems', () => {
  it('time-windowed purge deletes old items; "all" empties but keeps the provenance row', async () => {
    await upsertDerivedSuite(db(), {
      suiteId: SUITE,
      clusterId: 'agent-abc123-def456',
      orgId: ORG,
      manifest: { license: 'Proprietary' },
      items: [item(`${SUITE}-aaaa`, 'tr_1'), item(`${SUITE}-bbbb`, 'tr_2')],
      itemCap: 25,
    });
    // nothing older than a past cutoff
    const noop = await purgeDerivedSuiteItems(db(), ORG, new Date(Date.now() - 86_400_000));
    expect(noop).toEqual({ itemsDeleted: 0, suitesEmptied: 0 });
    // future cutoff deletes everything in-window
    const purged = await purgeDerivedSuiteItems(db(), ORG, new Date(Date.now() + 1000));
    expect(purged).toEqual({ itemsDeleted: 2, suitesEmptied: 1 });
    const loaded = await loadDerivedSuite(db(), SUITE);
    expect(loaded?.items).toEqual([]); // items gone
    expect(loaded?.suite.orgId).toBe(ORG); // provenance stub remains
    // idempotent
    expect(await purgeDerivedSuiteItems(db(), ORG, 'all')).toEqual({ itemsDeleted: 0, suitesEmptied: 0 });
    expect(await listDerivedSuites(db(), { orgId: ORG })).toHaveLength(1);
  });
});
