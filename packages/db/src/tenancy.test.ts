// Tenancy tests (M2 Wave 1, ROADMAP #13): migration 0003 idempotency, the
// memberships role CHECK, org-scoped repo queries (isolation), FK/NOT NULL
// enforcement, and the resolveOrgContext contract Wave 2 builds on.
// Zero services: everything runs on PGlite.
import { sha256 } from '@potion/core';
import { describe, expect, it } from 'vitest';
import {
  apiKeys,
  createDb,
  createMembership,
  createOrg,
  createUser,
  DEFAULT_ORG_ID,
  getApiKeyById,
  getMembershipRole,
  getOrgById,
  getPolicyById,
  getProviderKeyByHash,
  getUserByEmail,
  insertApiKey,
  insertPolicy,
  insertProviderKey,
  insertRequestLog,
  listApiKeys,
  listMembershipsByOrg,
  listMembershipsByUser,
  listOrgs,
  listPolicies,
  listProviderKeys,
  listRequestLogs,
  migrate,
  orgContextForApiKey,
  parseApiKeyScopes,
  roleForApiKey,
  resolveOrgContext,
  type DbHandle,
} from './index.js';

async function migratedDb(): Promise<DbHandle> {
  const handle = await createDb(); // PGlite: zero services
  await migrate(handle.db);
  return handle;
}

/** Seed a second tenant (org_b) alongside the migration's default org. */
async function seedOrg(handle: DbHandle, orgId: string, name: string): Promise<void> {
  await createOrg(handle.db, { id: orgId, name });
}

