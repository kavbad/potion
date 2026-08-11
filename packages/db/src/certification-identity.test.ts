// F7 — a certification is bound to WHAT THE SUITE MEANS.
//
// Measured before the fix, all three on a certified 6-item suite:
//   A  every item's judge rubric rewritten  → certified = true  (silent)
//   C  half the items purged (retention)    → certified = true  (silent)
//   B  all items purged                     → certified = false, but by
//      ACCIDENT: derivedSuiteIdFor falls back to -replays-v1 on an empty
//      suite, so the reason blamed a missing suite instead of naming what
//      happened.
//
// Root cause: identity was (suiteId, suiteVersion), and suiteVersion moved in
// exactly one place — when items were ADDED. It could not observe removal or
// re-scoring. Not a weak key; a key to the wrong thing.
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  certificationStateForCluster,
  computeSuiteContentHash,
  createDb,
  insertSuiteCertificationTx,
  invalidateDriftedCertifications,
  listSuiteCertifications,
  migrate,
  purgeDerivedSuiteItems,
  restampDerivedSuiteRubric,
  upsertDerivedSuite,
  type DbHandle,
} from './index.js';
import { seedIsolationOrgs, ORG_A } from './test-fixtures/orgs.js';

const CLUSTER = 'agent-abc123-def456';
const SUITE = `${CLUSTER}-replays-v2`;

async function certifiedSuite(): Promise<DbHandle> {
  const h = await createDb();
  await migrate(h.db);
  await seedIsolationOrgs(h.db);
  await upsertDerivedSuite(h.db, {
    suiteId: SUITE,
    clusterId: CLUSTER,
    orgId: ORG_A,
    manifest: { suiteId: SUITE },
    items: [1, 2, 3, 4, 5, 6].map((i) => ({
      id: `${SUITE}-item-${i}`,
      clusterId: CLUSTER,
      prompt: [{ role: 'user' as const, content: `q${i}` }],
      reference: 'y',
      scoring: {
        kind: 'llm-judge' as const,
        rubric: 'ORIGINAL RUBRIC',
        judgeModel: 'mock-judge',
        scale: [0, 1] as [number, number],
      },
    })),
    itemCap: 50,
  });
  await insertSuiteCertificationTx(h.db, {
    orgId: ORG_A,
    clusterId: CLUSTER,
    suiteId: SUITE,
    suiteVersion: '1.0.0',
    suiteContentHash: await computeSuiteContentHash(h.db, SUITE),
    incumbentHash: 'h',
    providerMode: 'mock',
    status: 'certified',
    evidence: { selfRetentionMean: 0.95, floor: 0.9, items: 6, executed: 6 },
  });
  const ok = await certificationStateForCluster(h.db, CLUSTER, ORG_A);
  expect(ok.certified, 'fixture must start genuinely certified').toBe(true);
  return h;
}

/** Age the first three items so a retention cutoff removes exactly them. */
async function ageThreeItems(h: DbHandle): Promise<void> {
  await h.db.execute(
    sql.raw(`UPDATE derived_suite_items SET created_at = now() - interval '400 days'
             WHERE suite_id = '${SUITE}' AND item_id IN
               ('${SUITE}-item-1','${SUITE}-item-2','${SUITE}-item-3')`),
  );
}

