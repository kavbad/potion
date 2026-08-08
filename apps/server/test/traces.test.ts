// Trace route tests (M5, ROADMAP #36, SPEC §14) — seeded PGlite server,
// in-process worker (real handlers), zero network.
//   · POST /v1/traces: 401/400/202, cost priced at ingest (alias AND model-
//     id match), idempotent re-posts
//   · GET /api/traces: session rollup with loop detection + metadataOnly
//   · GET /api/traces/:traceId: waterfall + 404
//   · PUT/GET /api/traces/retention + POST /api/traces/purge (admin gates;
//     retention 0 = metadata only after purge)
//   · POST /api/traces/cluster → agent-* cluster + frontier; then the
//     X-Potion-Cluster hint pins chat routing (unknown hint → 400)
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256 } from '@potion/core';
import { createMembership, createSession, createUser, DEFAULT_ORG_ID } from '@potion/db';
import { toolSignatureSlug } from '@potion/workers';
import { buildServer } from '../src/server.js';
import { DEMO_API_KEY } from '../src/seed.js';

// G2.4: the demo credential is gated (POTION_SEED_DEMO); this suite uses it
// deliberately, matching the POTION_SELF_SERVE polarity — no implicit exceptions.
process.env.POTION_SEED_DEMO = '1';

let app: FastifyInstance;
let root: string;

const ADMIN = { cookie: 'potion_session=ps_t_admin' };
const VIEWER = { cookie: 'potion_session=ps_t_viewer' };
const KEY = { authorization: `Bearer ${DEMO_API_KEY}`, 'content-type': 'application/json' };

async function waitJob(
  jobId: string,
  timeoutMs = 120_000,
): Promise<{ state: string; error?: string; result?: unknown }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await app.inject({ method: 'GET', url: `/api/jobs/${jobId}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { state: string; error?: string; result?: unknown };
    if (body.state === 'completed' || body.state === 'failed') return body;
    if (Date.now() > deadline) throw new Error(`job ${jobId} did not settle in ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

function agentSpan(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    trace_id: 'tr_root',
    span_id: 'sp_1',
    name: 'agent.root',
    model: 'haiku-class',
    input_tokens: 1000,
    output_tokens: 1000,
    attributes: { 'gen_ai.prompt': 'Refactor the billing retry loop' },
    ...over,
  };
}

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'potion-server-traces-'));
  // G1.3: derived suites live in db storage — no POTION_SUITES_V2_DIR tmp
  // dir needed; the worker writes no files.
  app = await buildServer(); // seeded: org_demo + DEMO_API_KEY + frontiers

  await createUser(app.potion.db.db, { id: 'usr_t_admin', email: 'admin@t.dev', name: 'admin' });
  await createMembership(app.potion.db.db, { orgId: DEFAULT_ORG_ID, userId: 'usr_t_admin', role: 'admin' });
  await createSession(app.potion.db.db, {
    id: 'ses_t_admin',
    userId: 'usr_t_admin',
    tokenHash: sha256('ps_t_admin'),
    orgId: DEFAULT_ORG_ID,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  await createUser(app.potion.db.db, { id: 'usr_t_viewer', email: 'viewer@t.dev', name: 'viewer' });
  await createMembership(app.potion.db.db, { orgId: DEFAULT_ORG_ID, userId: 'usr_t_viewer', role: 'viewer' });
  await createSession(app.potion.db.db, {
    id: 'ses_t_viewer',
    userId: 'usr_t_viewer',
    tokenHash: sha256('ps_t_viewer'),
    orgId: DEFAULT_ORG_ID,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
}, 90_000);

afterAll(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

describe('POST /v1/traces (M5 #36)', () => {
  it('G1.1: PII is redacted AT INGEST — raw prompts never at rest; operational keys survive', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/traces',
      headers: KEY,
      payload: {
        spans: [
          {
            trace_id: 'tr_pii',
            span_id: 'sp_pii_1',
            name: 'agent.root',
            model: 'haiku-class',
            input_tokens: 10,
            output_tokens: 5,
            attributes: {
              'gen_ai.prompt': 'Email cfo@acme.io about card 4111 1111 1111 1111 and call +1 (555) 123-4567 re invoice 99887766',
              'tool.args': { q: 'ssn 123-45-6789', n: 7 },
            },
          },
        ],
      },
    });
    expect(res.statusCode).toBe(202);
    const wf = await app.inject({ method: 'GET', url: '/api/traces/tr_pii', headers: ADMIN });
    const span = wf.json().spans[0];
    expect(span.attrs['gen_ai.prompt']).toBe(
      'Email <email> about card <card> and call <phone> re invoice <num>',
    );
    expect(span.attrs['tool.args']).toEqual({ q: 'ssn <ssn>', n: 7 });
    // server-injected model key intact despite its digit run
    expect(span.attrs['gen_ai.request.model']).toBe('haiku-class');
  });

  it('401 without a key; 400 for an invalid batch; 202 idempotent with ingest pricing', async () => {
    const unauthed = await app.inject({ method: 'POST', url: '/v1/traces', payload: { spans: [agentSpan()] } });
    expect(unauthed.statusCode).toBe(401);

    const bad = await app.inject({ method: 'POST', url: '/v1/traces', headers: KEY, payload: { spans: [] } });
    expect(bad.statusCode).toBe(400);

    // haiku-class: $1.0/$5.0 per 1M → 1000+1000 tokens = $0.006 (alias match).
    // Same span via the provider MODEL-ID matches the same price entry.
    const batch = {
      spans: [
        agentSpan(),
        agentSpan({ span_id: 'sp_2', model: 'claude-haiku-4-5-20251001' }),
        agentSpan({ span_id: 'sp_3', model: 'some-unlisted-model' }), // unknown → $0
      ],
    };
    const first = await app.inject({ method: 'POST', url: '/v1/traces', headers: KEY, payload: batch });
    expect(first.statusCode).toBe(202);
    const firstBody = first.json() as { accepted: number; duplicates: number; costUsd: number };
    expect(firstBody.accepted).toBe(3);
    expect(firstBody.duplicates).toBe(0);
    expect(firstBody.costUsd).toBeCloseTo(0.012, 9);

    // Retries are safe: the identical batch counts as duplicates.
    const second = await app.inject({ method: 'POST', url: '/v1/traces', headers: KEY, payload: batch });
    const secondBody = second.json() as { accepted: number; duplicates: number };
    expect(secondBody).toEqual({ accepted: 0, duplicates: 3, costUsd: 0.012 });
  });
});

