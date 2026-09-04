// Quality-safe cluster tiebreak (routing/ambiguity.ts). Two clusters whose
// centroids match a request almost equally; the cheaper cluster's policy pick
// is the lower-quality one. The request must be served under the other.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { desc } from 'drizzle-orm';
import { sha256, strategyHash, type FrontierPoint } from '@potion/core';
import type { RankedAssignment } from '@potion/cluster';
import { createOrg, insertApiKey, insertPolicy, requestLogs } from '@potion/db';
import { saveFrontier } from '@potion/pareto';
import { buildServer } from '../src/server.js';
import { ambiguousRunnerUp, pickSafer, type TiebreakCandidate } from '../src/routing/ambiguity.js';

const ORG = 'org-tiebreak';
const KEY = 'pk_tiebreak';
const CHEAP = { type: 'single', model: 'mock-cheap' } as const;
const MID = { type: 'single', model: 'mock-mid' } as const;

function point(clusterId: string, cfg: FrontierPoint['strategyConfig'], quality: number, costPer1K: number): FrontierPoint {
  return { clusterId, strategyHash: strategyHash(cfg), strategyConfig: cfg, quality, costPer1K, latencyP95: 400, providerMode: 'mock' };
}

function ranking(best: number, runnerUp: number): RankedAssignment {
  const r = [
    { clusterId: 'classification', confidence: best },
    { clusterId: 'rewrite-edit', confidence: runnerUp },
  ];
  return { assignment: r[0]!, ranking: r, fellBack: false, embedding: [] };
}

let app: FastifyInstance;
const db = () => app.potion.db.db;

beforeAll(async () => {
  app = await buildServer({ seed: false });
  await createOrg(db(), { id: ORG, name: 'Tiebreak' });
  await insertPolicy(db(), { id: 'pol-tiebreak', orgId: ORG, name: 'floor-0.7', config: { type: 'min_cost', qualityFloor: 0.7 } });
  await insertApiKey(db(), { id: 'key-tiebreak', keyHash: sha256(KEY), name: 'serve', orgId: ORG, policyId: 'pol-tiebreak' });
  await saveFrontier(db(), 'classification', [point('classification', CHEAP, 0.8, 0.3)], 'manual', 'test-prices');
  await saveFrontier(db(), 'rewrite-edit', [point('rewrite-edit', MID, 0.9, 1.0)], 'manual', 'test-prices');
});
afterAll(async () => {
  await app.close();
});

async function serve(r: RankedAssignment, prompt: string) {
  app.potion.assigner = { ...app.potion.assigner, assignRanked: async () => r };
  const res = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${KEY}` },
    payload: { model: 'potion-auto', messages: [{ role: 'user', content: prompt }] },
  });
  const trace = String(res.headers['x-frontier-trace']);
  const cluster = /cluster=([^;]+)/.exec(trace)?.[1];
  const [row] = await db().select().from(requestLogs).orderBy(desc(requestLogs.id)).limit(1);
  return { status: res.statusCode, cluster, model: res.headers['x-potion-model'], tiebreak: row?.clusterTiebreak ?? null };
}

describe('pickSafer', () => {
  it('measured beats unmeasured, then quality, then cost, then the original best', () => {
    // Typed as the interface, not inferred from the literal: pickSafer is
    // generic over ONE T, so an inferred `quality: number` here would forbid
    // the null-carrying candidates these cases exist to exercise.
    const a: TiebreakCandidate = { clusterId: 'a', quality: 0.8, costPer1K: 0.3 };
    expect(pickSafer(a, { clusterId: 'b', quality: null, costPer1K: null }).clusterId).toBe('a');
    expect(pickSafer({ clusterId: 'a', quality: null, costPer1K: null }, a).clusterId).toBe('a');
    expect(pickSafer(a, { clusterId: 'b', quality: 0.9, costPer1K: 1 }).clusterId).toBe('b');
    expect(pickSafer(a, { clusterId: 'b', quality: 0.8, costPer1K: 0.2 }).clusterId).toBe('b');
    expect(pickSafer(a, { clusterId: 'b', quality: 0.8, costPer1K: 0.3 }).clusterId).toBe('a');
  });
  it('ambiguousRunnerUp names the pair only inside the margin, never on a fallback', () => {
    expect(ambiguousRunnerUp(ranking(0.45, 0.43), 0.03)).toBe('rewrite-edit');
    expect(ambiguousRunnerUp(ranking(0.45, 0.40), 0.03)).toBeNull();
    expect(ambiguousRunnerUp({ ...ranking(0.45, 0.43), fellBack: true }, 0.03)).toBeNull();
    expect(ambiguousRunnerUp(ranking(0.45, 0.43), 0)).toBeNull();
  });
});

describe('serving under ambiguity', () => {
  it('a near-equal pair is served under the higher measured quality, and the row says so', async () => {
    const r = await serve(ranking(0.45, 0.43), 'Label this: the invoice is overdue — tiebreak one');
    expect(r.status).toBe(200);
    expect(r.cluster).toBe('rewrite-edit');
    expect(r.model).toBe('mock-mid');
    expect(r.tiebreak).toBe(true);
  });
  it('a clear best is served as matched', async () => {
    const r = await serve(ranking(0.45, 0.30), 'Label this: the invoice is overdue — clear one');
    expect(r.status).toBe(200);
    expect(r.cluster).toBe('classification');
    expect(r.model).toBe('mock-cheap');
    expect(r.tiebreak).not.toBe(true);
  });
});
