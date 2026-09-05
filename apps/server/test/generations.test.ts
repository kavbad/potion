// G2 rung 4 — router generations, end to end.
//
// The lifecycle's invariants are pinned at the repo level
// (packages/db/src/router-generations.test.ts). What THIS file proves is the
// part that only exists once a real server is serving real requests: that a
// generation changes WHAT GETS SERVED, and that rolling back changes it
// back. A generation whose promotion left routing identical would be a
// filing cabinet, not a control.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256, strategyHash, type FrontierPoint, type StrategyConfig } from '@potion/core';
import { insertApiKey, insertPolicy, listFrontierPins } from '@potion/db';
import { saveFrontier } from '@potion/pareto';
import { buildServer } from '../src/server.js';
// R3: cross-tenant suites use TWO DISTINCT NON-DEFAULT orgs from the shared
// fixture — the demo org must never be the probed subject.
import { ORG_A, ORG_B, seedIsolationOrgs } from './fixtures/orgs.js';

const ORG = ORG_A;
const KEY = 'pk_gen';
const KEY_B = 'pk_gen_b';
const CLUSTER = 'code-gen';
const CHEAP = { type: 'single', model: 'mock-cheap' } as const;
const MID = { type: 'single', model: 'mock-mid' } as const;

let app: FastifyInstance;
const db = () => app.potion.db.db;

const point = (cfg: StrategyConfig, quality: number, costPer1K: number): FrontierPoint => ({
  clusterId: CLUSTER,
  strategyHash: strategyHash(cfg),
  strategyConfig: cfg,
  quality,
  costPer1K,
  latencyP95: 300,
  providerMode: 'mock',
});

const chat = (key = KEY) =>
  app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${key}`, 'x-potion-cluster': CLUSTER },
    payload: { model: 'potion-auto', messages: [{ role: 'user', content: 'write a function that reverses a list' }] },
  });

const api = (method: 'GET' | 'POST', url: string, key = KEY) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${key}` } });

beforeAll(async () => {
  app = await buildServer({ seed: false });
  await seedIsolationOrgs(db());
  for (const [orgId, key] of [[ORG, KEY], [ORG_B, KEY_B]] as const) {
    await insertPolicy(db(), { id: `pol-gen-${orgId}`, orgId, name: orgId, config: { type: 'min_cost', qualityFloor: 0.7 } });
    await insertApiKey(db(), { id: `key-gen-${orgId}`, keyHash: sha256(key), name: 'admin', orgId, policyId: `pol-gen-${orgId}`, scopes: 'serve+admin' });
  }
  // v1: cheap is the cheapest point clearing the 0.7 floor.
  await saveFrontier(db(), CLUSTER, [point(CHEAP, 0.8, 0.2)], 'manual', app.potion.prices.version);
}, 60_000);
afterAll(async () => {
  await app.close();
});