describe('GET /api/traces — rollup, loops, waterfall (M5 #36)', () => {
  it('rolls sessions up with loop signals; waterfall orders spans; 404 for unknown', async () => {
    // A looping agent trace: 3 IDENTICAL tool.search calls (same args).
    const loopTool = {
      trace_id: 'tr_loop',
      name: 'tool.search',
      model: 'mock-cheap',
      attributes: { 'gen_ai.operation.name': 'execute_tool', query: 'retry budget' },
    };
    // Real OTel exporters stamp each span; the waterfall orders by ts.
    const at = (min: number) => new Date(Date.UTC(2026, 7, 6, 10, min)).toISOString();
    const ingest = await app.inject({
      method: 'POST',
      url: '/v1/traces',
      headers: KEY,
      payload: {
        spans: [
          { ...loopTool, span_id: 'lp_root', name: 'agent.root', attributes: { 'gen_ai.prompt': 'Fix the retry budget loop' }, ts: at(0) },
          { ...loopTool, span_id: 'lp_1', ts: at(1) },
          { ...loopTool, span_id: 'lp_2', ts: at(2) },
          { ...loopTool, span_id: 'lp_3', ts: at(3) },
        ],
      },
    });
    expect(ingest.statusCode).toBe(202);

    const rollup = await app.inject({ method: 'GET', url: '/api/traces', headers: VIEWER });
    expect(rollup.statusCode).toBe(200);
    const { sessions } = rollup.json() as {
      sessions: {
        traceId: string;
        spanCount: number;
        totalCostUsd: number;
        models: string[];
        looping: boolean;
        metadataOnly: boolean;
      }[];
    };
    const loop = sessions.find((s) => s.traceId === 'tr_loop')!;
    expect(loop.spanCount).toBe(4);
    expect(loop.looping).toBe(true);
    const root = sessions.find((s) => s.traceId === 'tr_root')!;
    expect(root.totalCostUsd).toBeCloseTo(0.012, 9);
    expect(root.models).toContain('haiku-class');
    expect(root.metadataOnly).toBe(false);

    const waterfall = await app.inject({ method: 'GET', url: '/api/traces/tr_loop', headers: VIEWER });
    expect(waterfall.statusCode).toBe(200);
    const wf = waterfall.json() as { spans: { spanId: string; attrs: Record<string, unknown> }[] };
    expect(wf.spans.map((s) => s.spanId)).toEqual(['lp_root', 'lp_1', 'lp_2', 'lp_3']);
    expect(wf.spans[0]!.attrs['gen_ai.prompt']).toBe('Fix the retry budget loop');

    const missing = await app.inject({ method: 'GET', url: '/api/traces/tr_nope', headers: VIEWER });
    expect(missing.statusCode).toBe(404);
  });
});

