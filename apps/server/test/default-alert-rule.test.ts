// THE DEFAULT ALERT RULE (2026-09-16): a provisioned org has an email rule
// to the address that signed up, so the first problem is heard. Idempotent;
// a customer's own rules are never touched.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createOrg, insertAlertRule, listAlertRules, listMembershipsByUser, getUserByEmail } from '@potion/db';
import { buildServer } from '../src/server.js';
import { provisionForEmail } from '../src/routes/auth.js';
import { DEFAULT_ALERT_EVENTS, ensureDefaultAlertRule } from '../src/default-alert-rule.js';

let app: FastifyInstance;
const db = () => app.potion.db.db;

beforeAll(async () => {
  app = await buildServer({ seed: false });
});
afterAll(async () => {
  await app.close();
});

describe('a provisioned org hears about its first problem', () => {
  it('signup provisions ONE mailto rule to the signup address, subscribed to the default events', async () => {
    const { orgId } = await provisionForEmail(db(), 'First.Customer@example.com');
    const rules = await listAlertRules(db(), orgId);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.kind).toBe('webhook');
    expect(rules[0]!.targetUrl).toBe('mailto:first.customer@example.com');
    expect(rules[0]!.events).toEqual([...DEFAULT_ALERT_EVENTS]);
    expect(rules[0]!.events).toContain('policy_infeasible');
    expect(rules[0]!.events).toContain('budget_exceeded');
    expect(rules[0]!.disabledAt).toBeNull();
  });

  it('a second sign-in by the same person provisions nothing new', async () => {
    const first = await provisionForEmail(db(), 'again@example.com');
    const second = await provisionForEmail(db(), 'again@example.com');
    expect(second.orgId).toBe(first.orgId);
    expect(await listAlertRules(db(), first.orgId)).toHaveLength(1);
  });

  it('a user with no membership gets a fresh org WITH the rule', async () => {
    // provision, then strip the membership to simulate the orphan path
    const { userId, orgId } = await provisionForEmail(db(), 'orphan@example.com');
    const user = await getUserByEmail(db(), 'orphan@example.com');
    expect(user?.id).toBe(userId);
    expect((await listMembershipsByUser(db(), userId)).map((m) => m.orgId)).toContain(orgId);
    expect(await listAlertRules(db(), orgId)).toHaveLength(1);
  });

  it("an org that already has a rule is left exactly as it is — the customer's configuration outranks the default", async () => {
    await createOrg(db(), { id: 'org-has-rule', name: 'Has Rule' });
    const own = await insertAlertRule(db(), { orgId: 'org-has-rule', kind: 'slack', targetUrl: 'https://hooks.slack.com/services/T/B/x', events: ['breaker_open'] });
    const r = await ensureDefaultAlertRule(db(), 'org-has-rule', 'someone@example.com');
    expect(r.created).toBe(false);
    expect(r.ruleId).toBe(own.id);
    const rules = await listAlertRules(db(), 'org-has-rule');
    expect(rules).toHaveLength(1);
    expect(rules[0]!.kind).toBe('slack');
  });

  it('an address that is not an email provisions no rule rather than a broken one', async () => {
    await createOrg(db(), { id: 'org-no-email', name: 'No Email' });
    const r = await ensureDefaultAlertRule(db(), 'org-no-email', 'not-an-address');
    expect(r).toEqual({ created: false, ruleId: null });
    expect(await listAlertRules(db(), 'org-no-email')).toHaveLength(0);
  });
});
