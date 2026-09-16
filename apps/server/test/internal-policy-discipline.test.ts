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

// THE OLDEST RULE IS NOT THE CURRENT RULE (2026-09-16). Found live on the
// production smoke test: a key minted that day bound to the org's OLDEST
// serving policy — an August row with an unrounded floor of 0.978543771043771
// that no classification point can clear — while the org's six other keys
// were all on the September "your bar" at 0.84. Every request on the new key
// served the platform fallback (fallback=1). The mint took `existing[0]` of a
// createdAt-ascending list, i.e. whichever rule the org wrote FIRST. The
// org's rule is the one its keys are on — the policy anchor — or, with no
// keys yet, the newest rule it wrote.
describe("a minted key binds the org's CURRENT rule, not its oldest", () => {
  const ORG2 = 'org_current_rule';
  const COOKIE2 = 'potion_session=ps_current_rule';
  const ORG3 = 'org_current_rule_nokeys';
  const COOKIE3 = 'potion_session=ps_current_rule_nokeys';
  beforeAll(async () => {
    for (const [org, user, ses, tok] of [
      [ORG2, 'usr_cr', 'ses_cr', 'ps_current_rule'],
      [ORG3, 'usr_cr3', 'ses_cr3', 'ps_current_rule_nokeys'],
    ] as const) {
      await createOrg(h.db, { id: org, name: org });
      await createUser(h.db, { id: user, email: `${user}@x.dev`, name: user });
      await createMembership(h.db, { orgId: org, userId: user, role: 'admin' });
      await createSession(h.db, {
        id: ses, userId: user, tokenHash: sha256(tok), orgId: org,
        expiresAt: new Date(Date.now() + 3600_000),
      });
      // Written FIRST: the August trap, verbatim.
      await insertPolicy(h.db, {
        id: `pol-old-${org}`, orgId: org, name: 'min_cost-old',
        config: { type: 'min_cost', qualityFloor: 0.978543771043771 },
        createdAt: new Date('2026-08-22T07:00:02.033Z'),
      });
      // Written LATER: the rule the org actually chose.
      await insertPolicy(h.db, {
        id: `pol-current-${org}`, orgId: org, name: 'your bar · 1 kind of work',
        config: { type: 'min_cost', qualityFloor: 0.84 },
        createdAt: new Date('2026-09-11T19:27:11.189Z'),
      });
    }
    // ORG2 has a key on the current rule (the anchor); ORG3 has no keys at all.
    await insertApiKey(h.db, {
      id: 'key-cr-anchor', keyHash: sha256('pk_cr_anchor'), name: 'serving-2026-08-22',
      orgId: ORG2, policyId: `pol-current-${ORG2}`,
    });
  });

  it('with keys: the new key joins the rule the existing keys are on', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/api-keys',
      headers: { cookie: COOKIE2, 'content-type': 'application/json' },
      payload: { name: 'serving-2026-09-16' },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect((JSON.parse(res.body) as { policyId: string }).policyId).toBe(`pol-current-${ORG2}`);
  });

  it('with no keys yet: the new key takes the NEWEST rule, not the first one written', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/api-keys',
      headers: { cookie: COOKIE3, 'content-type': 'application/json' },
      payload: { name: 'first key' },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect((JSON.parse(res.body) as { policyId: string }).policyId).toBe(`pol-current-${ORG3}`);
  });
});
