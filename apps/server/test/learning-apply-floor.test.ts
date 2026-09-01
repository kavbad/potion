// Caption-vs-provenance CLOSURE (2026-09-01) — the 0.5 clamp, end to end.
// 2026-08-31 removed it from the PROPOSAL side; the external review found
// it alive in the APPLY path: the card says "set my bar at 0.38", the
// write said 0.50. The law: the floor written is the floor measured —
// floored to 2dp (conservative), bounded only by [0,1].
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256 } from '@potion/core';
import {
  createMembership,
  createOrg,
  createSession,
  createUser,
  getPolicyById,
  insertApiKey,
  insertLearningProposal,
  insertPolicy,
} from '@potion/db';
import { buildServer } from '../src/server.js';

const ORG = 'org-applyfloor';
let app: FastifyInstance;
const cookie = 'potion_session=ps_applyfloor';

beforeAll(async () => {
  app = await buildServer({ seed: true });
  const db = app.potion.db.db;
  await createOrg(db, { id: ORG, name: 'ApplyFloor Co' });
  await insertPolicy(db, { id: 'pol-af', orgId: ORG, name: 'base', config: { type: 'min_cost', qualityFloor: 0.9 } });
  await insertApiKey(db, { id: 'key-af', keyHash: sha256('pk_af'), name: 'k', orgId: ORG, scopes: 'serve', policyId: 'pol-af' });
  await createUser(db, { id: 'usr_af', email: 'a@af.test', name: 'a' });
  await createMembership(db, { orgId: ORG, userId: 'usr_af', role: 'admin' });
  await createSession(db, { id: 'ses_af', userId: 'usr_af', tokenHash: sha256('ps_applyfloor'), orgId: ORG, expiresAt: new Date(Date.now() + 3_600_000) });
  await insertLearningProposal(db, {
    id: 'lp-038', orgId: ORG, clusterId: 'summarization', suiteId: 'suite-x',
    incumbentModel: 'their-model', incumbentHash: 'ih', incumbentQuality: 0.38,
    servingHash: 'sh', servingModel: 'ours', servingQuality: 0.41,
    retention: { kept: 1 }, suggestedFloor: 0.38, items: 30,
  });
});
afterAll(async () => app.close());

describe('the measured floor is the written floor', () => {
  it('applying a 0.38 proposal writes clusterFloors.summarization = 0.38 — never 0.50', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/learning/proposals/lp-038/apply', headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { applied: boolean; policyId: string; qualityFloor: number; clusterFloors: Record<string, number> };
    expect(body.applied).toBe(true);
    expect(body.clusterFloors.summarization, 'the card said 0.38 — the write must be 0.38').toBe(0.38);
    const policy = await getPolicyById(app.potion.db.db, ORG, body.policyId);
    const floors = (policy!.config as { clusterFloors?: Record<string, number> }).clusterFloors ?? {};
    expect(floors.summarization).toBe(0.38);
  });

  it('PUT /api/floor accepts a sub-0.5 bar — the operator sets THEIR bar', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/api/floor', headers: { cookie, 'content-type': 'application/json' },
      payload: { qualityFloor: 0.3 },
    });
    expect(res.statusCode).toBe(200);
  });
});
