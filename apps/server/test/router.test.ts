// R1 (Router direction, 2026-08-27) — the router as a minted artifact.
//
// Pins: (1) the document is assembled by the serve path's own functions and
// carries the org's real assignment; (2) versions are lazily minted and a
// re-read does NOT double-mint; (3) a routing-input change mints the next
// version with a plain-language change line; (4) `potion/<slug>` is an
// exact serving alias of potion-auto — right name routes, wrong name is a
// 400 that says the right one; (5) /v1/models lists the named router first.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256, strategyHash, type Policy } from '@potion/core';
import {
  clusters,
  createDb,
  createMembership,
  createOrg,
  createSession,
  createUser,
  insertApiKey,
  insertPolicy,
  migrate,
  type DbHandle,
} from '@potion/db';
import { saveFrontier } from '@potion/pareto';
import { buildServer } from '../src/server.js';

const ORG = 'org_router_r1';
const RAW_KEY = 'pk_router_r1';
const COOKIE = 'potion_session=ps_router_r1';
const POLICY: Policy = { type: 'max_quality', costCeilingPer1K: 100 };

let h: DbHandle;
let app: FastifyInstance;
let devAuthBefore: string | undefined;

function livePoint(model: string, quality: number, costPer1K: number) {
  const config = { type: 'single' as const, model };
  return {
    clusterId: 'summarization',
    strategyHash: strategyHash(config),
    strategyConfig: config,
    quality,
    costPer1K,
    latencyP95: 700,
    providerMode: 'live' as const,
    evidence: { cacheKeys: ['ck-r1'], runIds: ['run-r1'], n: 12, qualityCi95: 0.02 },
  };
}

beforeAll(async () => {
  devAuthBefore = process.env.POTION_DEV_AUTH;
  process.env.POTION_DEV_AUTH = '0';
  h = await createDb();
  await migrate(h.db);
  await createOrg(h.db, { id: ORG, name: 'Acme Co' });
  await createUser(h.db, { id: 'usr_router_r1', email: 'router@r1.dev', name: 'r1' });
  await createMembership(h.db, { orgId: ORG, userId: 'usr_router_r1', role: 'admin' });
  await createSession(h.db, {
    id: 'ses_router_r1',
    userId: 'usr_router_r1',
    tokenHash: sha256('ps_router_r1'),
    orgId: ORG,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  await insertPolicy(h.db, { id: 'pol-router-r1', orgId: ORG, name: 'r1', config: POLICY });
  await insertApiKey(h.db, {
    id: 'key-router-r1',
    keyHash: sha256(RAW_KEY),
    name: 'r1',
    orgId: ORG,
    policyId: 'pol-router-r1',
  });
  await h.db
    .insert(clusters)
    .values({ id: 'summarization', name: 'summarization', description: 'taxonomy cluster' })
    .onConflictDoNothing();
  await saveFrontier(h.db, 'summarization', [livePoint('mock-cheap', 0.85, 0.012)], 'recompute', 'pv-r1');
  app = await buildServer({ db: h, seed: false });
}, 120_000);

afterAll(async () => {
  if (devAuthBefore === undefined) delete process.env.POTION_DEV_AUTH;
  else process.env.POTION_DEV_AUTH = devAuthBefore;
  await app.close();
  await h.close();
});

const getRouter = () =>
  app.inject({ method: 'GET', url: '/api/router', headers: { cookie: COOKIE } });

interface RouterBody {
  name: string;
  version: number;
  document: {
    policy: { description: string } | null;
    assignments: Array<{ clusterId: string; strategy: { label: string }; quality: number | null }>;
    changes: string[];
  };
  history: Array<{ version: number; changes: string[] }>;
}

describe('GET /api/router — the minted artifact', () => {
  it('assembles the serve-path assignment under the org name and mints v1', async () => {
    const res = await getRouter();
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as RouterBody;
    expect(body.name).toBe('potion/acme-co');
    expect(body.version).toBe(1);
    expect(body.document.changes).toEqual(['first compilation']);
    expect(body.document.policy?.description).toContain('Highest measured quality');
    const sum = body.document.assignments.find((a) => a.clusterId === 'summarization');
    expect(sum).toBeDefined();
    expect(sum!.strategy.label).toBe('mock-cheap');
    expect(sum!.quality).toBe(0.85);
  });

  it('a re-read does NOT double-mint: same state, same version', async () => {
    const res = await getRouter();
    expect((res.json() as RouterBody).version).toBe(1);
  });

  it('a routing change mints v2 with a plain-language change line', async () => {
    // The frontier moves: a cheaper point now wins under the same policy...
    // no — max_quality picks highest quality under ceiling, so a HIGHER
    // quality point takes the route. Either way the assignment changes.
    await saveFrontier(h.db, 'summarization', [livePoint('mock-mid', 0.93, 0.05)], 'recompute', 'pv-r2');
    const res = await getRouter();
    const body = res.json() as RouterBody;
    expect(body.version).toBe(2);
    const line = body.document.changes.find((c) => c.includes('summarization'));
    expect(line, JSON.stringify(body.document.changes)).toBeDefined();
    expect(line).toContain('mock-cheap');
    expect(line).toContain('mock-mid');
    expect(body.history[0]!.version).toBe(2);
    expect(body.history[1]!.version).toBe(1);
  });
});

describe('potion/<slug> — the router as a serving alias', () => {
  const chat = (model: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      payload: { model, messages: [{ role: 'user', content: 'summarize: potion routes by measurement' }] },
    });

  it('the org’s router name routes exactly like potion-auto', async () => {
    const res = await chat('potion/acme-co');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['x-frontier-trace']).toBeDefined();
  });

  it('a wrong potion/* name is a 400 that says the right one', async () => {
    const res = await chat('potion/somebody-else');
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('potion/acme-co');
  });

  it('/v1/models lists the named router first, as a router', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${RAW_KEY}` },
    });
    expect(res.statusCode).toBe(200);
    const data = (res.json() as { data: Array<{ id: string; potion?: { role?: string } }> }).data;
    expect(data[0]!.id).toBe('potion/acme-co');
    expect(data[0]!.potion?.role).toBe('router');
    expect(data[1]!.id).toBe('potion-auto');
  });
});
