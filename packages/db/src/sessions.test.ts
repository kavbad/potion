// Sessions + magic-links repo tests (M2 Wave 2, ROADMAP #14) — PGlite, zero
// services. Covers: live-session lookup (unexpired + unrevoked), revoke,
// single-use + expiry on magic links (atomic consume), purgeExpired, and
// migration 0004 idempotency.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ORG_ID,
  consumeMagicLink,
  createDb,
  createMagicLink,
  createMembership,
  createSession,
  createUser,
  findSessionByTokenHash,
  getMagicLinkByTokenHash,
  migrate,
  purgeExpired,
  revokeSession,
  type DbHandle,
} from './index.js';

const HOUR = 60 * 60 * 1000;

async function migratedDb(): Promise<DbHandle> {
  const handle = await createDb(); // PGlite: zero services
  await migrate(handle.db);
  await createUser(handle.db, { id: 'usr_s', email: 's@auth.dev', name: 'S' });
  await createMembership(handle.db, { orgId: DEFAULT_ORG_ID, userId: 'usr_s', role: 'member' });
  return handle;
}

function sessionRow(over: Partial<Parameters<typeof createSession>[1]> = {}) {
  return {
    id: 'ses-1',
    userId: 'usr_s',
    tokenHash: 'hash-live',
    orgId: DEFAULT_ORG_ID,
    expiresAt: new Date(Date.now() + HOUR),
    ...over,
  };
}

describe('sessions repo (migration 0004)', () => {
  it('migration 0004 is applied and idempotent', async () => {
    const handle = await createDb();
    try {
      const applied = await migrate(handle.db);
      expect(applied).toContain('0004_auth.sql');
      await expect(migrate(handle.db)).resolves.toContain('0004_auth.sql');
    } finally {
      await handle.close();
    }
  });

  it('findSessionByTokenHash returns only LIVE sessions (unexpired, unrevoked)', async () => {
    const handle = await migratedDb();
    try {
      await createSession(handle.db, sessionRow());
      expect((await findSessionByTokenHash(handle.db, 'hash-live'))?.id).toBe('ses-1');
      expect(await findSessionByTokenHash(handle.db, 'nope')).toBeNull();

      // expired → invisible
      await createSession(
        handle.db,
        sessionRow({ id: 'ses-2', tokenHash: 'hash-exp', expiresAt: new Date(Date.now() - 1000) }),
      );
      expect(await findSessionByTokenHash(handle.db, 'hash-exp')).toBeNull();

      // revoked → invisible; revoke is idempotent (first revoked_at kept)
      const revoked = await revokeSession(handle.db, 'ses-1');
      expect(revoked?.revokedAt).not.toBeNull();
      expect(await findSessionByTokenHash(handle.db, 'hash-live')).toBeNull();
      expect(await revokeSession(handle.db, 'ses-1')).not.toBeNull();
      expect(await revokeSession(handle.db, 'ses-unknown')).toBeNull();
    } finally {
      await handle.close();
    }
  });

  it('consumeMagicLink is single-use and enforces expiry', async () => {
    const handle = await migratedDb();
    try {
      await createMagicLink(handle.db, {
        tokenHash: 'ml-live',
        email: 's@auth.dev',
        orgId: DEFAULT_ORG_ID,
        expiresAt: new Date(Date.now() + HOUR),
      });
      // first consume wins and stamps consumed_at
      const first = await consumeMagicLink(handle.db, 'ml-live');
      expect(first?.email).toBe('s@auth.dev');
      expect(first?.consumedAt).not.toBeNull();
      // second consume loses (single-use)
      expect(await consumeMagicLink(handle.db, 'ml-live')).toBeNull();
      expect((await getMagicLinkByTokenHash(handle.db, 'ml-live'))?.consumedAt).not.toBeNull();

      // expired links cannot be consumed
      await createMagicLink(handle.db, {
        tokenHash: 'ml-exp',
        email: 's@auth.dev',
        orgId: DEFAULT_ORG_ID,
        expiresAt: new Date(Date.now() - 1000),
      });
      expect(await consumeMagicLink(handle.db, 'ml-exp')).toBeNull();
      expect((await getMagicLinkByTokenHash(handle.db, 'ml-exp'))?.consumedAt).toBeNull();
    } finally {
      await handle.close();
    }
  });

  it('purgeExpired deletes dead sessions + links, keeps live rows', async () => {
    const handle = await migratedDb();
    try {
      await createSession(handle.db, sessionRow());
      await createSession(
        handle.db,
        sessionRow({ id: 'ses-2', tokenHash: 'hash-exp', expiresAt: new Date(Date.now() - 1000) }),
      );
      await revokeSession(handle.db, 'ses-1'); // revoked but unexpired → purged too
      await createMagicLink(handle.db, {
        tokenHash: 'ml-live',
        email: 's@auth.dev',
        orgId: DEFAULT_ORG_ID,
        expiresAt: new Date(Date.now() + HOUR),
      });
      await createMagicLink(handle.db, {
        tokenHash: 'ml-dead',
        email: 's@auth.dev',
        orgId: DEFAULT_ORG_ID,
        expiresAt: new Date(Date.now() - 1000),
      });

      const purged = await purgeExpired(handle.db);
      expect(purged).toEqual({ sessions: 2, magicLinks: 1 });
      expect(await getMagicLinkByTokenHash(handle.db, 'ml-live')).not.toBeNull();
      // second run is a no-op
      expect(await purgeExpired(handle.db)).toEqual({ sessions: 0, magicLinks: 0 });
    } finally {
      await handle.close();
    }
  });
});
