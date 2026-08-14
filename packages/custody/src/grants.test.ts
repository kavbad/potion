// openGrantToken — the single grant decrypt path (Step 10). Proves:
//   · seal → store → open round-trips both tokens through a real db
//   · wrong master key fails typed (CustodyDecryptError), never garbage
//   · the TYPED status rides along (revoked grants still open — the
//     RUNTIME decides what a cut means; custody never silently hides it)
//   · sealRefreshedToken drops the fresh token when revocation won the race
//   · the sealed row on disk never carries plaintext (at-rest canary)
import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  createDb,
  migrate,
  seedIsolationOrgs,
  markLabGrantStatus,
  upsertLabGrant,
  ORG_A,
  ORG_B,
  type DbHandle,
} from '@potion/db';
import { CustodyDecryptError, openEnvelope, sealEnvelope } from './envelope.js';
import { openGrantToken, sealRefreshedToken } from './grants.js';

const MASTER = randomBytes(32);
const WRONG_MASTER = randomBytes(32);
const ACCESS = 'gho_GRANTCANARY9f3d1c7b2e48a6f05d1c9b7e3a';
const REFRESH = 'ghr_REFRESHCANARY18c2f4a6e8b0d2f4a6c8e0b2';

async function seeded(): Promise<DbHandle> {
  const h = await createDb();
  await migrate(h.db);
  await seedIsolationOrgs(h.db);
  await upsertLabGrant(h.db, {
    id: 'grant-custody-1',
    orgId: ORG_A,
    connectorId: 'github',
    superpowerId: 'github',
    scopesGranted: ['repo:read'],
    tokenEnvelope: sealEnvelope(MASTER, ACCESS),
    refreshEnvelope: sealEnvelope(MASTER, REFRESH),
    tokenExpiresAt: new Date('2026-08-14T00:00:00Z'),
    grantedBy: 'usr_admin',
  });
  return h;
}

describe('openGrantToken', () => {
  it('round-trips both tokens, org-scoped, with typed status attached', async () => {
    const h = await seeded();
    try {
      const grant = (await openGrantToken(h.db, MASTER, ORG_A, 'github'))!;
      expect(grant.accessToken).toBe(ACCESS);
      expect(grant.refreshToken).toBe(REFRESH);
      expect(grant.status).toBe('active');
      expect(grant.scopesGranted).toEqual(['repo:read']);
      expect(await openGrantToken(h.db, MASTER, ORG_B, 'github')).toBeNull();
      expect(await openGrantToken(h.db, MASTER, ORG_A, 'linear')).toBeNull();
    } finally {
      await h.close();
    }
  });

  it('fails typed under the wrong master key — no garbage-plaintext path', async () => {
    const h = await seeded();
    try {
      await expect(openGrantToken(h.db, WRONG_MASTER, ORG_A, 'github')).rejects.toThrow(
        CustodyDecryptError,
      );
    } finally {
      await h.close();
    }
  });

  it('a revoked grant still opens WITH status revoked — the runtime types the cut, custody never hides it', async () => {
    const h = await seeded();
    try {
      await markLabGrantStatus(h.db, ORG_A, 'github', 'revoked');
      const grant = (await openGrantToken(h.db, MASTER, ORG_A, 'github'))!;
      expect(grant.status).toBe('revoked');
    } finally {
      await h.close();
    }
  });

  it('sealRefreshedToken reseals an active grant; revocation racing the refresh wins', async () => {
    const h = await seeded();
    try {
      expect(await sealRefreshedToken(h.db, MASTER, ORG_A, 'github', 'gho_ROTATED1234567890abcd', null)).toBe(true);
      expect((await openGrantToken(h.db, MASTER, ORG_A, 'github'))!.accessToken).toBe(
        'gho_ROTATED1234567890abcd',
      );
      await markLabGrantStatus(h.db, ORG_A, 'github', 'revoked');
      expect(await sealRefreshedToken(h.db, MASTER, ORG_A, 'github', 'gho_DROPPED1234567890abcd', null)).toBe(false);
      expect((await openGrantToken(h.db, MASTER, ORG_A, 'github'))!.accessToken).toBe(
        'gho_ROTATED1234567890abcd',
      );
    } finally {
      await h.close();
    }
  });

  it('master-key rotation re-wraps grant rows: new master opens both tokens, old fails', async () => {
    const h = await seeded();
    try {
      const { CustodyService, StaticMasterKeyProvider } = await import('./service.js').then(
        async (m) => ({ ...m, ...(await import('./master.js')) }),
      );
      const custody = new CustodyService({
        db: h.db,
        master: new StaticMasterKeyProvider(MASTER.toString('hex')),
      });
      const rotated = await custody.rotateMasterKey(
        MASTER.toString('hex'),
        WRONG_MASTER.toString('hex'),
        'system:master-rotation',
      );
      expect(rotated).toBe(1); // the one grant row (no provider keys seeded)
      const underNew = (await openGrantToken(h.db, WRONG_MASTER, ORG_A, 'github'))!;
      expect(underNew.accessToken).toBe(ACCESS);
      expect(underNew.refreshToken).toBe(REFRESH);
      await expect(openGrantToken(h.db, MASTER, ORG_A, 'github')).rejects.toThrow(
        CustodyDecryptError,
      );
    } finally {
      await h.close();
    }
  });

  it('the envelope column itself never carries token plaintext', () => {
    const envelope = sealEnvelope(MASTER, ACCESS);
    expect(envelope).not.toContain('GRANTCANARY');
    expect(openEnvelope(MASTER, envelope)).toBe(ACCESS);
  });
});