describe('migration 0003_tenancy', () => {
  it('is idempotent and seeds the default org', async () => {
    const handle = await createDb();
    try {
      const applied = await migrate(handle.db);
      expect(applied).toContain('0003_tenancy.sql');
      // second + third runs must not throw (IF NOT EXISTS / guarded DO blocks)
      await expect(migrate(handle.db)).resolves.toContain('0003_tenancy.sql');
      await expect(migrate(handle.db)).resolves.toContain('0003_tenancy.sql');
      const org = await getOrgById(handle.db, DEFAULT_ORG_ID);
      expect(org).toMatchObject({ id: 'org_demo', name: 'Demo Org' });
    } finally {
      await handle.close();
    }
  });

  it('backfills pre-tenancy rows to the default org', async () => {
    const handle = await createDb();
    try {
      // Simulate a PRE-tenancy database: apply only 0000+0001+0002, insert a
      // key/policy/log, then apply 0003 (migrate() re-runs all files — but
      // the first three are no-ops and 0003 must backfill the rows).
      const { listMigrationFiles, splitStatements } = await import('./migrate.js');
      const { readFileSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      const dir = fileURLToPath(new URL('../drizzle', import.meta.url));
      const { sql } = await import('drizzle-orm');
      for (const file of listMigrationFiles().filter((f) => f < '0003')) {
        for (const stmt of splitStatements(readFileSync(`${dir}/${file}`, 'utf8'))) {
          await handle.db.execute(sql.raw(stmt));
        }
      }
      // org-less rows (as a pre-tenancy db would hold) — PGlite executes one
      // command per prepared statement, so issue them separately.
      for (const stmt of [
        `INSERT INTO policies (id, name, config) VALUES ('pol-old', 'old', '{"type":"max_quality","costCeilingPer1K":1}')`,
        `INSERT INTO api_keys (id, key_hash, name, policy_id) VALUES ('key-old', 'hash-old', 'old', 'pol-old')`,
        `INSERT INTO provider_keys (id, provider, name, masked_key, key_hash) VALUES ('pvk-old', 'openai', 'old', 'sk-…1234', 'ph-old')`,
        `INSERT INTO request_logs (status) VALUES ('ok')`,
      ]) {
        await handle.db.execute(sql.raw(stmt));
      }
      await migrate(handle.db); // full run: 0003 backfills
      const key = await getApiKeyById(handle.db, DEFAULT_ORG_ID, 'key-old');
      expect(key?.orgId).toBe(DEFAULT_ORG_ID);
      const pol = await getPolicyById(handle.db, DEFAULT_ORG_ID, 'pol-old');
      expect(pol?.orgId).toBe(DEFAULT_ORG_ID);
      const pvk = await getProviderKeyByHash(handle.db, DEFAULT_ORG_ID, 'ph-old');
      expect(pvk?.orgId).toBe(DEFAULT_ORG_ID);
      const logs = await listRequestLogs(handle.db, DEFAULT_ORG_ID);
      expect(logs).toHaveLength(1);
      expect(logs[0]?.orgId).toBe(DEFAULT_ORG_ID);
    } finally {
      await handle.close();
    }
  });
});

describe('tenancy schema constraints', () => {
  it('enforces the memberships role CHECK', async () => {
    const handle = await migratedDb();
    try {
      await createOrg(handle.db, { id: 'org_b', name: 'B' });
      await createUser(handle.db, { id: 'usr_b1', email: 'b1@x.dev', name: 'B One' });
      await expect(
        createMembership(handle.db, { orgId: 'org_b', userId: 'usr_b1', role: 'owner' as never }),
      ).rejects.toThrow();
      // valid roles work
      for (const [i, role] of (['admin', 'member', 'viewer'] as const).entries()) {
        await createUser(handle.db, { id: `usr_v${i}`, email: `v${i}@x.dev`, name: `V${i}` });
        await createMembership(handle.db, { orgId: 'org_b', userId: `usr_v${i}`, role });
      }
      expect(await getMembershipRole(handle.db, 'org_b', 'usr_v0')).toBe('admin');
      expect(await getMembershipRole(handle.db, 'org_b', 'usr_v1')).toBe('member');
      expect(await getMembershipRole(handle.db, 'org_b', 'usr_v2')).toBe('viewer');
    } finally {
      await handle.close();
    }
  });

  it('enforces org_id NOT NULL + FK on scoped tables', async () => {
    const handle = await migratedDb();
    try {
      // FK: unknown org is rejected
      await expect(
        insertApiKey(handle.db, {
          id: 'key-x',
          keyHash: 'h-x',
          name: 'x',
          orgId: 'org_nope',
          policyId: null,
        }),
      ).rejects.toThrow();
      // NOT NULL: org_id omitted is rejected
      await expect(
        handle.db.insert(apiKeys).values({ id: 'key-y', keyHash: 'h-y', name: 'y' } as never),
      ).rejects.toThrow();
    } finally {
      await handle.close();
    }
  });
});

describe('org-scoped repos (two-org isolation)', () => {
  it('keys/policies/provider-keys/logs are invisible across orgs', async () => {
    const handle = await migratedDb();
    try {
      const db = handle.db;
      await seedOrg(handle, 'org_b', 'Org B');

      // org_demo assets
      await insertPolicy(db, {
        id: 'pol-a',
        orgId: DEFAULT_ORG_ID,
        name: 'a',
        config: { type: 'max_quality', costCeilingPer1K: 1 },
      });
      await insertApiKey(db, {
        id: 'key-a',
        keyHash: sha256('pk_a'),
        name: 'a',
        orgId: DEFAULT_ORG_ID,
        policyId: 'pol-a',
      });
      await insertProviderKey(db, {
        id: 'pvk-a',
        orgId: DEFAULT_ORG_ID,
        provider: 'openai',
        name: 'a',
        maskedKey: 'sk-…aaaa',
        keyHash: 'hash-a',
      });
      await insertRequestLog(db, { orgId: DEFAULT_ORG_ID, status: 'ok', model: 'm-a' });

      // org_b assets — including the SAME raw provider key (per-org dedup)
      await insertPolicy(db, {
        id: 'pol-b',
        orgId: 'org_b',
        name: 'b',
        config: { type: 'min_cost', qualityFloor: 0.9 },
      });
      await insertApiKey(db, {
        id: 'key-b',
        keyHash: sha256('pk_b'),
        name: 'b',
        orgId: 'org_b',
        policyId: 'pol-b',
      });
      await insertProviderKey(db, {
        id: 'pvk-b',
        orgId: 'org_b',
        provider: 'openai',
        name: 'b',
        maskedKey: 'sk-…aaaa',
        keyHash: 'hash-a', // same raw key as org_demo's — allowed (per-org unique)
      });
      await insertRequestLog(db, { orgId: 'org_b', status: 'ok', model: 'm-b' });

      // reads are scoped
      expect((await listApiKeys(db, DEFAULT_ORG_ID)).map((k) => k.id)).toEqual(['key-a']);
      expect((await listApiKeys(db, 'org_b')).map((k) => k.id)).toEqual(['key-b']);
      expect(await getApiKeyById(db, DEFAULT_ORG_ID, 'key-b')).toBeNull(); // cross-org 404
      expect(await getApiKeyById(db, 'org_b', 'key-b')).not.toBeNull();
      expect((await listPolicies(db, DEFAULT_ORG_ID)).map((p) => p.id)).toEqual(['pol-a']);
      expect(await getPolicyById(db, DEFAULT_ORG_ID, 'pol-b')).toBeNull();
      expect((await listProviderKeys(db, 'org_b')).map((p) => p.id)).toEqual(['pvk-b']);
      expect(await getProviderKeyByHash(db, DEFAULT_ORG_ID, 'hash-a')).toMatchObject({ id: 'pvk-a' });
      expect(await getProviderKeyByHash(db, 'org_b', 'hash-a')).toMatchObject({ id: 'pvk-b' });
      expect((await listRequestLogs(db, DEFAULT_ORG_ID)).map((l) => l.model)).toEqual(['m-a']);
      expect((await listRequestLogs(db, 'org_b')).map((l) => l.model)).toEqual(['m-b']);
    } finally {
      await handle.close();
    }
  });
});

describe('orgs/users/memberships repos', () => {
  it('create/get/list orgs + users + memberships (idempotent create)', async () => {
    const handle = await migratedDb();
    try {
      const db = handle.db;
      await createOrg(db, { id: 'org_b', name: 'Org B' });
      await createOrg(db, { id: 'org_b', name: 'Org B' }); // no-op
      expect((await listOrgs(db)).map((o) => o.id)).toEqual([DEFAULT_ORG_ID, 'org_b']);

      await createUser(db, { id: 'usr_b1', email: 'b1@x.dev', name: 'B One' });
      await createUser(db, { id: 'usr_b1', email: 'b1@x.dev', name: 'B One' }); // no-op
      expect((await getUserByEmail(db, 'b1@x.dev'))?.id).toBe('usr_b1');

      await createMembership(db, { orgId: 'org_b', userId: 'usr_b1', role: 'member' });
      await createMembership(db, { orgId: 'org_b', userId: 'usr_b1', role: 'member' }); // no-op
      expect(await getMembershipRole(db, 'org_b', 'usr_b1')).toBe('member');
      expect(await getMembershipRole(db, 'org_b', 'usr_missing')).toBeNull();
      expect((await listMembershipsByOrg(db, 'org_b')).map((m) => m.userId)).toEqual(['usr_b1']);
      expect((await listMembershipsByUser(db, 'usr_b1')).map((m) => m.orgId)).toEqual(['org_b']);
    } finally {
      await handle.close();
    }
  });
});

describe('resolveOrgContext (Wave-2 contract)', () => {
  it('resolves an api key to its org (admin role, no userId)', async () => {
    const handle = await migratedDb();
    try {
      const db = handle.db;
      await insertApiKey(db, {
        id: 'key-a',
        keyHash: sha256('pk_a'),
        name: 'a',
        orgId: DEFAULT_ORG_ID,
        policyId: null,
      });
      const ctx = await resolveOrgContext(db, { kind: 'apiKey', apiKey: 'pk_a' });
      // G2.3 key role split: the default 'serve' scope resolves to MEMBER —
      // serving keys are no longer admin credentials.
      expect(ctx).toEqual({ orgId: DEFAULT_ORG_ID, role: 'member' });
      expect(await resolveOrgContext(db, { kind: 'apiKey', apiKey: 'pk_nope' })).toBeNull();
      // orgContextForApiKey matches (the hot-path variant used by auth)
      const key = await getApiKeyById(db, DEFAULT_ORG_ID, 'key-a');
      expect(orgContextForApiKey(key!)).toEqual(ctx);
      // roleForApiKey derivation pins (G2.3), incl. FAIL CLOSED: a
      // malformed/unrecognized scopes value must never mint admin.
      const withScopes = (scopes: string) => ({ ...key!, scopes });
      expect(roleForApiKey(withScopes('serve'))).toBe('member');
      expect(roleForApiKey(withScopes('serve+admin'))).toBe('admin');
      expect(roleForApiKey(withScopes('serve admin'))).toBe('admin'); // whitespace form
      expect(roleForApiKey(withScopes('admin'))).toBe('admin');
      for (const bad of ['', '   ', 'root', 'serve+admin+root', 'admin;drop', 'Admin', 'serve,admin']) {
        expect(roleForApiKey(withScopes(bad))).toBe('member');
      }
      expect(parseApiKeyScopes('serve+admin+root').valid).toBe(false);
    } finally {
      await handle.close();
    }
  });

  it('resolves a session (user identity) via memberships', async () => {
    const handle = await migratedDb();
    try {
      const db = handle.db;
      await createOrg(db, { id: 'org_b', name: 'Org B' });
      await createUser(db, { id: 'usr_b1', email: 'b1@x.dev', name: 'B One' });
      await createMembership(db, { orgId: 'org_b', userId: 'usr_b1', role: 'viewer' });
      // pinned org
      expect(await resolveOrgContext(db, { kind: 'session', userId: 'usr_b1', orgId: 'org_b' }))
        .toEqual({ orgId: 'org_b', userId: 'usr_b1', role: 'viewer' });
      // unpinned → first membership
      expect(await resolveOrgContext(db, { kind: 'session', userId: 'usr_b1' }))
        .toEqual({ orgId: 'org_b', userId: 'usr_b1', role: 'viewer' });
      // not a member / unknown user
      expect(
        await resolveOrgContext(db, { kind: 'session', userId: 'usr_b1', orgId: DEFAULT_ORG_ID }),
      ).toBeNull();
      expect(await resolveOrgContext(db, { kind: 'session', userId: 'usr_ghost' })).toBeNull();
    } finally {
      await handle.close();
    }
  });
});
