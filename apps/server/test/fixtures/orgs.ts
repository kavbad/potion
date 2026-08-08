// Server-side re-export of THE isolation-org fixture. The constants are
// defined once in @potion/db (the lowest package both test trees can import)
// — see that module's header for the rule and why it exists.
//
// Import ORG_A / ORG_B from here (or from @potion/db) in any cross-tenant
// test; apps/server/test/isolation-fixture.test.ts enforces it.
export {
  ORG_A,
  ORG_B,
  ORG_A_NAME,
  ORG_B_NAME,
  ORG_DEMO_AS_PEER,
  seedIsolationOrgs,
  assertNonDefaultSubject,
} from '@potion/db';
