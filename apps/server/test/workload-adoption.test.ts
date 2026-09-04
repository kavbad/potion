// G2 rung 3 — workload adoption, end to end in the mock world:
//   measured workload → one-button adopt → org frontier minted AT THE
//   WORKLOAD ID from the workload's own measurement rows → the serve path
//   sub-assigns a matching request to the workload (trace names both the
//   workload and its parent) → retire hands routing back to the parent on
//   the next request. Plus the pins: adopt gates on 'measured' (409),
//   cross-org id → uniform 404; hinted requests never sub-assign (no
//   vector); a guard-blocked workload frontier fails OPEN to the parent.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256, strategyHash, type FrontierPoint, type StrategyConfig } from '@potion/core';
import { insertApiKey, insertEvalResult, insertPolicy, listOrgWorkloads, orgWorkloads, replaceOrgWorkloads } from '@potion/db';
import { and, eq } from 'drizzle-orm';
import { loadCurrentFrontier, saveFrontier } from '@potion/pareto';
import { buildServer } from '../src/server.js';
import { bustWorkloadRoutingCache } from '../src/routing/workload-assignment.js';
// R3: cross-tenant suites use TWO DISTINCT NON-DEFAULT orgs from the shared
// fixture — the demo org must never be the probed subject.
import { ORG_A, ORG_B, seedIsolationOrgs } from './fixtures/orgs.js';

const ORG = ORG_A;
const KEY = 'pk_adopt';
const KEY_B = 'pk_adopt_b';
const CHEAP = { type: 'single', model: 'mock-cheap' } as const; // parent serving
const MID = { type: 'single', model: 'mock-mid' } as const; // workload serving
const H_MID = strategyHash(MID);
const WL = 'wl-adopt-test-1';
// The request text: embedded once for the stored centroid and sent verbatim
// as the user message, so the serve path's own vector matches at cosine 1
// whatever the mock embedder maps it to.
const TEXT = 'Is this support ticket urgent or routine? Reply with one word.';

let app: FastifyInstance;
let parent: string; // whatever the real classifier assigns TEXT to
const db = () => app.potion.db.db;

function point(clusterId: string, cfg: StrategyConfig, quality: number, costPer1K: number): FrontierPoint {
  return { clusterId, strategyHash: strategyHash(cfg), strategyConfig: cfg, quality, costPer1K, latencyP95: 300, providerMode: 'mock' };
}

