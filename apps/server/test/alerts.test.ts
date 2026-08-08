// Alert-rule route tests (M4, ROADMAP #33, SPEC §13.5).
//   · CRUD over HTTP (dev-bypass org = org_demo admin); list always MASKS
//     the target URL (scheme+host only — Slack path secrets never returned)
//   · role gates: viewer GETs but cannot create/delete/test (403)
//   · validation: non-URL target, empty/unknown events → 400
//   · org isolation: org B cannot delete org A's rule (uniform 404)
//   · POST /api/alerts/test delivers the dispatcher's exact body shape
//     (webhook JSON {event, org_id, detail, ts}; slack {text}) to a local
//     receiver, and reports delivered:false + redacted error for a dead URL
//   · end-to-end: a budget hard-stop 429 on the serving path emits a
//     budget_exceeded alert through the in-process queue to the receiver,
//     deduped to one budget_events row per (org, kind, UTC day)
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256, strategyHash, type FrontierPoint } from '@potion/core';
import {
  DEFAULT_ORG_ID,
  createMembership,
  createOrg,
  createSession,
  createUser,
  insertApiKey,
  insertPolicy,
  insertRequestLog,
  listAlertRules,
  listBudgetEvents,
  upsertBudget,
} from '@potion/db';
import { saveFrontier } from '@potion/pareto';
import { buildServer } from '../src/server.js';
import { clearBudgetHardStopCache } from '../src/routes/budgets.js';

const ORG_A = DEFAULT_ORG_ID;
const ORG_B = 'org_alerts_b';
const KEY_B = 'pk_alerts_org_b';

const CFG = { type: 'single', model: 'mock-mid' } as const;
const POINT: FrontierPoint = {
  clusterId: 'code-gen',
  strategyHash: strategyHash(CFG),
  strategyConfig: CFG,
  quality: 0.9,
  costPer1K: 1.0,
  latencyP95: 100,
};

/** Bodies received by the local webhook sink. */
const received: Array<{ headers: Record<string, unknown>; body: Record<string, unknown> }> = [];
let sink: Server;
let sinkUrl = '';

let app: FastifyInstance;
const db = () => app.potion.db.db;

