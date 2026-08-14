// Lab Step 10: grants repo — the split-surface custody contract.
//   · The route-facing repo is STRUCTURALLY token-free (query-shape proof:
//     runtime key-set equality + no bare .select() in the source).
//   · Status transitions are typed; 'revoked' is terminal.
//   · A re-grant replaces; it never resurrects.
//   · grantConnectionStatus derives expiry LIVE from token_expires_at.
//   · Org-scoped like every lab table; erased by deleteOrgCascade.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createDb,
  deleteOrgCascade,
  migrate,
  seedIsolationOrgs,
  ORG_A,
  ORG_B,
  type DbHandle,
} from './index.js';
import {
  getLabGrant,
  grantConnectionStatus,
  listLabGrants,
  markLabGrantStatus,
  upsertLabGrant,
} from './repos/lab-grants.js';
import { readGrantEnvelopes, resealGrantToken } from './repos/lab-grants-runtime.js';

const ENVELOPE_FIXTURE = 'v1.ZmFrZS1lbnZlbG9wZS1mb3ItcmVwby10ZXN0cw'; // sealed elsewhere; opaque here

function grantInput(over: Partial<Parameters<typeof upsertLabGrant>[1]> = {}) {
  return {
    id: 'grant-1',
    orgId: ORG_A,
    connectorId: 'github',
    superpowerId: 'github',
    scopesGranted: ['repo:read'],
    tokenEnvelope: ENVELOPE_FIXTURE,
    grantedBy: 'usr_admin',
    ...over,
  };
}

async function setup(): Promise<DbHandle> {
  const h = await createDb();
  await migrate(h.db);
  await seedIsolationOrgs(h.db);
  return h;
}

describe('lab-grants — the route-facing surface is structurally token-free', () => {
  it('status reads return EXACTLY the status key set — no envelope key exists to leak', async () => {
    const h = await setup();
    try {
      await upsertLabGrant(h.db, grantInput());
      const listed = await listLabGrants(h.db, ORG_A);
      const got = await getLabGrant(h.db, ORG_A, 'github');
      const EXPECTED_KEYS = [
        'connectorId',
        'createdAt',
        'grantedBy',
        'id',
        'revokedAt',
        'scopesGranted',
        'status',
        'superpowerId',
        'tokenExpiresAt',
        'updatedAt',
      ];
      expect(Object.keys(listed[0]!).sort()).toEqual(EXPECTED_KEYS);
      expect(Object.keys(got!).sort()).toEqual(EXPECTED_KEYS);
      expect(JSON.stringify(listed) + JSON.stringify(got)).not.toContain(ENVELOPE_FIXTURE);
    } finally {
      await h.close();
    }
  });

  it('query-shape meta-test: lab-grants.ts has no bare .select() and never projects an envelope column', () => {
    const src = readFileSync(
      fileURLToPath(new URL('./repos/lab-grants.ts', import.meta.url)),
      'utf8',
    );
    // A bare .select() fetches the whole row — envelope columns included.
    expect(src).not.toMatch(/\.select\(\)/);
    // No SELECT projection references the envelope columns. (Writes may
    // CARRY them in .values()/.set() — inserting is not reading — so the
    // assertion targets column-object property ACCESS, which only appears
    // in projections and predicates.)
    expect(src).not.toMatch(/labSuperpowerGrants\.tokenEnvelope/);
    expect(src).not.toMatch(/labSuperpowerGrants\.refreshEnvelope/);
  });

  it('org scoping: org B sees neither the row nor its existence', async () => {
    const h = await setup();
    try {
      await upsertLabGrant(h.db, grantInput());
      expect(await getLabGrant(h.db, ORG_B, 'github')).toBeNull();
      expect(await listLabGrants(h.db, ORG_B)).toEqual([]);
    } finally {
      await h.close();
    }
  });
});

