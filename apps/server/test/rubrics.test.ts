// Rubric review route tests (G1.5) — seeded PGlite server, in-process worker
// (real rubric:generate handler, mock provider mode), zero network.
//   · POST /api/rubrics/generate: admin gate, cluster ownership 404, 202+job
//   · GET /api/rubrics: viewer list — every row pairs the rubric text with
//     status + calibration evidence (owner rule); rejected rows stay listed
//   · POST /api/rubrics/:id/approve|/reject: admin gates, 404 cross-org,
//     409 non-pending, approve restamps the suite
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256 } from '@potion/core';
import {
  createMembership,
  createSession,
  createUser,
  insertApiKey,
  loadDerivedSuite,
} from '@potion/db';
import { orgHashOf, toolSignatureSlug } from '@potion/workers';
import { buildServer } from '../src/server.js';
// G2.4 carryover: the subject tenant is a real, distinct org from the shared
// fixture — never the demo org, whose dev-bypass/seeded specialness lets a
// tenancy failure pass for reasons that have nothing to do with tenancy.
import { ORG_A, ORG_B, seedIsolationOrgs } from './fixtures/orgs.js';

let app: FastifyInstance;

const ADMIN = { cookie: 'potion_session=ps_r_admin' };
const VIEWER = { cookie: 'potion_session=ps_r_viewer' };
const RAW_A = 'pk_rubrics_org_a';
const KEY = { authorization: `Bearer ${RAW_A}`, 'content-type': 'application/json' };

let clusterId: string;
let suiteId: string;