describe('retention + purge (M5 #36, SPEC §14.3)', () => {
  it('viewer may not set retention (403); admin sets 0; purge → metadata only', async () => {
    const viewerPut = await app.inject({
      method: 'PUT',
      url: '/api/traces/retention',
      headers: { ...VIEWER, 'content-type': 'application/json' },
      payload: { days: 0 },
    });
    expect(viewerPut.statusCode).toBe(403);

    const adminPut = await app.inject({
      method: 'PUT',
      url: '/api/traces/retention',
      headers: { ...ADMIN, 'content-type': 'application/json' },
      payload: { days: 0 },
    });
    expect(adminPut.statusCode).toBe(200);
    const get = await app.inject({ method: 'GET', url: '/api/traces/retention', headers: VIEWER });
    expect((get.json() as { traceRetentionDays: number }).traceRetentionDays).toBe(0);

    const purge = await app.inject({ method: 'POST', url: '/api/traces/purge', headers: ADMIN });
    expect(purge.statusCode).toBe(202);
    const job = await waitJob((purge.json() as { jobId: string }).jobId);
    expect(job.state).toBe('completed');

    // Payloads redacted, metadata kept.
    const wf = await app.inject({ method: 'GET', url: '/api/traces/tr_loop', headers: VIEWER });
    const body = wf.json() as { spans: { attrs: Record<string, unknown>; model: string | null }[] };
    expect(body.spans.every((s) => Object.keys(s.attrs).length === 0)).toBe(true);
    expect(body.spans[0]!.model).toBe('mock-cheap');
    const rollup = await app.inject({ method: 'GET', url: '/api/traces', headers: VIEWER });
    const { sessions } = rollup.json() as { sessions: { traceId: string; metadataOnly: boolean }[] };
    expect(sessions.every((s) => s.metadataOnly)).toBe(true);

    // Restore the default for the remaining tests.
    await app.inject({
      method: 'PUT',
      url: '/api/traces/retention',
      headers: { ...ADMIN, 'content-type': 'application/json' },
      payload: { days: 30 },
    });
  });
});