const chat = (key: string, hint?: string) =>
  app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${key}`, ...(hint !== undefined ? { 'x-potion-cluster': hint } : {}) },
    payload: { model: 'potion-auto', messages: [{ role: 'user', content: TEXT }] },
  });

async function seedWorkloadRow(status: string): Promise<void> {
  const [centroid] = await app.potion.embedder.embed([TEXT]);
  await replaceOrgWorkloads(db(), ORG, [
    {
      id: WL, orgId: ORG, parentCluster: parent, sampleCount: 6, cohesion: 0.93,
      exemplarText: TEXT.slice(0, 120), centroid: centroid!, memberTraceIds: [],
      status, threshold: 0.62, windowDays: 30,
      measurement: {
        servingModel: 'mock-cheap', servingQuality: 0.8, incumbentModel: 'mock-frontier',
        incumbentQuality: 0.82, retention: { mean: 0.97 }, items: 6, spendUsd: 0.01,
        measuredAt: new Date().toISOString(), runId: 'wm-test',
      },
    },
  ]);
  bustWorkloadRoutingCache(ORG);
}

beforeAll(async () => {
  app = await buildServer({ seed: false });
  await seedIsolationOrgs(db());
  for (const [orgId, key] of [[ORG, KEY], [ORG_B, KEY_B]] as const) {
    await insertPolicy(db(), { id: `pol-ad-${orgId}`, orgId, name: orgId, config: { type: 'min_cost', qualityFloor: 0.7 } });
    await insertApiKey(db(), { id: `key-ad-${orgId}`, keyHash: sha256(key), name: 'admin', orgId, policyId: `pol-ad-${orgId}`, scopes: 'serve+admin' });
  }
  // Let the REAL classifier name the parent — pinning a cluster by hand
  // would test a request the embedder might file elsewhere.
  const probe = await chat(KEY);
  expect(probe.statusCode).toBe(200);
  parent = /cluster=([^;]+)/.exec(probe.headers['x-frontier-trace'] as string)![1]!;
  // Parent platform frontier: cheap serves under the 0.7 floor.
  await saveFrontier(db(), parent, [point(parent, CHEAP, 0.8, 0.2)], 'manual', app.potion.prices.version);
  // The workload's own measurement rows, at the WORKLOAD-ID coordinate —
  // exactly where rung 2 lands them: org-scoped, this server's provider
  // mode, default instrument. Enough rows that the Jeffreys lower bound
  // clears the 0.7 floor.
  for (let i = 0; i < 14; i += 1) {
    await insertEvalResult(db(), {
      runId: 'run-wl-adopt', itemId: `it-${i}`, clusterId: WL, orgId: ORG,
      strategyHash: H_MID, strategyConfig: MID, quality: 1, scorer: 'llm-judge',
      usage: { inputTokens: 20, outputTokens: 5, costUsd: 0.00005, latencyMs: 200 },
      latencyMs: { p50: 200, p95: 300, mean: 210 }, modelVersions: {},
      pricesVersion: app.potion.prices.version, providerMode: 'mock',
      cacheKey: `wl-adopt-${i}`, createdAt: new Date().toISOString(),
    });
  }
}, 60_000);
afterAll(async () => {
  await app.close();
});

describe('workload adoption, end to end', () => {
  it('adopt gates on measured status and org scope', async () => {
    await seedWorkloadRow('observed');
    const notMeasured = await app.inject({ method: 'POST', url: `/api/workloads/${WL}/adopt`, headers: { authorization: `Bearer ${KEY}` } });
    expect(notMeasured.statusCode).toBe(409);
    const unknown = await app.inject({ method: 'POST', url: '/api/workloads/wl-nope/adopt', headers: { authorization: `Bearer ${KEY}` } });
    expect(unknown.statusCode).toBe(404);
    // Cross-org: a foreign org's id is a uniform 404 (route-inventory pin).
    const foreign = await app.inject({ method: 'POST', url: `/api/workloads/${WL}/adopt`, headers: { authorization: `Bearer ${KEY_B}` } });
    expect(foreign.statusCode).toBe(404);
  });

  it('a matching request keeps parent routing while the workload is merely measured', async () => {
    await seedWorkloadRow('measured');
    const res = await chat(KEY);
    expect(res.statusCode).toBe(200);
    const trace = res.headers['x-frontier-trace'] as string;
    expect(trace).toContain(`cluster=${parent}`);
    expect(trace).not.toContain('parent=');
    expect(res.headers['x-potion-model']).toBe('mock-cheap');
  });

  it('adopt mints the workload org frontier and reports what now serves', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/workloads/${WL}/adopt`, headers: { authorization: `Bearer ${KEY}` } });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { adopted: boolean; points: number; nowServes: { model: string } | null };
    expect(body.adopted).toBe(true);
    expect(body.points).toBeGreaterThanOrEqual(1);
    expect(body.nowServes?.model).toBe('mock-mid');
    const minted = await loadCurrentFrontier(db(), WL, ORG);
    expect(minted).not.toBeNull();
    expect(minted!.points.some((p) => p.strategyHash === H_MID)).toBe(true);
    const row = (await listOrgWorkloads(db(), ORG)).find((w) => w.id === WL);
    expect(row?.status).toBe('adopted');
    const again = await app.inject({ method: 'POST', url: `/api/workloads/${WL}/adopt`, headers: { authorization: `Bearer ${KEY}` } });
    expect(again.statusCode).toBe(409); // already adopted
  });

  it('the serve path sub-assigns a matching request to the adopted workload, labeled with its parent', async () => {
    const res = await chat(KEY);
    expect(res.statusCode).toBe(200);
    const trace = res.headers['x-frontier-trace'] as string;
    expect(trace).toContain(`cluster=${WL}`);
    expect(trace).toContain(`parent=${parent}`);
    expect(res.headers['x-potion-model']).toBe('mock-mid');
  });

  // THE GATE IS READ FROM THE ROW. Without this, setting the threshold to 0
  // — or ignoring it entirely — changed nothing: the only sub-assignment
  // test used a request that matched anyway, so the stored value was dead
  // weight that no test consulted (mutation audit, 2026-09-04).
  it('a similarity below the row’s own threshold does not sub-assign', async () => {
    const row = (await listOrgWorkloads(db(), ORG)).find((w) => w.id === WL)!;
    // Raise the gate above any attainable cosine, leaving everything else
    // identical to the passing case above. Only the stored number changed,
    // so only the stored number can explain the difference.
    await db().update(orgWorkloads).set({ threshold: 1.1 })
      .where(and(eq(orgWorkloads.orgId, ORG), eq(orgWorkloads.id, WL)));
    bustWorkloadRoutingCache(ORG);
    const res = await chat(KEY);
    expect(res.statusCode).toBe(200);
    const trace = res.headers['x-frontier-trace'] as string;
    expect(trace).toContain(`cluster=${parent}`);
    expect(trace).not.toContain('parent=');
    expect(res.headers['x-potion-model']).toBe('mock-cheap');

    // Restore the row's gate and the same request sub-assigns again.
    await db().update(orgWorkloads).set({ threshold: row.threshold })
      .where(and(eq(orgWorkloads.orgId, ORG), eq(orgWorkloads.id, WL)));
    bustWorkloadRoutingCache(ORG);
    const again = await chat(KEY);
    expect(again.headers['x-frontier-trace'] as string).toContain(`cluster=${WL}`);
  });

  // THE PRE-CHECK FAILS OPEN TO THE PARENT. Previously the only thing
  // guarding this was a regex asserting guardFrontierProvenance still
  // APPEARED in the file — keeping the call and ignoring its result shipped
  // green. An adopted workload whose frontier is gone must serve the parent,
  // never drop through to the default strategy.
  it('an adopted workload with no servable frontier falls open to the parent', async () => {
    const saved = await loadCurrentFrontier(db(), WL, ORG);
    expect(saved).not.toBeNull(); // it is adopted, so one exists
    // Supersede it with an empty one — the state a retired or fully-excluded
    // frontier leaves behind, and exactly what the pre-check tests for.
    await saveFrontier(db(), WL, [], 'recompute', app.potion.prices.version, {
      orgId: ORG,
      provenance: { suiteId: `learn-${WL}-v1` },
    });
    const gone = await loadCurrentFrontier(db(), WL, ORG);
    expect(gone === null || gone.points.length === 0, 'the workload must have nothing servable').toBe(true);
    bustWorkloadRoutingCache(ORG);

    const res = await chat(KEY);
    expect(res.statusCode).toBe(200);
    const trace = res.headers['x-frontier-trace'] as string;
    // The parent, on the parent's measured point — not the workload id, and
    // not a fallback: falling through would serve the default strategy.
    expect(trace).toContain(`cluster=${parent}`);
    expect(trace).not.toContain('parent=');
    expect(trace).toContain('fallback=0');
    expect(res.headers['x-potion-model']).toBe('mock-cheap');

    // Put it back so the retire test below still has an adopted, servable
    // workload to hand back.
    await saveFrontier(db(), WL, saved!.points, 'recompute', app.potion.prices.version, {
      orgId: ORG,
      provenance: { suiteId: `learn-${WL}-v1` },
    });
    bustWorkloadRoutingCache(ORG);
    expect((await chat(KEY)).headers['x-frontier-trace'] as string).toContain(`cluster=${WL}`);
  });

  it('a hinted request never sub-assigns — the hint path has no vector', async () => {
    const res = await chat(KEY, parent);
    expect(res.statusCode).toBe(200);
    const trace = res.headers['x-frontier-trace'] as string;
    expect(trace).toContain(`cluster=${parent}`);
    expect(trace).not.toContain('parent=');
    expect(res.headers['x-potion-model']).toBe('mock-cheap');
  });

  it('retire hands routing back to the parent on the next request', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/workloads/${WL}/retire`, headers: { authorization: `Bearer ${KEY}` } });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { parentCluster: string }).parentCluster).toBe(parent);
    const serve = await chat(KEY);
    const trace = serve.headers['x-frontier-trace'] as string;
    expect(trace).toContain(`cluster=${parent}`);
    expect(trace).not.toContain('parent=');
    expect(serve.headers['x-potion-model']).toBe('mock-cheap');
    const retireAgain = await app.inject({ method: 'POST', url: `/api/workloads/${WL}/retire`, headers: { authorization: `Bearer ${KEY}` } });
    expect(retireAgain.statusCode).toBe(409);
  });
});
