// The signup floor (2026-09-18): a minted 'default' rule starts at the
// highest bar every measured kind of work can prove — not the 0.95 constant,
// which no frontier could honour (44% policy_infeasible on the sized
// head-to-head). The boot repair lowers UNCHOSEN 0.95 rows; edited rows stay.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256, type FrontierPoint } from '@potion/core';
import { createDb, createMembership, createOrg, createSession, createUser, getPolicyById, insertPolicy, listApiKeys, migrate, repairSignupDefaultFloors, type DbHandle } from '@potion/db';
import { saveFrontier } from '@potion/pareto';
import { DEFAULT_ORG_POLICY } from '../src/routing/default-policy.js';
import { buildServer } from '../src/server.js';

const ORG = 'org_signup_floor';
const COOKIE = 'potion_session=ps_signup_floor';
let h: DbHandle;
let app: FastifyInstance;
let devAuthBefore: string | undefined;

function point(clusterId: string, model: string, quality: number, half: number, costPer1K: number): FrontierPoint {
  return { clusterId, strategyHash: `h-${clusterId}-${model}`, strategyConfig: { type: 'single', model }, quality, costPer1K, latencyP95: 300, providerMode: 'mock', evidence: { cacheKeys: [], runIds: [], n: 20, qualityCi95: half } };
}

beforeAll(async () => {
  devAuthBefore = process.env.POTION_DEV_AUTH;
  process.env.POTION_DEV_AUTH = '0';
  h = await createDb();
  await migrate(h.db);
  await createOrg(h.db, { id: ORG, name: 'Signup Floor Org' });
  await createUser(h.db, { id: 'usr_sf', email: 'sf@x.dev', name: 'sf' });
  await createMembership(h.db, { orgId: ORG, userId: 'usr_sf', role: 'admin' });
  await createSession(h.db, { id: 'ses_sf', userId: 'usr_sf', tokenHash: sha256('ps_signup_floor'), orgId: ORG, expiresAt: new Date(Date.now() + 3600_000) });
  // classification proves 0.97; agentic proves 0.8226 → the signup floor is 0.82.
  await saveFrontier(h.db, 'classification', [point('classification', 'mock-cheap', 0.9, 0.05, 0.2), point('classification', 'mock-mid', 0.99, 0.02, 2)], 'manual', 'test-prices');
  await saveFrontier(h.db, 'agentic-tool-use', [point('agentic-tool-use', 'mock-mid', 0.8526, 0.03, 2)], 'manual', 'test-prices');
  app = await buildServer({ db: h, seed: false });
});
afterAll(async () => {
  await app.close();
  if (devAuthBefore === undefined) delete process.env.POTION_DEV_AUTH; else process.env.POTION_DEV_AUTH = devAuthBefore;
});

describe('the signup floor', () => {
  it("a minted key's 'default' rule starts at the highest bar every kind of work can prove, not at 0.95", async () => {
    const res = await app.inject({ method: 'POST', url: '/api/api-keys', headers: { cookie: COOKIE, 'content-type': 'application/json' }, payload: { name: 'first key' } });
    expect(res.statusCode, res.body).toBe(201);
    const key = (await listApiKeys(h.db, ORG)).find((k) => k.name === 'first key')!;
    const pol = await getPolicyById(h.db, ORG, key.policyId!);
    expect(pol?.name).toBe('default');
    expect(pol?.config).toEqual({ type: 'min_cost', qualityFloor: 0.82 });
    expect(pol?.config).not.toEqual(DEFAULT_ORG_POLICY);
  });

  it('the boot repair lowers an UNCHOSEN 0.95 row and leaves an edited one alone', async () => {
    await createOrg(h.db, { id: 'org_sf_legacy', name: 'legacy' });
    await insertPolicy(h.db, { id: 'pol-sf-legacy', orgId: 'org_sf_legacy', name: 'default', config: DEFAULT_ORG_POLICY });
    await createOrg(h.db, { id: 'org_sf_edited', name: 'edited' });
    await insertPolicy(h.db, { id: 'pol-sf-edited', orgId: 'org_sf_edited', name: 'default', config: { type: 'min_cost', qualityFloor: 0.9 } });
    const lowered = await repairSignupDefaultFloors(h.db, 0.82, [0.95]);
    expect(lowered.filter((r) => r.orgId.startsWith('org_sf_'))).toEqual([{ orgId: 'org_sf_legacy', policyId: 'pol-sf-legacy', from: 0.95, to: 0.82 }]);
    expect((await getPolicyById(h.db, 'org_sf_legacy', 'pol-sf-legacy'))?.config).toEqual({ type: 'min_cost', qualityFloor: 0.82 });
    expect((await getPolicyById(h.db, 'org_sf_edited', 'pol-sf-edited'))?.config).toEqual({ type: 'min_cost', qualityFloor: 0.9 });
    // idempotent
    expect((await repairSignupDefaultFloors(h.db, 0.82, [0.95])).filter((r) => r.orgId.startsWith('org_sf_'))).toEqual([]);
  });
});