describe('lab-grants — typed status transitions', () => {
  it('active → expired → revoked; revoked is TERMINAL (never decays to expired)', async () => {
    const h = await setup();
    try {
      await upsertLabGrant(h.db, grantInput());
      expect(await markLabGrantStatus(h.db, ORG_A, 'github', 'expired')).toBe(true);
      expect((await getLabGrant(h.db, ORG_A, 'github'))!.status).toBe('expired');
      // expired grants can still be deliberately revoked (cut > hollow)
      expect(await markLabGrantStatus(h.db, ORG_A, 'github', 'revoked')).toBe(true);
      const revoked = (await getLabGrant(h.db, ORG_A, 'github'))!;
      expect(revoked.status).toBe('revoked');
      expect(revoked.revokedAt).not.toBeNull();
      // ...but a revoked grant never softens back to 'expired'
      expect(await markLabGrantStatus(h.db, ORG_A, 'github', 'expired')).toBe(false);
      expect((await getLabGrant(h.db, ORG_A, 'github'))!.status).toBe('revoked');
    } finally {
      await h.close();
    }
  });

  it('a re-grant REPLACES: fresh envelopes, active status, revoked_at cleared', async () => {
    const h = await setup();
    try {
      await upsertLabGrant(h.db, grantInput());
      await markLabGrantStatus(h.db, ORG_A, 'github', 'revoked');
      await upsertLabGrant(
        h.db,
        grantInput({ id: 'grant-2', tokenEnvelope: 'v1.c2Vjb25kLWdyYW50LWVudmVsb3Bl' }),
      );
      const row = (await getLabGrant(h.db, ORG_A, 'github'))!;
      expect(row.id).toBe('grant-2');
      expect(row.status).toBe('active');
      expect(row.revokedAt).toBeNull();
      const env = (await readGrantEnvelopes(h.db, ORG_A, 'github'))!;
      expect(env.tokenEnvelope).toBe('v1.c2Vjb25kLWdyYW50LWVudmVsb3Bl');
    } finally {
      await h.close();
    }
  });

  it('resealGrantToken updates ONLY an active grant — a revocation that raced the refresh wins', async () => {
    const h = await setup();
    try {
      await upsertLabGrant(h.db, grantInput());
      expect(await resealGrantToken(h.db, ORG_A, 'github', 'v1.cmVmcmVzaGVk', null)).toBe(true);
      expect((await readGrantEnvelopes(h.db, ORG_A, 'github'))!.tokenEnvelope).toBe('v1.cmVmcmVzaGVk');
      await markLabGrantStatus(h.db, ORG_A, 'github', 'revoked');
      expect(await resealGrantToken(h.db, ORG_A, 'github', 'v1.ZHJvcHBlZA', null)).toBe(false);
      expect((await readGrantEnvelopes(h.db, ORG_A, 'github'))!.tokenEnvelope).toBe('v1.cmVmcmVzaGVk');
    } finally {
      await h.close();
    }
  });
});

describe('grantConnectionStatus — the ONE derivation for every DTO', () => {
  const base = { status: 'active' as const, tokenExpiresAt: null };
  const now = new Date('2026-08-13T12:00:00Z');

  it('derives all four states, including LIVE expiry from token_expires_at', () => {
    expect(grantConnectionStatus(null, now)).toBe('not-connected');
    expect(grantConnectionStatus(base, now)).toBe('connected');
    expect(
      grantConnectionStatus({ ...base, tokenExpiresAt: new Date('2026-08-13T13:00:00Z') }, now),
    ).toBe('connected');
    // stored 'active' whose token aged out reads expired WITHOUT a write
    expect(
      grantConnectionStatus({ ...base, tokenExpiresAt: new Date('2026-08-13T11:59:59Z') }, now),
    ).toBe('expired');
    expect(grantConnectionStatus({ status: 'expired', tokenExpiresAt: null }, now)).toBe('expired');
    expect(grantConnectionStatus({ status: 'revoked', tokenExpiresAt: null }, now)).toBe('revoked');
  });
});

describe('lab-grants — erasure', () => {
  it('deleteOrgCascade erases the org grants; the peer org keeps its own', async () => {
    const h = await setup();
    try {
      await upsertLabGrant(h.db, grantInput());
      await upsertLabGrant(h.db, grantInput({ id: 'grant-b', orgId: ORG_B }));
      const report = await deleteOrgCascade(h.db, ORG_A);
      expect(report.deleted['lab_superpower_grants']).toBe(1);
      expect(await getLabGrant(h.db, ORG_A, 'github')).toBeNull();
      expect(await getLabGrant(h.db, ORG_B, 'github')).not.toBeNull();
    } finally {
      await h.close();
    }
  });
});
