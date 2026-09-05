// G2 rung 4 — the generation lifecycle, where the invariants are.
//
// A generation is only worth having if "put it back" actually puts it back,
// so these assert the STATE OF THE PINS after each transition, not just the
// row's status word. The pins are what serving reads; the status is only a
// label on top of them, and a label that disagreed with the pins would be
// the exact class of lie this codebase spends its effort preventing.
import { describe, expect, it } from 'vitest';
import { createDb, migrate } from './index.js';
import { listFrontierPins } from './repos/frontier-pins.js';
import {
  getRouterGeneration,
  insertRouterGeneration,
  listRouterGenerations,
  promoteGeneration,
  rollbackCandidates,
  rollbackTo,
  servingGeneration,
} from './repos/router-generations.js';
import { ORG_A, ORG_B, seedIsolationOrgs } from './test-fixtures/orgs.js';
import type { GenerationPin } from './schema.js';

const pin = (frontierId: string, frontierVersion: number): GenerationPin => ({
  frontierId,
  frontierVersion,
  instrument: 'default',
});

async function fresh() {
  const h = await createDb();
  await migrate(h.db);
  await seedIsolationOrgs(h.db);
  return h;
}

/** cluster → frontierId, the shape these tests actually reason about. */
async function pinMap(db: Parameters<typeof listFrontierPins>[0], orgId: string): Promise<Record<string, string>> {
  const rows = await listFrontierPins(db, orgId);
  return Object.fromEntries(rows.map((r) => [r.clusterId, r.frontierId]));
}