async function waitForSink(count: number, timeoutMs = 3000): Promise<void> {
  const t0 = Date.now();
  while (received.length < count && Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeAll(async () => {
  sink = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({
        headers: req.headers as Record<string, unknown>,
        body: JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<string, unknown>,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', resolve));
  sinkUrl = `http://127.0.0.1:${(sink.address() as AddressInfo).port}/hook?secret=abc123`;

  app = await buildServer({ seed: false });
  await saveFrontier(db(), 'code-gen', [POINT], 'manual', 'test-prices');
  await insertPolicy(db(), {
    id: 'pol-alerts',
    orgId: ORG_A,
    name: 'alerts-default',
    config: { type: 'max_quality', costCeilingPer1K: 5 },
  });
  await insertApiKey(db(), {
    id: 'key-alerts-a',
    keyHash: sha256('pk_alerts_a'),
    name: 'a',
    orgId: ORG_A,
    policyId: 'pol-alerts',
  });
  await createOrg(db(), { id: ORG_B, name: 'Alerts Org B' });
  // G2.3: probes admin routes cross-org — explicit admin scope.
  await insertApiKey(db(), { id: 'key-alerts-b', keyHash: sha256(KEY_B), name: 'b', orgId: ORG_B, scopes: 'serve+admin' });
  // Viewer session on org A (role gates).
  await createUser(db(), { id: 'usr_al_viewer', email: 'viewer@al.dev', name: 'viewer' });
  await createMembership(db(), { orgId: ORG_A, userId: 'usr_al_viewer', role: 'viewer' });
  await createSession(db(), {
    id: 'ses_al_viewer',
    userId: 'usr_al_viewer',
    tokenHash: sha256('ps_al_viewer'),
    orgId: ORG_A,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
});

afterAll(async () => {
  await app.close();
  await new Promise<void>((resolve, reject) =>
    sink.close((err) => (err ? reject(err) : resolve())),
  );
});

const VIEWER_COOKIE = { cookie: 'potion_session=ps_al_viewer' };

describe('alert rules CRUD + masking', () => {
  it('GET /api/alerts starts empty', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/alerts' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ rules: [] });
  });

  it('POST /api/alerts creates a rule; GET masks the target (no path/query secrets)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/alerts',
      payload: { kind: 'webhook', targetUrl: sinkUrl, events: ['budget_exceeded', 'breaker_open'] },
    });
    expect(res.statusCode).toBe(201);
    const rule = res.json().rule;
    expect(rule.targetMasked).toBe(`${new URL(sinkUrl).protocol}//${new URL(sinkUrl).host}/•••`);
    expect(rule.targetMasked).not.toContain('secret');
    expect(rule.events).toEqual(['budget_exceeded', 'breaker_open']);

    const list = await app.inject({ method: 'GET', url: '/api/alerts' });
    const rules = list.json().rules as Array<{ targetMasked: string }>;
    expect(rules).toHaveLength(1);
    expect(rules[0]!.targetMasked).not.toContain('secret');
    // And the raw row in the db DOES carry the full target (dispatcher needs it).
    const rows = await listAlertRules(db(), ORG_A);
    expect(rows[0]!.targetUrl).toBe(sinkUrl);
  });

  it('validation: non-URL target, empty events, unknown event → 400', async () => {
    const bad1 = await app.inject({
      method: 'POST',
      url: '/api/alerts',
      payload: { kind: 'webhook', targetUrl: 'not-a-url', events: ['budget_exceeded'] },
    });
    expect(bad1.statusCode).toBe(400);
    const bad2 = await app.inject({
      method: 'POST',
      url: '/api/alerts',
      payload: { kind: 'webhook', targetUrl: sinkUrl, events: [] },
    });
    expect(bad2.statusCode).toBe(400);
    const bad3 = await app.inject({
      method: 'POST',
      url: '/api/alerts',
      payload: { kind: 'webhook', targetUrl: sinkUrl, events: ['nope'] },
    });
    expect(bad3.statusCode).toBe(400);
  });

  it('role gates: viewer can GET but POST/DELETE/test are 403', async () => {
    const get = await app.inject({ method: 'GET', url: '/api/alerts', headers: VIEWER_COOKIE });
    expect(get.statusCode).toBe(200);
    const post = await app.inject({
      method: 'POST',
      url: '/api/alerts',
      headers: VIEWER_COOKIE,
      payload: { kind: 'webhook', targetUrl: sinkUrl, events: ['rollback'] },
    });
    expect(post.statusCode).toBe(403);
    const rules = (await app.inject({ method: 'GET', url: '/api/alerts' })).json().rules;
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/alerts/${rules[0].id}`,
      headers: VIEWER_COOKIE,
    });
    expect(del.statusCode).toBe(403);
    const test = await app.inject({
      method: 'POST',
      url: '/api/alerts/test',
      headers: VIEWER_COOKIE,
      payload: { url: sinkUrl },
    });
    expect(test.statusCode).toBe(403);
  });

  it('org isolation: org B cannot delete org A’s rule (uniform 404); org A can', async () => {
    const rules = (await app.inject({ method: 'GET', url: '/api/alerts' })).json().rules;
    const id = rules[0].id as string;
    const cross = await app.inject({
      method: 'DELETE',
      url: `/api/alerts/${id}`,
      headers: { authorization: `Bearer ${KEY_B}` },
    });
    expect(cross.statusCode).toBe(404);
    // Rule survives the cross-org attempt — keep it for the e2e test below;
    // a second org-A rule exercises the successful delete.
    const second = await app.inject({
      method: 'POST',
      url: '/api/alerts',
      payload: { kind: 'webhook', targetUrl: sinkUrl, events: ['rollback'] },
    });
    const own = await app.inject({ method: 'DELETE', url: `/api/alerts/${second.json().rule.id}` });
    expect(own.statusCode).toBe(200);
    expect(own.json()).toMatchObject({ deleted: true });
  });
});

describe('POST /api/alerts/test', () => {
  it('delivers the webhook contract body to the receiver', async () => {
    const before = received.length;
    const res = await app.inject({
      method: 'POST',
      url: '/api/alerts/test',
      payload: { url: sinkUrl },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.delivered).toBe(true);
    expect(body.status).toBe(200);
    expect(typeof body.latencyMs).toBe('number');
    expect(received.length).toBe(before + 1);
    const last = received[received.length - 1]!.body;
    expect(last.event).toBe('budget_warning'); // representative test shape
    expect(last.org_id).toBe(ORG_A);
    expect(last.detail).toMatchObject({ message: expect.stringContaining('test alert') });
    expect(typeof last.ts).toBe('string');
  });

  it('slack kind sends the {text} incoming-webhook shape', async () => {
    const before = received.length;
    const res = await app.inject({
      method: 'POST',
      url: '/api/alerts/test',
      payload: { url: sinkUrl, kind: 'slack' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().delivered).toBe(true);
    const last = received[received.length - 1]!.body;
    expect(typeof last.text).toBe('string');
    expect(last.text as string).toContain('[potion]');
    expect(received.length).toBe(before + 1);
  });

  it('dead URL → delivered:false with a query-redacted error, never the secret', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/alerts/test',
      payload: { url: 'http://127.0.0.1:1/hook?secret=abc123' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.delivered).toBe(false);
    if (body.error) expect(body.error as string).not.toContain('secret=abc123');
  });
});

describe('end-to-end: serving-path hard stop emits budget_exceeded', () => {
  it('429 → one webhook delivery + one budget_events ledger row (deduped)', async () => {
    clearBudgetHardStopCache();
    // Seed MTD spend above the cap, then arm the hard stop.
    const today = new Date().toISOString().slice(0, 10);
    await insertRequestLog(db(), {
      ts: new Date(`${today}T08:00:00Z`),
      orgId: ORG_A,
      clusterId: 'code-gen',
      status: 'ok',
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.5, latencyMs: 10 },
    });
    await upsertBudget(db(), { orgId: ORG_A, monthlyCapUsd: 0.1, hardStop: true, warnPct: 80 });
    clearBudgetHardStopCache();

    const before = received.length;
    const chat = () =>
      app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: 'Bearer pk_alerts_a', 'content-type': 'application/json' },
        payload: { model: 'potion-auto', messages: [{ role: 'user', content: 'hello' }] },
      });
    const r1 = await chat();
    expect(r1.statusCode).toBe(429);
    expect(r1.json().error).toMatchObject({ type: 'budget_exceeded', code: 'budget_exceeded' });
    const r2 = await chat();
    expect(r2.statusCode).toBe(429);

    await waitForSink(before + 1);
    // Exactly ONE delivery despite two refusals (ledger dedup per UTC day)…
    expect(received.length).toBe(before + 1);
    const alert = received[received.length - 1]!.body;
    expect(alert.event).toBe('budget_exceeded');
    expect(alert.org_id).toBe(ORG_A);
    expect(alert.detail).toMatchObject({ source: 'serving_path_hard_stop', monthlyCapUsd: 0.1 });
    // …and one ledger row.
    const events = await listBudgetEvents(db(), ORG_A);
    expect(events.filter((e) => e.kind === 'budget_exceeded')).toHaveLength(1);

    // Disarm for other tests.
    await upsertBudget(db(), { orgId: ORG_A, monthlyCapUsd: 1e6, hardStop: false, warnPct: 80 });
    clearBudgetHardStopCache();
  });
});