async function waitJob(jobId: string, timeoutMs = 120_000): Promise<{ state: string; error?: string; result?: unknown }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await app.inject({ method: 'GET', url: `/api/jobs/${jobId}`, headers: ADMIN });
    const body = res.json() as { state: string; error?: string; result?: unknown };
    if (body.state === 'completed' || body.state === 'failed') return body;
    if (Date.now() > deadline) throw new Error(`job ${jobId} did not settle in ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

beforeAll(async () => {
  app = await buildServer();
  const db = app.potion.db.db;
  await seedIsolationOrgs(db);
  await insertApiKey(db, { id: 'key-rubrics-a', keyHash: sha256(RAW_A), name: 'a', orgId: ORG_A });
  await createUser(db, { id: 'usr_r_admin', email: 'radmin@t.dev', name: 'admin' });
  await createMembership(db, { orgId: ORG_A, userId: 'usr_r_admin', role: 'admin' });
  await createSession(db, {
    id: 'ses_r_admin',
    userId: 'usr_r_admin',
    tokenHash: sha256('ps_r_admin'),
    orgId: ORG_A,
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  await createUser(db, { id: 'usr_r_viewer', email: 'rviewer@t.dev', name: 'viewer' });
  await createMembership(db, { orgId: ORG_A, userId: 'usr_r_viewer', role: 'viewer' });
  await createSession(db, {
    id: 'ses_r_viewer',
    userId: 'usr_r_viewer',
    tokenHash: sha256('ps_r_viewer'),
    orgId: ORG_A,
    expiresAt: new Date(Date.now() + 3_600_000),
  });

  // Seed 3 similar sessions WITH completions (references → probe-calibratable)
  // and cluster them into an agent-* cluster with a derived replay suite.
  const mk = (traceId: string, prompt: string, base: string) => ({
    spans: [
      { trace_id: traceId, span_id: `${base}_root`, name: 'agent.root', model: 'mock-cheap', attributes: { 'gen_ai.prompt': prompt } },
      {
        trace_id: traceId,
        span_id: `${base}_tool`,
        name: 'tool.search',
        model: 'mock-cheap',
        attributes: { 'gen_ai.operation.name': 'execute_tool', 'tool.args': 'invoices', 'tool.result': 'ok' },
      },
      {
        trace_id: traceId,
        span_id: `${base}_ans`,
        name: 'chat',
        model: 'mock-cheap',
        attributes: { 'gen_ai.completion': `Rebuilt the reconciliation report (${base}) end to end.` },
      },
    ],
  });
  // Prompts differ only in a LONG digit run → ingest redaction collapses
  // them to identical text → identical embeddings → one 3-member cluster.
  for (const [t, p, b] of [
    ['tr_r1', 'Rebuild the reconciliation report for account 10001001', 'r1'],
    ['tr_r2', 'Rebuild the reconciliation report for account 10001002', 'r2'],
    ['tr_r3', 'Rebuild the reconciliation report for account 10001003', 'r3'],
  ] as const) {
    await app.inject({ method: 'POST', url: '/v1/traces', headers: KEY, payload: mk(t, p, b) });
  }
  const trigger = await app.inject({
    method: 'POST',
    url: '/api/traces/cluster',
    headers: ADMIN,
    payload: { sinceDays: 30 },
  });
  expect(trigger.statusCode).toBe(202);
  const job = await waitJob((trigger.json() as { jobId: string }).jobId, 180_000);
  expect(job.state).toBe('completed');
  clusterId = `agent-${orgHashOf(ORG_A)}-${toolSignatureSlug(['search'])}`;
  suiteId = `${clusterId}-replays-v1`;
}, 240_000);

afterAll(async () => {
  await app.close();
});

describe('G1.5 rubric review surface', () => {
  it('generate → pending draft with calibration evidence; viewer sees text + status + verdict; approve restamps', async () => {
    // viewer cannot generate
    const noGen = await app.inject({ method: 'POST', url: '/api/rubrics/generate', headers: VIEWER, payload: { clusterId } });
    expect(noGen.statusCode).toBe(403);
    // unknown/foreign cluster → 404 (no oracle)
    const badCluster = await app.inject({ method: 'POST', url: '/api/rubrics/generate', headers: ADMIN, payload: { clusterId: 'agent-doesnotexist' } });
    expect(badCluster.statusCode).toBe(404);

    const gen = await app.inject({ method: 'POST', url: '/api/rubrics/generate', headers: ADMIN, payload: { clusterId } });
    expect(gen.statusCode).toBe(202);
    const job = await waitJob((gen.json() as { jobId: string }).jobId);
    expect(job.state).toBe('completed');
    const result = job.result as { rubricId: string; calibration: { flagged: boolean } | null; providerMode: string };
    expect(result.providerMode).toBe('mock');
    expect(result.calibration).not.toBeNull(); // 3 referenced items → probes ran

    // Viewer list: full text + status + evidence on EVERY row (owner rule).
    const list = await app.inject({ method: 'GET', url: '/api/rubrics', headers: VIEWER });
    expect(list.statusCode).toBe(200);
    const { rubrics } = list.json() as { rubrics: Array<Record<string, unknown>> };
    const draft = rubrics.find((r) => r.id === result.rubricId)!;
    expect(draft.status).toBe('pending');
    expect(draft.inForce).toBe(false); // a draft is NEVER the operative contract
    expect(String(draft.rubricText).length).toBeGreaterThan(50);
    expect(draft.providerMode).toBe('mock');
    const cal = draft.calibration as { flagged: boolean; n: number } | null;
    expect(cal).not.toBeNull();
    expect(cal!.n).toBe(9);

    // viewer cannot approve; admin approve restamps the suite homogeneous
    const noApprove = await app.inject({ method: 'POST', url: `/api/rubrics/${result.rubricId}/approve`, headers: VIEWER });
    expect(noApprove.statusCode).toBe(403);
    const approve = await app.inject({ method: 'POST', url: `/api/rubrics/${result.rubricId}/approve`, headers: ADMIN });
    expect(approve.statusCode).toBe(200);
    expect((approve.json() as { restampedItems: number }).restampedItems).toBeGreaterThanOrEqual(3);
    const loaded = (await loadDerivedSuite(app.potion.db.db, suiteId))!;
    const draftText = String(draft.rubricText);
    expect(
      loaded.items.every((it) => it.scoring.kind === 'llm-judge' && it.scoring.rubric === draftText),
    ).toBe(true);

    // in force now; double-approve → 409
    const list2 = await app.inject({ method: 'GET', url: '/api/rubrics', headers: VIEWER });
    const approved = (list2.json() as { rubrics: Array<Record<string, unknown>> }).rubrics.find((r) => r.id === result.rubricId)!;
    expect(approved.inForce).toBe(true);
    const again = await app.inject({ method: 'POST', url: `/api/rubrics/${result.rubricId}/approve`, headers: ADMIN });
    expect(again.statusCode).toBe(409);
  }, 240_000);

  it('reject requires a reason; rejected rubrics STAY LISTED with the reason (visible rigor)', async () => {
    const gen = await app.inject({ method: 'POST', url: '/api/rubrics/generate', headers: ADMIN, payload: { clusterId } });
    const job = await waitJob((gen.json() as { jobId: string }).jobId);
    expect(job.state).toBe('completed');
    const { rubricId } = job.result as { rubricId: string };

    const noReason = await app.inject({ method: 'POST', url: `/api/rubrics/${rubricId}/reject`, headers: ADMIN, payload: {} });
    expect(noReason.statusCode).toBe(400);
    const reject = await app.inject({
      method: 'POST',
      url: `/api/rubrics/${rubricId}/reject`,
      headers: ADMIN,
      payload: { reason: 'failed probe calibration at r=0.61 and was not deployed' },
    });
    expect(reject.statusCode).toBe(200);

    const list = await app.inject({ method: 'GET', url: '/api/rubrics', headers: VIEWER });
    const row = (list.json() as { rubrics: Array<Record<string, unknown>> }).rubrics.find((r) => r.id === rubricId)!;
    expect(row).toBeDefined(); // never hidden
    expect(row.status).toBe('rejected');
    expect(row.inForce).toBe(false);
    expect(row.statusReason).toContain('failed probe calibration');
    // and can no longer be approved
    const approve = await app.inject({ method: 'POST', url: `/api/rubrics/${rubricId}/approve`, headers: ADMIN });
    expect(approve.statusCode).toBe(409);
  }, 240_000);

  it('cross-org isolation: another org gets 404 on generate/approve and an empty list', async () => {
    const db = app.potion.db.db;
    const { insertApiKey: mkKey } = await import('@potion/db');
    await mkKey(db, { id: 'key-rub-b', keyHash: sha256('pk_rub_b'), name: 'rb', orgId: ORG_B });
    await createUser(db, { id: 'usr_rb', email: 'rb@t.dev', name: 'rb' });
    await createMembership(db, { orgId: ORG_B, userId: 'usr_rb', role: 'admin' });
    await createSession(db, {
      id: 'ses_rb',
      userId: 'usr_rb',
      tokenHash: sha256('ps_rb'),
      orgId: ORG_B,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const B = { cookie: 'potion_session=ps_rb' };

    const gen = await app.inject({ method: 'POST', url: '/api/rubrics/generate', headers: B, payload: { clusterId } });
    expect(gen.statusCode).toBe(404); // org A's cluster is invisible

    const list = await app.inject({ method: 'GET', url: '/api/rubrics', headers: B });
    expect((list.json() as { rubrics: unknown[] }).rubrics).toHaveLength(0);

    // grab one of org A's rubric ids and try to act on it from org B
    const aList = await app.inject({ method: 'GET', url: '/api/rubrics', headers: VIEWER });
    const anyId = (aList.json() as { rubrics: Array<{ id: string }> }).rubrics[0]!.id;
    const approve = await app.inject({ method: 'POST', url: `/api/rubrics/${anyId}/approve`, headers: B });
    expect(approve.statusCode).toBe(404);
  }, 120_000);
});
