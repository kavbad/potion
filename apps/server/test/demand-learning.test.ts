// DEMAND LEARNING END TO END (SERVING-ROADMAP S7 L2).
//
// L1 proved the signal is recorded per request. This proves the step that
// makes it usable across customers: served traffic accumulates in memory,
// flushes into k-gated cells, and — the part worth a test more than any
// other — a single org's traffic NEVER becomes a published cell no matter
// how much of it there is.
//
// Thresholds are lowered by env here (3 orgs / 3 requests) so the test can
// run three signups instead of five and twenty. The gate itself is the thing
// under test, not the numbers it is configured with.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { apiKeys, demandCellStaging, listDemandCells, orgs } from '@potion/db';
import { eq } from 'drizzle-orm';
import { buildServer } from '../src/server.js';
import { flushDemand } from '../src/demand.js';

let app: FastifyInstance;
const keys: string[] = [];
const orgIds: string[] = [];
const saved: Record<string, string | undefined> = {};

async function signup(email: string): Promise<{ apiKey: string; orgId: string }> {
  const link = await app.inject({
    method: 'POST',
    url: '/auth/request-link',
    headers: { 'content-type': 'application/json' },
    payload: { email },
  });
  const token = new URL(link.json().devLink as string).searchParams.get('token')!;
  const verify = await app.inject({
    method: 'GET',
    url: `/auth/verify?token=${encodeURIComponent(token)}`,
  });
  const cookie = String(verify.headers['set-cookie'] ?? '').split(';')[0]!;
  const created = await app.inject({
    method: 'POST',
    url: '/api/policies',
    headers: { cookie, 'content-type': 'application/json' },
    payload: { policy: { type: 'min_cost', qualityFloor: 0.8 }, createKey: true },
  });
  // The org id is not exposed by any dashboard route; read it from the key
  // the signup just minted, which is where serving reads it from too.
  const keyId = created.json().boundKeyId as string;
  const row = (
    await app.potion.db.db.select().from(apiKeys).where(eq(apiKeys.id, keyId))
  )[0]!;
  return { apiKey: created.json().apiKey as string, orgId: row.orgId };
}

beforeAll(async () => {
  for (const k of [
    'POTION_SELF_SERVE',
    'POTION_MAGIC_LINK_IN_RESPONSE',
    'POTION_DEV_AUTH',
    'POTION_DEMAND_MIN_ORGS',
    'POTION_DEMAND_MIN_REQUESTS',
  ]) {
    saved[k] = process.env[k];
  }
  process.env.POTION_SELF_SERVE = '1';
  process.env.POTION_MAGIC_LINK_IN_RESPONSE = '1';
  process.env.POTION_DEV_AUTH = '0';
  process.env.POTION_DEMAND_MIN_ORGS = '3';
  process.env.POTION_DEMAND_MIN_REQUESTS = '3';
  app = await buildServer({ seed: false, platformBaseline: true });

  for (const email of ['a@one.test', 'b@two.test', 'c@three.test']) {
    const { apiKey, orgId } = await signup(email);
    keys.push(apiKey);
    orgIds.push(orgId);
  }
}, 180_000);

afterAll(async () => {
  await app?.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const PROMPT = 'Write a Python function that merges two sorted lists.';

async function serve(apiKey: string, content: string): Promise<number> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    payload: { model: 'potion-auto', messages: [{ role: 'user', content }] },
  });
  return res.statusCode;
}

describe('served traffic becomes demand, but only as an aggregate', () => {
  it('one org, lots of traffic: accumulated privately, published NEVER', async () => {
    for (let i = 0; i < 8; i++) {
      expect(await serve(keys[0]!, PROMPT)).toBe(200);
    }
    await flushDemand(app.potion);

    // Staged — so it can join an aggregate later…
    const staged = await app.potion.db.db.select().from(demandCellStaging);
    expect(staged.length).toBeGreaterThan(0);
    expect(staged.reduce((n, r) => n + r.requests, 0)).toBe(8);
    // …and absent from the table anything else reads.
    expect(await listDemandCells(app.potion.db.db)).toHaveLength(0);
  }, 120_000);

  it('three orgs on the same workload publish one cell carrying no identity', async () => {
    for (const key of keys) {
      expect(await serve(key, PROMPT)).toBe(200);
    }
    await flushDemand(app.potion);

    const cells = await listDemandCells(app.potion.db.db);
    expect(cells.length).toBeGreaterThan(0);
    const cell = cells[0]!;
    expect(cell.orgCount).toBeGreaterThanOrEqual(3);
    expect(cell.shapeClass).toBe('no-tools/sync/0-1k');
    expect(cell.confidenceMean).not.toBeNull();
    const serialized = JSON.stringify(cells);
    for (const orgId of orgIds) expect(serialized).not.toContain(orgId);
  }, 120_000);

  it('an opted-out org contributes nothing — checked before anything is held', async () => {
    await app.potion.db.db
      .update(orgs)
      .set({ demandLearningOptOut: true })
      .where(eq(orgs.id, orgIds[0]!));
    // The set is refreshed by the flush; do one so the serve path sees it.
    await flushDemand(app.potion);

    const before = app.potion.demand.size;
    expect(await serve(keys[0]!, 'A completely different kind of request about tax law.')).toBe(200);
    // Nothing entered the accumulator at all — not held-then-filtered.
    expect(app.potion.demand.size).toBe(before);

    // …while a non-opted-out org on the same prompt does contribute.
    expect(await serve(keys[1]!, 'A completely different kind of request about tax law.')).toBe(200);
    expect(app.potion.demand.size).toBeGreaterThan(before);
  }, 120_000);
});
