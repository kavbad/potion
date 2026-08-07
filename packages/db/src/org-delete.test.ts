// deleteOrgCascade unit tests (G2.7) — refusal, idempotency, identity
// semantics, silent-orphan tables. The full nothing-survives pipeline e2e
// lives in packages/workers/src/org-delete.test.ts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  budgetEvents,
  clusters,
  createDb,
  createMembership,
  createOrg,
  createSession,
  createUser,
  deleteOrgCascade,
  memberships,
  migrate,
  sessions,
  users,
  DEFAULT_ORG_ID,
  type DbHandle,
} from './index.js';
import { sha256 } from '@potion/core';

let handle: DbHandle;
const db = () => handle.db;

beforeEach(async () => {
  handle = await createDb();
  await migrate(handle.db);
});

afterEach(async () => {
  await handle.close();
});

describe('deleteOrgCascade', () => {
  it('refuses org_demo with the reasons; unknown org is an idempotent no-op', async () => {
    await expect(deleteOrgCascade(db(), DEFAULT_ORG_ID)).rejects.toThrow(/refusing to delete/);
    const report = await deleteOrgCascade(db(), 'org_never_existed');
    expect(report.alreadyDeleted).toBe(true);
    expect(report.usersErased).toBe(0);
  });

  it('erases solo users, keeps multi-org users + their other-org sessions; silent-orphan tables reached', async () => {
    await createOrg(db(), { id: 'org_del_a', name: 'A' });
    await createOrg(db(), { id: 'org_del_b', name: 'B' });
    // solo user: only in A
    await createUser(db(), { id: 'u_solo', email: 'solo@x.dev', name: 'solo' });
    await createMembership(db(), { orgId: 'org_del_a', userId: 'u_solo', role: 'admin' });
    await createSession(db(), {
      id: 's_solo',
      userId: 'u_solo',
      tokenHash: sha256('t_solo'),
      orgId: 'org_del_a',
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    // multi-org user: A and B, sessions in both
    await createUser(db(), { id: 'u_multi', email: 'multi@x.dev', name: 'multi' });
    await createMembership(db(), { orgId: 'org_del_a', userId: 'u_multi', role: 'member' });
    await createMembership(db(), { orgId: 'org_del_b', userId: 'u_multi', role: 'admin' });
    await createSession(db(), {
      id: 's_multi_a',
      userId: 'u_multi',
      tokenHash: sha256('t_multi_a'),
      orgId: 'org_del_a',
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    await createSession(db(), {
      id: 's_multi_b',
      userId: 'u_multi',
      tokenHash: sha256('t_multi_b'),
      orgId: 'org_del_b',
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    // silent-orphan seeds: bare-text org columns nothing would block on
    await db().insert(budgetEvents).values({ orgId: 'org_del_a', kind: 'budget_warning', day: '2026-08-07' });
    await db().insert(clusters).values({ id: 'agent-orgdel-x', name: 'a', description: 'd', orgId: 'org_del_a' });
    // platform cluster must survive
    await db().insert(clusters).values({ id: 'platform-cluster-x', name: 'p', description: 'd' });

    const report = await deleteOrgCascade(db(), 'org_del_a');
    expect(report.alreadyDeleted).toBe(false);
    expect(report.usersErased).toBe(1); // u_solo only
    expect(report.deleted.budget_events).toBe(1);
    expect(report.deleted.clusters).toBe(1);
    expect(report.deleted.orgs).toBe(1);

    // identity semantics
    expect(await db().select().from(users).where(eq(users.id, 'u_solo'))).toHaveLength(0);
    expect(await db().select().from(users).where(eq(users.id, 'u_multi'))).toHaveLength(1);
    expect(await db().select().from(sessions).where(eq(sessions.id, 's_multi_b'))).toHaveLength(1);
    expect(await db().select().from(memberships).where(eq(memberships.orgId, 'org_del_b'))).toHaveLength(1);
    // platform cluster untouched
    expect(await db().select().from(clusters).where(eq(clusters.id, 'platform-cluster-x'))).toHaveLength(1);

    // idempotent re-run
    const again = await deleteOrgCascade(db(), 'org_del_a');
    expect(again.alreadyDeleted).toBe(true);
  });
});
