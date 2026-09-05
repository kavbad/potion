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
import { insertApiKey, insertPolicy, insertRequestLog, listFrontierPins, listRequestLogs } from '@potion/db';
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
    // rateRps: these tests deliberately send bursts to observe a RANDOM
    // slice; against the 10 rps default the extras 429 and arrive as
    // 'undefined' models, which reads as a routing bug rather than a
    // throttle (the lesson from compound-policy.test.ts).
    await insertApiKey(db(), { id: `key-gen-${orgId}`, keyHash: sha256(key), name: 'admin', orgId, policyId: `pol-gen-${orgId}`, scopes: 'serve+admin', rateRps: 1000 });
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

// ---------------------------------------------------------------------------
// G2 rung 4b — THE CANARY SLICE
// ---------------------------------------------------------------------------
describe('the canary slice', () => {
  it('a candidate can take a slice; the rest of traffic is untouched', async () => {
    // Serving is back on cheap (the rollback above). Stage a candidate that
    // captures the newer frontier, where mid wins.
    const staged = (await api('POST', '/api/router/generations')).json() as { generation: { id: string } };
    const on = await app.inject({
      method: 'POST',
      url: `/api/router/generations/${staged.generation.id}/canary`,
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      payload: { rate: 0.5 },
    });
    expect(on.statusCode, on.body).toBe(200);
    expect((on.json() as { canaryRate: number }).canaryRate).toBe(0.5);

    // Over many requests BOTH routes appear: the slice serves the candidate's
    // frontier, everything else serves the promoted one. A canary that moved
    // everything, or nothing, would fail here.
    const models = new Set<string>();
    const canaryTraces: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      const res = await chat();
      models.add(String(res.headers['x-potion-model']));
      const trace = String(res.headers['x-frontier-trace']);
      if (trace.includes('canary=')) canaryTraces.push(trace);
    }
    expect(models, 'both the promoted and the canary route must appear').toEqual(new Set(['mock-cheap', 'mock-mid']));
    // Every canary-labeled request names the generation that routed it.
    expect(canaryTraces.length).toBeGreaterThan(0);
    for (const t of canaryTraces) expect(t).toContain(`canary=${staged.generation.id}`);

    // And the ledger agrees with the trace — the row records what happened.
    const rows = await listRequestLogs(db(), ORG, 60);
    const labeled = rows.filter((r) => r.generationId === staged.generation.id);
    expect(labeled.length).toBeGreaterThan(0);
    expect(labeled.every((r) => r.servedModel === 'mock-mid')).toBe(true);
  });

  it('stopping the canary returns every request to the promoted routing', async () => {
    const list = (await api('GET', '/api/router/generations')).json() as {
      generations: Array<{ id: string; canaryRate: number }>;
    };
    const canarying = list.generations.find((g) => g.canaryRate > 0)!;
    const off = await app.inject({
      method: 'POST',
      url: `/api/router/generations/${canarying.id}/canary`,
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      payload: { rate: 0 },
    });
    expect(off.statusCode).toBe(200);
    for (let i = 0; i < 12; i += 1) {
      const res = await chat();
      expect(res.headers['x-potion-model']).toBe('mock-cheap');
      expect(String(res.headers['x-frontier-trace'])).not.toContain('canary=');
    }
  });

  it('refuses a rate above the cap, a non-candidate, and a second simultaneous canary', async () => {
    const canary = (id: string, rate: unknown) =>
      app.inject({
        method: 'POST',
        url: `/api/router/generations/${id}/canary`,
        headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
        payload: { rate },
      });
    const a = (await api('POST', '/api/router/generations')).json() as { generation: { id: string } };
    const b = (await api('POST', '/api/router/generations')).json() as { generation: { id: string } };
    expect((await canary(a.generation.id, 0.9)).statusCode).toBe(409); // over CANARY_MAX_RATE
    expect((await canary(a.generation.id, 'half')).statusCode).toBe(400);
    expect((await canary('gen-nope', 0.1)).statusCode).toBe(404);
    expect((await canary(a.generation.id, 0.1)).statusCode).toBe(200);
    // A second candidate cannot canary while the first is: two would make a
    // request's routing depend on which coin landed first.
    expect((await canary(b.generation.id, 0.1)).statusCode).toBe(409);
    // The generation that is SERVING is not a candidate and cannot canary.
    const serving = (await api('GET', '/api/router/generations')).json() as { servingId: string };
    expect((await canary(serving.servingId, 0.1)).statusCode).toBe(409);
    await canary(a.generation.id, 0); // leave the fixture quiet
  });

  it('promoting a canarying candidate clears its rate — it is the router now, not a slice', async () => {
    const staged = (await api('POST', '/api/router/generations')).json() as { generation: { id: string } };
    await app.inject({
      method: 'POST',
      url: `/api/router/generations/${staged.generation.id}/canary`,
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      payload: { rate: 0.2 },
    });
    const promoted = await api('POST', `/api/router/generations/${staged.generation.id}/promote`);
    expect(promoted.statusCode).toBe(200);
    expect((promoted.json() as { generation: { canaryRate: number } }).generation.canaryRate).toBe(0);
    // Every request now rides it, and none is labeled a canary.
    for (let i = 0; i < 8; i += 1) {
      expect(String((await chat()).headers['x-frontier-trace'])).not.toContain('canary=');
    }
  });
});

