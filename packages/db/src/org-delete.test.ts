// deleteOrgCascade unit tests (G2.7) — refusal, idempotency, identity
// semantics, silent-orphan tables. The full nothing-survives pipeline e2e
// lives in packages/workers/src/org-delete.test.ts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { upsertStrategyConfig } from './repos/shadow.js';
import { designateIncumbent } from './repos/cluster-incumbents.js';
import { insertGuaranteeVerdict } from './repos/verdicts.js';
import { insertSuiteCertificationTx } from './repos/suite-certifications.js';
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

// ─────────────────────────────────────────────────────────────────────────────
// STRUCTURAL COMPLETENESS (post-swarm). The cascade is a hand-maintained list,
// and three migrations landed org-scoped tables after G2.7 without touching it
// (cluster_incumbents 0025, guarantee_verdicts 0029, suite_certifications
// 0031). All three are `org_id NOT NULL REFERENCES orgs(id)`, so deleting any
// org that had ever designated an incumbent — every guarantee customer —
// aborted with an FK violation, while the "nothing derived survives" test
// above kept passing because its fixture never designates one.
//
// A hand-maintained list needs a structural check, not a bigger fixture: this
// derives the obligation from the SCHEMA, so migration N+1 fails the build
// rather than shipping the same hole (the route-inventory precedent).
// ─────────────────────────────────────────────────────────────────────────────
describe('deleteOrgCascade structural completeness', () => {
  it('every org_id-FK table in the schema is handled by the cascade', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const schemaSrc = readFileSync(fileURLToPath(new URL('./schema.ts', import.meta.url)), 'utf8');
    const cascadeSrc = readFileSync(
      fileURLToPath(new URL('./repos/org-delete.ts', import.meta.url)),
      'utf8',
    );

    // Every `export const X = pgTable('y'` (single- OR multi-line form).
    const decls = [...schemaSrc.matchAll(/export const (\w+) = pgTable\(\s*'([a-z_]+)'/g)].map(
      (m) => ({ varName: m[1]!, table: m[2]!, at: m.index! }),
    );
    expect(decls.length).toBeGreaterThan(30); // the parse actually found tables

    const orgScoped = decls.filter((d, i) => {
      const body = schemaSrc.slice(d.at, i + 1 < decls.length ? decls[i + 1]!.at : schemaSrc.length);
      return /orgId: text\('org_id'\)/.test(body) && body.includes('orgs.id');
    });

    // Tables the cascade DELIBERATELY does not delete, each with its reason.
    const exempt = new Map<string, string>([
      ['orgs', 'the org row itself — deleted in the tail transaction'],
      ['users', 'identity: erased only when orphaned (no memberships AND no sessions)'],
      ['eval_items', 'dead table: no reads or writes anywhere (documented in org-delete.ts)'],
    ]);

    const unhandled = orgScoped
      .filter((d) => !exempt.has(d.table))
      .filter((d) => !new RegExp(`\\b${d.varName}\\b`).test(cascadeSrc))
      .map((d) => d.table);

    expect(
      unhandled,
      `org_id-FK table(s) missing from deleteOrgCascade: ${unhandled.join(', ')}. ` +
        'Add a delete (or an entry to `exempt` with its reason) — a NOT NULL org FK ' +
        'left out of the cascade makes org deletion abort with an FK violation.',
    ).toEqual([]);
  });

  it('an org with the FULL guarantee trail deletes cleanly — the case the old fixture missed', async () => {
    await createOrg(db(), { id: 'org_del_g', name: 'Guarantee Org' });
    await db().insert(clusters).values({ id: 'agent-del-g', name: 'agent: x (del)', description: 'guarantee trail fixture', orgId: 'org_del_g' });
    await upsertStrategyConfig(db(), 'h'.repeat(64), { type: 'single', model: 'mock-cheap' });
    await designateIncumbent(db(), 'org_del_g', 'agent-del-g', 'h'.repeat(64));
    await insertGuaranteeVerdict(db(), {
      orgId: 'org_del_g',
      policyId: 'pol-del-g',
      clusterId: 'agent-del-g',
      candidateHash: 'c'.repeat(64),
      providerMode: 'mock',
      outcome: 'all-clear',
    });
    await insertSuiteCertificationTx(db(), {
      orgId: 'org_del_g',
      clusterId: 'agent-del-g',
      suiteId: 'agent-del-g-replays-v2',
      suiteVersion: '1.0.0',
      providerMode: 'mock',
      status: 'certified',
    });

    // Pre-fix this threw: FK violation on cluster_incumbents/guarantee_verdicts/
    // suite_certifications, leaving the org half-deleted.
    const report = await deleteOrgCascade(db(), 'org_del_g');
    expect(report.alreadyDeleted).toBe(false);
    expect(report.deleted.cluster_incumbents).toBe(1);
    expect(report.deleted.guarantee_verdicts).toBe(1);
    expect(report.deleted.suite_certifications).toBe(1);
    expect(await db().select().from(clusters).where(eq(clusters.id, 'agent-del-g'))).toHaveLength(0);
    expect(report.deleted.orgs).toBe(1);
  });
});
