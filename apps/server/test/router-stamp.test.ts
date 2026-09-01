// G0 (0082): the receipt names the router version that SERVED — stamped at
// serve time by exact content match against the latest minted artifact,
// never reconstructed newest-wins for stamped rows. Pre-mint rows stay null
// on the ledger and fall back to reconstruction on the receipts surface.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256, strategyHash, type FrontierPoint } from '@potion/core';
import { createOrg, insertApiKey, insertPolicy, listRequestLogs } from '@potion/db';
import { saveFrontier } from '@potion/pareto';
import { buildServer } from '../src/server.js';
import { stampedRouterVersion } from '../src/routing/router-stamp.js';

const ORG = 'org-router-stamp';
const KEY = 'pk_router_stamp';
const CHEAP = { type: 'single', model: 'mock-cheap' } as const;
const MID = { type: 'single', model: 'mock-mid' } as const;

function point(clusterId: string, cfg: FrontierPoint['strategyConfig'], quality: number, costPer1K: number): FrontierPoint {
  return { clusterId, strategyHash: strategyHash(cfg), strategyConfig: cfg, quality, costPer1K, latencyP95: 400, providerMode: 'mock' };
}

let app: FastifyInstance;
const db = () => app.potion.db.db;

beforeAll(async () => {
  app = await buildServer({ seed: false });
  await createOrg(db(), { id: ORG, name: 'RouterStamp' });
  await insertPolicy(db(), { id: 'pol-rstamp', orgId: ORG, name: 'stamp', config: { type: 'min_cost', qualityFloor: 0.7 } });
  await insertApiKey(db(), { id: 'key-rstamp', keyHash: sha256(KEY), name: 'serve', orgId: ORG, policyId: 'pol-rstamp', scopes: 'serve+admin' });
  await saveFrontier(db(), 'classification', [point('classification', CHEAP, 0.8, 0.2), point('classification', MID, 0.92, 1.0)], 'manual', 'test-prices');
});
afterAll(async () => {
  await app.close();
});

async function serve() {
  return app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${KEY}`, 'x-potion-cluster': 'classification' },
    payload: { model: 'potion-auto', messages: [{ role: 'user', content: 'stamp this request' }] },
  });
}

describe('serve-time router-version stamping', () => {
  it('before any mint: no router token on the trace, null on the ledger', async () => {
    const res = await serve();
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['x-frontier-trace'])).not.toContain('router=');
    const rows = await listRequestLogs(db(), ORG, 5);
    expect(rows[0]!.routerVersion).toBeNull();
  });

  it('after minting v1: the trace carries router=v1 and the ledger stamps 1', async () => {
    // GET /api/routing-activity mints (compile-and-mint-first) — and the
    // mint must bust the stamp cache in-process, so the very next serve
    // stamps without waiting out the TTL.
    const minted = await app.inject({ method: 'GET', url: '/api/routing-activity', headers: { authorization: `Bearer ${KEY}` } });
    expect(minted.statusCode).toBe(200);
    const res = await serve();
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['x-frontier-trace'])).toContain('router=v1');
    const rows = await listRequestLogs(db(), ORG, 5);
    expect(rows[0]!.routerVersion).toBe(1);
  });

  it('receipts carry the version for both rows: stamped, and reconstructed for the pre-mint row', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/routing-activity', headers: { authorization: `Bearer ${KEY}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { requests: Array<{ routerVersion: number | null }> };
    const versions = body.requests.map((r) => r.routerVersion);
    expect(versions).toContain(1);
    expect(versions.filter((v) => v === 1).length).toBeGreaterThanOrEqual(2);
  });

  it('an assignment no minted version contains stamps null, never a wrong version', async () => {
    const wrongFrontier = await stampedRouterVersion(db(), ORG, {
      clusterId: 'classification',
      strategyHash: strategyHash(CHEAP),
      frontierVersion: 999,
    });
    expect(wrongFrontier).toBeNull();
    const wrongStrategy = await stampedRouterVersion(db(), ORG, {
      clusterId: 'classification',
      strategyHash: strategyHash(MID),
      frontierVersion: 1,
    });
    expect(wrongStrategy).toBeNull();
  });
});