// ---------------------------------------------------------------------------
// G2 rung 4c — THE EVIDENCE GATE ON PROMOTE
// ---------------------------------------------------------------------------
describe('the evidence gate', () => {
  const post = (url: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, payload });

  it('reports what the canary measured, and lets a thin canary through', async () => {
    const staged = (await api('POST', '/api/router/generations')).json() as { generation: { id: string } };
    const ev = await api('GET', `/api/router/generations/${staged.generation.id}/evidence`);
    expect(ev.statusCode).toBe(200);
    const v = (ev.json() as { verdict: { sufficient: boolean; adverse: boolean; reasons: string[] } }).verdict;
    expect(v.sufficient).toBe(false); // it has routed nothing
    expect(v.adverse).toBe(false);
    // A generation with no canary at all promotes exactly as before.
    expect((await api('POST', `/api/router/generations/${staged.generation.id}/promote`)).statusCode).toBe(200);
  });

  it('REFUSES a promotion the org’s own traffic condemns, and names why', async () => {
    // Seed the comparison directly: a canary-labelled cohort that cost far
    // more than the concurrent control. Both sides are ok, non-holdout rows
    // in the same window, which is what generationEvidence reads.
    const gen = (await api('POST', '/api/router/generations')).json() as { generation: { id: string } };
    const id = gen.generation.id;
    for (let i = 0; i < 40; i += 1) {
      await insertRequestLog(db(), {
        orgId: ORG, clusterId: CLUSTER, strategyHash: 'h-canary', model: 'mock-mid', status: 'ok',
        usage: { inputTokens: 10, outputTokens: 10, costUsd: 0.05, latencyMs: 10 }, latencyMs: 10,
        generationId: id,
      } as never);
      await insertRequestLog(db(), {
        orgId: ORG, clusterId: CLUSTER, strategyHash: 'h-control', model: 'mock-cheap', status: 'ok',
        usage: { inputTokens: 10, outputTokens: 10, costUsd: 0.001, latencyMs: 10 }, latencyMs: 10,
      } as never);
    }
    const ev = (await api('GET', `/api/router/generations/${id}/evidence`)).json() as {
      verdict: { sufficient: boolean; adverse: boolean; canaryRequests: number };
    };
    expect(ev.verdict.sufficient).toBe(true);
    expect(ev.verdict.adverse).toBe(true);
    expect(ev.verdict.canaryRequests).toBeGreaterThanOrEqual(40);

    const refused = await api('POST', `/api/router/generations/${id}/promote`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('generation_evidence_adverse');
    expect(refused.json().error.message).toContain('costs more on your own traffic');
    // And it did NOT promote: the previous generation still serves.
    const list = (await api('GET', '/api/router/generations')).json() as { servingId: string };
    expect(list.servingId).not.toBe(id);
  });

  it('the override promotes anyway and RECORDS that it overrode the evidence', async () => {
    const list = (await api('GET', '/api/router/generations')).json() as {
      generations: Array<{ id: string; status: string; canaryRate: number }>;
    };
    const condemned = list.generations.find((g) => g.status === 'candidate')!;
    const res = await post(`/api/router/generations/${condemned.id}/promote`, { acceptDegradation: true });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { verdict: { adverse: boolean } }).verdict.adverse).toBe(true);

    // The override is written on the row — a promotion against measurement
    // is exactly what a future reader will want explained.
    const after = (await api('GET', '/api/router/generations')).json() as {
      servingId: string;
      generations: Array<{ id: string; note: string | null }>;
    };
    expect(after.servingId).toBe(condemned.id);
    const note = after.generations.find((g) => g.id === condemned.id)?.note ?? '';
    expect(note).toContain('promoted over adverse evidence');
    expect(note).toContain('costs more on your own traffic');
  });

  it('evidence is org-scoped — a foreign id is a uniform 404', async () => {
    const mine = (await api('GET', '/api/router/generations')).json() as { generations: Array<{ id: string }> };
    expect((await api('GET', `/api/router/generations/${mine.generations[0]!.id}/evidence`, KEY_B)).statusCode).toBe(404);
  });
});
