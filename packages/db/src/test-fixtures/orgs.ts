// THE isolation-org fixture — one definition, used by every cross-tenant test
// in the monorepo (G2.4 carryover, made structural).
//
// THE RULE: a cross-tenant / isolation test uses TWO DISTINCT NON-DEFAULT
// orgs. DEFAULT_ORG_ID ('org_demo') is NEVER the probed subject.
//
// WHY, concretely: every pre-G2.4 isolation suite set ORG_A = DEFAULT_ORG_ID,
// and that single assumption hid tenancy defect D1 for the entire life of the
// suite — a bearer-only resolver that fell back to the demo org LOOKS correct
// when the org under test IS the demo org. The demo org is also the dev-auth
// bypass target, the pre-auth log-attribution target, and a migration-seeded
// row that exists for free without any test setup, so a probe against it can
// pass for reasons that have nothing to do with tenancy.
//
// This module lives in @potion/db (the lowest package that isolation tests in
// BOTH packages/db and apps/server can import) so there is exactly one
// definition of the constants. apps/server/test/fixtures/orgs.ts re-exports it.
//
// Enforced by apps/server/test/isolation-fixture.test.ts.
import { DEFAULT_ORG_ID } from '../schema.js';
import { createOrg } from '../repos/orgs.js';
import type { PotionDb } from '../db.js';

/** The primary subject org — the tenant whose resources are protected. */
export const ORG_A = 'org_fixture_a';
/** The adversary org — the tenant that probes org A's resources. */
export const ORG_B = 'org_fixture_b';

export const ORG_A_NAME = 'Fixture Org A';
export const ORG_B_NAME = 'Fixture Org B';

/**
 * A THIRD org for suites that also want to probe the demo tenant. The demo
 * org is legitimately a tenant, so attacking it is a fine ADDITIONAL arm —
 * it just must never occupy the subject slot, where its specialness masks
 * failures (see the header).
 */
export const ORG_DEMO_AS_PEER = DEFAULT_ORG_ID;

/**
 * Create the two isolation orgs. Idempotent-ish: callers run it once in
 * beforeAll against a fresh db. Note that unlike the demo org (seeded by
 * migration 0003), these orgs do NOT exist for free — which is the point:
 * an isolation test must construct its own tenants.
 */
export async function seedIsolationOrgs(db: PotionDb): Promise<void> {
  await createOrg(db, { id: ORG_A, name: ORG_A_NAME });
  await createOrg(db, { id: ORG_B, name: ORG_B_NAME });
}

/**
 * Runtime guard for suites that construct org ids dynamically. The static
 * rule is enforced by the meta-test; this is the belt for the braces.
 */
export function assertNonDefaultSubject(...orgIds: string[]): void {
  for (const id of orgIds) {
    if (id === DEFAULT_ORG_ID) {
      throw new Error(
        `isolation fixture violation: '${id}' is the DEFAULT org and must not be an isolation ` +
          "test's subject — import ORG_A/ORG_B from @potion/db test-fixtures (see the header " +
          'for why the demo org masks tenancy failures)',
      );
    }
  }
  if (new Set(orgIds).size !== orgIds.length) {
    throw new Error('isolation fixture violation: the subject orgs must be DISTINCT');
  }
}