describe('F7: changing what a suite MEANS invalidates its certification', () => {
  it('CASE A: rewriting every item\'s rubric invalidates it', async () => {
    const h = await certifiedSuite();
    const n = await restampDerivedSuiteRubric(h.db, SUITE, 'A COMPLETELY DIFFERENT RUBRIC');
    expect(n).toBe(6);
    const st = await certificationStateForCluster(h.db, CLUSTER, ORG_A);
    expect(st.certified).toBe(false);
    // Same prompts, different question asked of them.
    expect(st.reason).toMatch(/CONTENT changed|re-derivation/);
    await h.close();
  }, 120_000);

  it('CASE C: a PARTIAL retention purge invalidates it — the ordinary path', async () => {
    const h = await certifiedSuite();
    await ageThreeItems(h);
    const r = await purgeDerivedSuiteItems(h.db, ORG_A, new Date(Date.now() - 90 * 864e5));
    expect(r.itemsDeleted).toBe(3);
    const st = await certificationStateForCluster(h.db, CLUSTER, ORG_A);
    expect(st.certified, 'half the instrument was deleted and it still certified').toBe(false);
    await h.close();
  }, 120_000);

  it('CASE B: a FULL purge says what actually happened, not "no derived suite v1"', async () => {
    const h = await certifiedSuite();
    await purgeDerivedSuiteItems(h.db, ORG_A, 'all');
    const st = await certificationStateForCluster(h.db, CLUSTER, ORG_A);
    expect(st.certified).toBe(false);
    expect(st.reason).toContain('purged');
    expect(st.reason, 'the old message blamed a missing v1 suite').not.toContain(
      "no derived suite 'agent-abc123-def456-replays-v1'",
    );
    await h.close();
  }, 120_000);

  it('THE FALSE-REFUSE GUARD: a no-op re-derivation does NOT invalidate', async () => {
    // Without this the fix trades a silent false-certify for a noisy
    // false-refuse, which is its own kind of dishonest.
    const h = await certifiedSuite();
    const before = await computeSuiteContentHash(h.db, SUITE);
    await upsertDerivedSuite(h.db, {
      suiteId: SUITE,
      clusterId: CLUSTER,
      orgId: ORG_A,
      manifest: { suiteId: SUITE },
      items: [1, 2, 3].map((i) => ({
        id: `${SUITE}-item-${i}`, // already present → onConflictDoNothing
        clusterId: CLUSTER,
        prompt: [{ role: 'user' as const, content: `q${i}` }],
        reference: 'y',
        scoring: {
          kind: 'llm-judge' as const,
          rubric: 'ORIGINAL RUBRIC',
          judgeModel: 'mock-judge',
          scale: [0, 1] as [number, number],
        },
      })),
      itemCap: 50,
    });
    expect(await computeSuiteContentHash(h.db, SUITE)).toBe(before);
    expect((await certificationStateForCluster(h.db, CLUSTER, ORG_A)).certified).toBe(true);
    await h.close();
  }, 120_000);

  it('the hash is order-independent and byte-stable across re-reads', async () => {
    const h = await certifiedSuite();
    const a = await computeSuiteContentHash(h.db, SUITE);
    const b = await computeSuiteContentHash(h.db, SUITE);
    expect(b).toBe(a);
    // Row order must not move it — a gate that flipped on scan order would be
    // a random refusal generator.
    await h.db.execute(sql.raw(`UPDATE derived_suite_items SET created_at = created_at
                                WHERE suite_id = '${SUITE}'`));
    expect(await computeSuiteContentHash(h.db, SUITE)).toBe(a);
    await h.close();
  }, 120_000);

  it('a certification with NO content hash fails CLOSED', async () => {
    const h = await certifiedSuite();
    await h.db.execute(sql.raw('UPDATE suite_certifications SET suite_content_hash = NULL'));
    const st = await certificationStateForCluster(h.db, CLUSTER, ORG_A);
    expect(st.certified).toBe(false);
    expect(st.reason).toContain('predates content-hash binding');
    await h.close();
  }, 120_000);
});

describe('F7: invalidation is a VISIBLE state, not just a refusal', () => {
  it('drift demotes the row to `invalidated`, once, with a reason', async () => {
    const h = await certifiedSuite();
    await ageThreeItems(h);
    await purgeDerivedSuiteItems(h.db, ORG_A, new Date(Date.now() - 90 * 864e5));

    const first = await invalidateDriftedCertifications(h.db, ORG_A);
    expect(first).toHaveLength(1);
    expect(first[0]!.suiteId).toBe(SUITE);
    expect(first[0]!.certifiedHash).not.toBe(first[0]!.liveHash);

    const rows = await listSuiteCertifications(h.db, ORG_A);
    const row = rows.find((r) => r.id === first[0]!.certificationId)!;
    expect(row.status).toBe('invalidated');
    expect(row.statusReason).toContain('suite content changed');

    // Idempotent: a second purge must not re-alert the customer.
    expect(await invalidateDriftedCertifications(h.db, ORG_A)).toHaveLength(0);
    await h.close();
  }, 120_000);

  it('an UNCHANGED suite is never invalidated', async () => {
    const h = await certifiedSuite();
    expect(await invalidateDriftedCertifications(h.db, ORG_A)).toEqual([]);
    expect((await certificationStateForCluster(h.db, CLUSTER, ORG_A)).certified).toBe(true);
    await h.close();
  }, 120_000);
});