describe('agent clustering + X-Potion-Cluster hint (M5 #36, SPEC §14.2)', () => {
  it('clusters sessions into agent-* clusters with frontiers; hint pins routing; unknown hint 400s', async () => {
    // Two similar billing sessions (same tool graph) in the caller's org.
    const mk = (traceId: string, prompt: string, spanBase: string) => ({
      spans: [
        { trace_id: traceId, span_id: `${spanBase}_root`, name: 'agent.root', model: 'mock-cheap', attributes: { 'gen_ai.prompt': prompt } },
        {
          trace_id: traceId,
          span_id: `${spanBase}_tool`,
          name: 'tool.search',
          model: 'mock-cheap',
          attributes: { 'gen_ai.operation.name': 'execute_tool', 'tool.args': 'invoices', 'tool.result': 'ok' },
        },
        // G1.4: final answer → replay reference on the derived item.
        {
          trace_id: traceId,
          span_id: `${spanBase}_ans`,
          name: 'chat',
          model: 'mock-cheap',
          attributes: { 'gen_ai.completion': `Refactored the retry loop (${spanBase}).` },
        },
      ],
    });
    await app.inject({ method: 'POST', url: '/v1/traces', headers: KEY, payload: mk('tr_c1', 'Refactor the billing retry loop for invoices', 'c1') });
    await app.inject({ method: 'POST', url: '/v1/traces', headers: KEY, payload: mk('tr_c2', 'Refactor the billing retry loop for receipts', 'c2') });

    const viewer = await app.inject({ method: 'POST', url: '/api/traces/cluster', headers: VIEWER });
    expect(viewer.statusCode).toBe(403);

    const trigger = await app.inject({
      method: 'POST',
      url: '/api/traces/cluster',
      headers: { ...ADMIN, 'content-type': 'application/json' },
      payload: { sinceDays: 30 },
    });
    expect(trigger.statusCode).toBe(202);
    const job = await waitJob((trigger.json() as { jobId: string }).jobId, 180_000);
    expect(job.state).toBe('completed');
    const clusterResult = job.result as {
      sessionsSeen: number;
      clustersCreated: number;
      clusters: { clusterId: string; evalRunId: string | null }[];
    };
    expect(clusterResult.sessionsSeen).toBeGreaterThanOrEqual(2);
    expect(clusterResult.clustersCreated).toBeGreaterThanOrEqual(1);
    expect(clusterResult.clusters.every((c) => c.evalRunId !== null)).toBe(true);

    // An agent-* cluster with a frontier now exists (billing sessions share
    // the 'search' tool-graph signature).
    const frontiers = await app.inject({ method: 'GET', url: '/api/frontiers', headers: VIEWER });
    expect(frontiers.statusCode).toBe(200);
    const { clusters: listed } = frontiers.json() as { clusters: { clusterId: string }[] };
    expect(listed.some((c) => c.clusterId.startsWith('agent-'))).toBe(true);
    // The billing sessions share the 'search' tool-graph signature.
    const agentCluster = listed.find((c) => c.clusterId.includes(toolSignatureSlug(['search'])));
    expect(agentCluster).toBeDefined();

    // G1.4: the derived replay items carry the session's final answer as the
    // reference, and the prompt leads with the tool-transcript system message.
    const { loadDerivedSuite } = await import('@potion/db');
    const derived = await loadDerivedSuite(app.potion.db.db, `${agentCluster!.clusterId}-replays-v1`);
    expect(derived).not.toBeNull();
    expect(derived!.items.length).toBeGreaterThanOrEqual(1);
    for (const it of derived!.items) {
      expect(String(it.reference)).toContain('Refactored the retry loop');
      expect(it.prompt[0]!.role).toBe('system');
      expect(it.prompt[0]!.content).toContain('search(invoices) → ok');
    }

    // The hint pins routing to the agent cluster (x-frontier-trace).
    const chat = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { ...KEY, 'x-potion-cluster': agentCluster!.clusterId },
      payload: { model: 'potion-auto', messages: [{ role: 'user', content: 'Refactor the billing retry loop' }] },
    });
    expect(chat.statusCode).toBe(200);
    expect(chat.headers['x-frontier-trace']).toContain(`cluster=${agentCluster!.clusterId}`);

    // Unknown hint → explicit 400 (never silent re-routing).
    const unknown = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { ...KEY, 'x-potion-cluster': 'agent-doesnotexist' },
      payload: { model: 'potion-auto', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(unknown.statusCode).toBe(400);
    expect((unknown.json() as { error: { code: string; param: string } }).error.code).toBe('cluster_not_found');
    expect((unknown.json() as { error: { param: string } }).error.param).toBe('X-Potion-Cluster');

    // G1.2: ANOTHER org's hint on this cluster id → the SAME 400 (no
    // existence oracle, no cross-tenant pinning).
    const { createOrg: mkOrg, insertApiKey: mkKey, insertPolicy: mkPol } = await import('@potion/db');
    const { sha256: h } = await import('@potion/core');
    await mkOrg(app.potion.db.db, { id: 'org_g12_b', name: 'G12B' });
    await mkPol(app.potion.db.db, {
      id: 'pol-g12-b',
      orgId: 'org_g12_b',
      name: 'g12b',
      config: { type: 'max_quality', costCeilingPer1K: 100 },
    });
    await mkKey(app.potion.db.db, {
      id: 'key-g12-b',
      keyHash: h('pk_g12_b'),
      name: 'g12b',
      orgId: 'org_g12_b',
      policyId: 'pol-g12-b',
    });
    const crossOrg = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: 'Bearer pk_g12_b',
        'content-type': 'application/json',
        'x-potion-cluster': agentCluster!.clusterId,
      },
      payload: { model: 'potion-auto', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(crossOrg.statusCode).toBe(400);
    expect(crossOrg.json().error.code).toBe('cluster_not_found');
    // and org B's frontier list does NOT include org A's agent cluster
    const bFront = await app.inject({
      method: 'GET',
      url: '/api/frontiers',
      headers: { authorization: 'Bearer pk_g12_b' },
    });
    const bListed = (bFront.json() as { clusters: { clusterId: string }[] }).clusters;
    expect(bListed.some((c) => c.clusterId === agentCluster!.clusterId)).toBe(false);
  }, 240_000);
});
