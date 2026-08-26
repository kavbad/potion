// L-G3 route tests: the ledger over HTTP. Role gates (viewer reads, only
// admins evaluate/accept), the evaluate→propose→accept flow end-to-end,
// and the never-graduates refusal surfacing as a typed 409.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256 } from '@potion/core';
import {
  createDb,
  createLabRun,
  createMembership,
  createOrg,
  createSession,
  createUser,
  ensureActionGrant,
  labRunSteps,
  migrate,
  upsertLabHarness,
  type DbHandle,
} from '@potion/db';
import { buildServer } from '../src/server.js';

const ORG = 'org_lab_grants_rt';
const HASH = 'cd'.repeat(32);
const ADMIN_COOKIE = 'potion_session=ps_lag_admin';
const VIEWER_COOKIE = 'potion_session=ps_lag_viewer';

let h: DbHandle;
let app: FastifyInstance;
let devAuthBefore: string | undefined;
let seq = 0;

async function pore(toolName: string, argsHash: string, answer: string) {
  const at = new Date(Date.now() - 3 * 86_400_000);
  seq += 1;
  await h.db.insert(labRunSteps).values({
    runId: 'run-lag', orgId: ORG, seq, kind: 'check-in',
    payload: { kind: 'check-in', checkInTrigger: 'before-external-action', checkInAction: { toolName, argsHash, arguments: '{}' }, clockMs: 0, rngSample: 0 },
    createdAt: at,
  });
  seq += 1;
  await h.db.insert(labRunSteps).values({
    runId: 'run-lag', orgId: ORG, seq, kind: 'model',
    payload: { kind: 'model', checkInAnswer: answer, clockMs: 0, rngSample: 0 },
    createdAt: at,
  });
}

beforeAll(async () => {
  devAuthBefore = process.env.POTION_DEV_AUTH;
  process.env.POTION_DEV_AUTH = '0';
  h = await createDb();
  await migrate(h.db);
  await createOrg(h.db, { id: ORG, name: 'Lab Grants RT' });
  await createUser(h.db, { id: 'usr_lag_a', email: 'a@lag.dev', name: 'a' });
  await createUser(h.db, { id: 'usr_lag_v', email: 'v@lag.dev', name: 'v' });
  await createMembership(h.db, { orgId: ORG, userId: 'usr_lag_a', role: 'admin' });
  await createMembership(h.db, { orgId: ORG, userId: 'usr_lag_v', role: 'viewer' });
  const exp = new Date(Date.now() + 3600_000);
  await createSession(h.db, { id: 'ses_lag_a', userId: 'usr_lag_a', tokenHash: sha256('ps_lag_admin'), orgId: ORG, expiresAt: exp });
  await createSession(h.db, { id: 'ses_lag_v', userId: 'usr_lag_v', tokenHash: sha256('ps_lag_viewer'), orgId: ORG, expiresAt: exp });
  const spec = {
    specVersion: 1, name: 'lag harness', brain: { policy: { type: 'max_quality', costCeilingPer1K: 1 } },
    mission: { kind: 'task', goal: 'g', doneDefinition: 'd' },
    superpowers: [], memory: { enabled: false }, rules: [],
    fuel: { maxUsdPerRun: 1, hardStop: true }, checkIns: [],
  };
  await upsertLabHarness(h.db, {
    orgId: ORG, harnessHash: HASH, name: 'lag harness', specText: JSON.stringify(spec),
    sidecar: { specHash: HASH, choicesHash: 'x', choices: [] }, clusterId: 'code-gen',
  });
  await createLabRun(h.db, { id: 'run-lag', orgId: ORG, harnessHash: HASH, harnessName: 'lag harness', spec });
  // 30 clean approvals on a read-class tool from the real catalog
  // ('get_file_contents' classifies as read) → clears reversible-read.
  for (let i = 0; i < 30; i++) await pore('get_file_contents', `h${i}`, 'yes');
  app = await buildServer({ db: h, seed: false });
}, 120_000);

afterAll(async () => {
  process.env.POTION_DEV_AUTH = devAuthBefore;
  await app.close();
});

describe('the permission ledger over HTTP', () => {
  it('viewer GET reads the ledger; evaluate is admin-only', async () => {
    const forbidden = await app.inject({ method: 'POST', url: `/api/lab/harnesses/${HASH}/grants/evaluate`, headers: { cookie: VIEWER_COOKIE } });
    expect(forbidden.statusCode).toBe(403);
    const res = await app.inject({ method: 'GET', url: `/api/lab/harnesses/${HASH}/grants`, headers: { cookie: VIEWER_COOKIE } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { grants: unknown[]; observedUngranted: Array<{ actionClass: string; evidence: { n: number } }> };
    // Before any evaluation: no grant rows, but the observed class shows.
    expect(body.observedUngranted.map((o) => o.actionClass)).toContain('get_file_contents');
    expect(body.observedUngranted[0]!.evidence.n).toBe(30);
  });

  it('admin evaluate proposes; accept grants with the audit floor; the ledger reflects it', async () => {
    const ev = await app.inject({ method: 'POST', url: `/api/lab/harnesses/${HASH}/grants/evaluate`, headers: { cookie: ADMIN_COOKIE } });
    expect(ev.statusCode).toBe(200);
    const pass = ev.json() as { proposals: Array<{ grantId: string; actionClass: string }>; tightened: unknown[] };
    expect(pass.proposals.map((p) => p.actionClass)).toEqual(['get_file_contents']);
    const acc = await app.inject({ method: 'POST', url: `/api/lab/grants/${pass.proposals[0]!.grantId}/accept`, headers: { cookie: ADMIN_COOKIE }, payload: {} });
    expect(acc.statusCode).toBe(200);
    expect((acc.json() as { state: string; auditRate: number }).state).toBe('autonomous');
    expect((acc.json() as { auditRate: number }).auditRate).toBe(0.05);
    const ledger = await app.inject({ method: 'GET', url: `/api/lab/harnesses/${HASH}/grants`, headers: { cookie: VIEWER_COOKIE } });
    const rows = (ledger.json() as { grants: Array<{ actionClass: string; state: string }> }).grants;
    expect(rows.find((g) => g.actionClass === 'get_file_contents')!.state).toBe('autonomous');
  });

  it('a never-graduates grant refuses accept with a typed 409', async () => {
    const g = await ensureActionGrant(h.db, { orgId: ORG, harnessHash: HASH, actionClass: 'payments:wire', riskTier: 'never-graduates' });
    const acc = await app.inject({ method: 'POST', url: `/api/lab/grants/${g.id}/accept`, headers: { cookie: ADMIN_COOKIE }, payload: {} });
    expect(acc.statusCode).toBe(409);
    expect((acc.json() as { error: { code: string } }).error.code).toBe('never_graduates');
  });
});