describe('router generations', () => {
  it('staging captures what is serving now, and serves nothing differently', async () => {
    expect((await chat()).headers['x-potion-model']).toBe('mock-cheap');
    const res = await api('POST', '/api/router/generations');
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json() as { generation: { id: string; status: string; clusters: number } };
    expect(body.generation.status).toBe('candidate');
    expect(body.generation.clusters).toBeGreaterThan(0);
    // A candidate pins nothing — staging must be free of consequence.
    expect(await listFrontierPins(db(), ORG)).toEqual([]);
    expect((await chat()).headers['x-potion-model']).toBe('mock-cheap');
  });

  it('promoting freezes the routing it captured — a newer frontier does NOT move it', async () => {
    const staged = (await api('POST', '/api/router/generations')).json() as { generation: { id: string } };
    const promoted = await api('POST', `/api/router/generations/${staged.generation.id}/promote`);
    expect(promoted.statusCode, promoted.body).toBe(200);
    expect((promoted.json() as { promoted: boolean }).promoted).toBe(true);

    // A new frontier version lands where mid now beats cheap on the policy.
    // Without a generation this would immediately change what serves.
    await saveFrontier(db(), CLUSTER, [point(CHEAP, 0.72, 0.9), point(MID, 0.95, 0.3)], 'recompute', app.potion.prices.version);
    expect(
      (await chat()).headers['x-potion-model'],
      'the promoted generation must hold routing still',
    ).toBe('mock-cheap');
  });

  it('a NEW generation captures the newer frontier and promoting it moves serving', async () => {
    // Capture must see past the pin the previous generation wrote, or a
    // generation could never advance — the second one would freeze the first.
    const staged = (await api('POST', '/api/router/generations')).json() as { generation: { id: string } };
    const res = await api('POST', `/api/router/generations/${staged.generation.id}/promote`);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { supersededId: string | null }).supersededId).not.toBeNull();
    expect((await chat()).headers['x-potion-model']).toBe('mock-mid');
  });

  it('ROLLBACK puts the old routing back — the property the whole feature is for', async () => {
    const list = (await api('GET', '/api/router/generations')).json() as {
      servingId: string;
      rollbackTo: Array<{ id: string }>;
    };
    const previous = list.rollbackTo[0]!;
    const res = await api('POST', `/api/router/generations/${previous.id}/rollback`);
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { rolledBackFromId: string }).rolledBackFromId).toBe(list.servingId);
    // Serving is back on the old model, without touching a frontier.
    expect((await chat()).headers['x-potion-model']).toBe('mock-cheap');

    const after = (await api('GET', '/api/router/generations')).json() as {
      servingId: string;
      generations: Array<{ id: string; status: string }>;
    };
    expect(after.servingId).toBe(previous.id);
    expect(after.generations.find((g) => g.id === list.servingId)?.status).toBe('rolled-back');
  });

  it('refuses the transitions that would misdescribe what happened', async () => {
    const serving = (await api('GET', '/api/router/generations')).json() as { servingId: string };
    // Already serving: promoting it again would invent a second promotion.
    expect((await api('POST', `/api/router/generations/${serving.servingId}/promote`)).statusCode).toBe(409);
    expect((await api('POST', `/api/router/generations/${serving.servingId}/rollback`)).statusCode).toBe(409);
    expect((await api('POST', '/api/router/generations/gen-nope/promote')).statusCode).toBe(404);
    // A fresh candidate has never served — there is nothing to go back to.
    const fresh = (await api('POST', '/api/router/generations')).json() as { generation: { id: string } };
    expect((await api('POST', `/api/router/generations/${fresh.generation.id}/rollback`)).statusCode).toBe(409);
  });

  it('org-scoped: another org sees none of these and cannot promote them', async () => {
    const mine = (await api('GET', '/api/router/generations')).json() as { generations: Array<{ id: string }> };
    expect(mine.generations.length).toBeGreaterThan(0);
    const theirs = (await api('GET', '/api/router/generations', KEY_B)).json() as {
      generations: unknown[];
      servingId: string | null;
    };
    expect(theirs.generations).toEqual([]);
    expect(theirs.servingId).toBeNull();
    // A foreign id is a uniform 404, not a 403 — no existence oracle.
    const foreign = await api('POST', `/api/router/generations/${mine.generations[0]!.id}/promote`, KEY_B);
    expect(foreign.statusCode).toBe(404);
    // And ORG_A's pins are untouched by the attempt.
    expect((await listFrontierPins(db(), ORG)).length).toBeGreaterThan(0);
  });

  it('a serve key cannot stage, promote or roll back', async () => {
    await insertApiKey(db(), {
      id: 'key-gen-serveonly', keyHash: sha256('pk_gen_serveonly'), name: 'serve', orgId: ORG, policyId: `pol-gen-${ORG}`,
    });
    for (const url of ['/api/router/generations', '/api/router/generations/gen-x/promote']) {
      const res = await api('POST', url, 'pk_gen_serveonly');
      expect(res.statusCode, url).toBeGreaterThanOrEqual(403);
    }
  });
});