describe('router generations — the lifecycle', () => {
  it('a candidate serves nothing until it is promoted', async () => {
    const h = await fresh();
    await insertRouterGeneration(h.db, { id: 'g1', orgId: ORG_A, pins: { 'code-gen': pin('fr-1', 1) } });
    expect(await servingGeneration(h.db, ORG_A)).toBeNull();
    expect(await pinMap(h.db, ORG_A)).toEqual({});
    await h.close();
  });

  it('promoting writes the whole pin set and marks the generation serving', async () => {
    const h = await fresh();
    await insertRouterGeneration(h.db, {
      id: 'g1',
      orgId: ORG_A,
      pins: { 'code-gen': pin('fr-cg-1', 1), extraction: pin('fr-ex-1', 1) },
    });
    const res = await promoteGeneration(h.db, ORG_A, 'g1');
    expect(res.ok).toBe(true);
    expect(res.generation?.status).toBe('serving');
    expect(res.generation?.promotedAt).not.toBeNull();
    expect(await pinMap(h.db, ORG_A)).toEqual({ 'code-gen': 'fr-cg-1', extraction: 'fr-ex-1' });
    await h.close();
  });

  it('at most ONE generation serves — promoting supersedes the incumbent', async () => {
    const h = await fresh();
    await insertRouterGeneration(h.db, { id: 'g1', orgId: ORG_A, pins: { 'code-gen': pin('fr-1', 1) } });
    await insertRouterGeneration(h.db, { id: 'g2', orgId: ORG_A, pins: { 'code-gen': pin('fr-2', 2) } });
    await promoteGeneration(h.db, ORG_A, 'g1');
    await promoteGeneration(h.db, ORG_A, 'g2');

    const all = await listRouterGenerations(h.db, ORG_A);
    expect(all.filter((g) => g.status === 'serving').map((g) => g.id)).toEqual(['g2']);
    expect((await getRouterGeneration(h.db, ORG_A, 'g1'))?.status).toBe('superseded');
    expect((await getRouterGeneration(h.db, ORG_A, 'g1'))?.endedAt).not.toBeNull();
    expect(await pinMap(h.db, ORG_A)).toEqual({ 'code-gen': 'fr-2' });
    await h.close();
  });

  it('a cluster the new generation does NOT name is RELEASED, not left frozen', async () => {
    // The half that is easy to miss: promoting must write the whole surface,
    // so a cluster that has dropped out of the routing picture stops being
    // pinned. Leaving it would freeze a cluster at a version no generation
    // mentions, and nothing a reader could look at would explain it.
    const h = await fresh();
    await insertRouterGeneration(h.db, {
      id: 'g1',
      orgId: ORG_A,
      pins: { 'code-gen': pin('fr-cg-1', 1), extraction: pin('fr-ex-1', 1) },
    });
    await insertRouterGeneration(h.db, { id: 'g2', orgId: ORG_A, pins: { 'code-gen': pin('fr-cg-2', 2) } });
    await promoteGeneration(h.db, ORG_A, 'g1');
    await promoteGeneration(h.db, ORG_A, 'g2');
    expect(await pinMap(h.db, ORG_A)).toEqual({ 'code-gen': 'fr-cg-2' });
    await h.close();
  });

  it('rollback puts the OLD pins back, exactly', async () => {
    const h = await fresh();
    await insertRouterGeneration(h.db, {
      id: 'g1',
      orgId: ORG_A,
      pins: { 'code-gen': pin('fr-cg-1', 1), extraction: pin('fr-ex-1', 1) },
    });
    await insertRouterGeneration(h.db, { id: 'g2', orgId: ORG_A, pins: { 'code-gen': pin('fr-cg-2', 2) } });
    await promoteGeneration(h.db, ORG_A, 'g1');
    await promoteGeneration(h.db, ORG_A, 'g2');

    const back = await rollbackTo(h.db, ORG_A, 'g1');
    expect(back.ok).toBe(true);
    // The whole surface returns, including the cluster g2 had released.
    expect(await pinMap(h.db, ORG_A)).toEqual({ 'code-gen': 'fr-cg-1', extraction: 'fr-ex-1' });
    expect((await getRouterGeneration(h.db, ORG_A, 'g2'))?.status).toBe('rolled-back');
    expect((await servingGeneration(h.db, ORG_A))?.id).toBe('g1');
    await h.close();
  });

  it("'rolled-back' and 'superseded' are different words on purpose", async () => {
    // Superseded = something newer came along. Rolled-back = a person judged
    // this routing wrong. Collapsing them would erase the only durable
    // record that a promotion was a mistake.
    const h = await fresh();
    await insertRouterGeneration(h.db, { id: 'g1', orgId: ORG_A, pins: { 'code-gen': pin('fr-1', 1) } });
    await insertRouterGeneration(h.db, { id: 'g2', orgId: ORG_A, pins: { 'code-gen': pin('fr-2', 2) } });
    await promoteGeneration(h.db, ORG_A, 'g1');
    await promoteGeneration(h.db, ORG_A, 'g2');
    expect((await getRouterGeneration(h.db, ORG_A, 'g1'))?.status).toBe('superseded');
    await rollbackTo(h.db, ORG_A, 'g1');
    expect((await getRouterGeneration(h.db, ORG_A, 'g2'))?.status).toBe('rolled-back');
    await h.close();
  });

  it('refuses the transitions that would lie about what happened', async () => {
    const h = await fresh();
    await insertRouterGeneration(h.db, { id: 'g1', orgId: ORG_A, pins: { 'code-gen': pin('fr-1', 1) } });
    expect((await promoteGeneration(h.db, ORG_A, 'nope')).reason).toContain('unknown');
    // A candidate has never served, so there is nothing to go "back" to.
    expect((await rollbackTo(h.db, ORG_A, 'g1')).reason).toContain('never served');
    await promoteGeneration(h.db, ORG_A, 'g1');
    // Promoting the serving generation again would invent a second promotion
    // of the same routing.
    expect((await promoteGeneration(h.db, ORG_A, 'g1')).reason).toContain('serving');
    expect((await rollbackTo(h.db, ORG_A, 'g1')).reason).toContain('already serving');
    await h.close();
  });

  it('generations are org-scoped: one org can never promote or read another’s', async () => {
    const h = await fresh();
    await insertRouterGeneration(h.db, { id: 'g1', orgId: ORG_A, pins: { 'code-gen': pin('fr-a', 1) } });
    expect(await getRouterGeneration(h.db, ORG_B, 'g1')).toBeNull();
    expect((await promoteGeneration(h.db, ORG_B, 'g1')).reason).toContain('unknown');
    expect(await listRouterGenerations(h.db, ORG_B)).toEqual([]);
    // ORG_A's pins are untouched by ORG_B's failed attempt.
    await promoteGeneration(h.db, ORG_A, 'g1');
    expect(await pinMap(h.db, ORG_B)).toEqual({});
    expect(await pinMap(h.db, ORG_A)).toEqual({ 'code-gen': 'fr-a' });
    await h.close();
  });

  it('rollbackCandidates offers what has actually served, newest first', async () => {
    const h = await fresh();
    for (const id of ['g1', 'g2', 'g3']) {
      await insertRouterGeneration(h.db, { id, orgId: ORG_A, pins: { 'code-gen': pin(`fr-${id}`, 1) } });
    }
    expect(await rollbackCandidates(h.db, ORG_A)).toEqual([]); // all candidates
    await promoteGeneration(h.db, ORG_A, 'g1');
    await promoteGeneration(h.db, ORG_A, 'g2');
    await promoteGeneration(h.db, ORG_A, 'g3');
    const offered = (await rollbackCandidates(h.db, ORG_A)).map((g) => g.id);
    expect(offered).toEqual(['g2', 'g1']); // g3 is serving, so not offered
    await h.close();
  });
});
