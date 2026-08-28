// Internal-row discipline (2026-08-28): the Lab's org-scoped policy rows
// (lab-io at floor ZERO, dial pins) and ephemeral keys must NEVER be read
// as, bound to, or clobbered as customer rows. Found live: the operator's
// own router page described lab-io — "quality at or above 0.00" — as the
// org's rule.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256 } from '@potion/core';
import {
  createDb,
  createMembership,
  createOrg,
  createSession,
  createUser,
  insertApiKey,
  insertPolicy,
  getApiKeyById,
  listApiKeys,
  migrate,
  repairInternalPolicyBindings,
  type DbHandle,
} from '@potion/db';
import { DEFAULT_ORG_POLICY } from '../src/routing/default-policy.js';
import { buildServer } from '../src/server.js';

const ORG = 'org_internal_pol';
const COOKIE = 'potion_session=ps_internal_pol';

let h: DbHandle;
let app: FastifyInstance;
let devAuthBefore: string | undefined;

beforeAll(async () => {
  devAuthBefore = process.env.POTION_DEV_AUTH;
  process.env.POTION_DEV_AUTH = '0';
  h = await createDb();
  await migrate(h.db);
  await createOrg(h.db, { id: ORG, name: 'Internal Policy Org' });
  await createUser(h.db, { id: 'usr_ip', email: 'ip@x.dev', name: 'ip' });
  await createMembership(h.db, { orgId: ORG, userId: 'usr_ip', role: 'admin' });
  await createSession(h.db, {
    id: 'ses_ip', userId: 'usr_ip', tokenHash: sha256('ps_internal_pol'), orgId: ORG,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  // The trap, laid exactly as the Lab AND the onboarding interpreter lay
  // it: internal rows FIRST — onboarding-io is the one that actually hit
  // the operator (floor ZERO, minted by describing your product).
  await insertPolicy(h.db, {
    id: `pol-onb-${ORG.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24)}`,
    orgId: ORG, name: 'onboarding-io', config: { type: 'min_cost', qualityFloor: 0 },
  });
  await insertPolicy(h.db, {
    id: `pol-lab-io-${ORG.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24)}`,
    orgId: ORG, name: 'lab-io', config: { type: 'min_cost', qualityFloor: 0 },
  });
  await insertPolicy(h.db, {
    id: 'pol-lab-abc123-abcdef123456-brain', orgId: ORG,
    name: 'lab-abc123-abcdef123456-brain', config: { type: 'min_cost', qualityFloor: 0.1 },
  });
  app = await buildServer({ db: h, seed: false });
}, 120_000);

afterAll(async () => {
  if (devAuthBefore === undefined) delete process.env.POTION_DEV_AUTH;
  else process.env.POTION_DEV_AUTH = devAuthBefore;
  await app.close();
  await h.close();
});

describe('internal policies never masquerade as the org rule', () => {
  it('a minted key binds a NON-internal policy even when lab rows came first', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/api-keys',
      headers: { cookie: COOKIE, 'content-type': 'application/json' },
      payload: { name: 'first key' },
    });
    expect(res.statusCode, res.body).toBe(201);
    const keys = await listApiKeys(h.db, ORG);
    const mine = keys.find((k) => k.name === 'first key')!;
    expect(mine.policyId).not.toBeNull();
    expect(mine.policyId!.startsWith('pol-lab-')).toBe(false);
  });

  it('the connection page describes the customer rule, never floor 0.00', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/connection', headers: { cookie: COOKIE } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { policy?: { description?: string } | null };
    expect(JSON.stringify(body)).not.toContain('0.0000');
    expect(JSON.stringify(body)).not.toContain('at or above 0<');
  });

  it('a settings rebind leaves lab keys untouched', async () => {
    await insertApiKey(h.db, {
      id: 'key-labrun-run-x-abc', keyHash: sha256('pk_labrun_x'), name: 'lab-run-run-x-abc',
      orgId: ORG, policyId: `pol-lab-io-${ORG.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24)}`,
    });
    const res = await app.inject({
      method: 'POST', url: '/api/policies',
      headers: { cookie: COOKIE, 'content-type': 'application/json' },
      payload: { policy: { type: 'min_cost', qualityFloor: 0.9 }, rebindKeys: true },
    });
    expect(res.statusCode, res.body).toBe(201);
    const labKey = await getApiKeyById(h.db, ORG, 'key-labrun-run-x-abc');
    expect(labKey!.policyId!.startsWith('pol-lab-io-')).toBe(true); // untouched
    const keys = await listApiKeys(h.db, ORG);
    const mine = keys.find((k) => k.name === 'first key')!;
    expect(mine.policyId!.startsWith('pol-lab-')).toBe(false); // rebound to the new customer policy
  });

  it('the boot repair rebinds a damaged customer key and mints the default when needed', async () => {
    const ORG2 = 'org_internal_pol_2';
    await createOrg(h.db, { id: ORG2, name: 'Damaged Org' });
    await insertPolicy(h.db, { id: 'pol-lab-io-damaged', orgId: ORG2, name: 'lab-io', config: { type: 'min_cost', qualityFloor: 0 } });
    await insertApiKey(h.db, { id: 'key-cust-1', keyHash: sha256('pk_cust_1'), name: 'production', orgId: ORG2, policyId: 'pol-lab-io-damaged' });
    const repaired = await repairInternalPolicyBindings(h.db, DEFAULT_ORG_POLICY);
    const mine = repaired.filter((r) => r.orgId === ORG2);
    expect(mine).toHaveLength(1);
    const key = await getApiKeyById(h.db, ORG2, 'key-cust-1');
    expect(key!.policyId!.startsWith('pol-lab-')).toBe(false);
    // Idempotent: a second pass repairs nothing.
    const again = await repairInternalPolicyBindings(h.db, DEFAULT_ORG_POLICY);
    expect(again.filter((r) => r.orgId === ORG2)).toHaveLength(0);
  });
});
