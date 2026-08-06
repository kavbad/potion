// M4 #30 (SPEC §13.1) — X-Potion-Policy per-request policy override tests.
// Boots a real server on PGlite (same pattern as server.test.ts) with a
// hand-made frontier whose points are selected distinctly per policy type,
// so the override is observable on the trace header AND in request_logs.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256, strategyHash, type FrontierPoint, type Policy } from '@potion/core';
import {
  DEFAULT_ORG_ID,
  createOrg,
  insertApiKey,
  insertPolicy,
  listRequestLogs,
} from '@potion/db';
import { saveFrontier } from '@potion/pareto';
import { buildServer } from '../src/server.js';

const CFG_MID = { type: 'single', model: 'mock-mid' } as const;
const CFG_STRONG = { type: 'single', model: 'mock-frontier' } as const;
const H_MID = strategyHash(CFG_MID).slice(0, 8);
const H_STRONG = strategyHash(CFG_STRONG).slice(0, 8);

function point(
  strategyConfig: FrontierPoint['strategyConfig'],
  quality: number,
  costPer1K: number,
  latencyP95: number,
): FrontierPoint {
  return {
    clusterId: 'code-gen',
    strategyHash: strategyHash(strategyConfig),
    strategyConfig,
    quality,
    costPer1K,
    latencyP95,
  };
}

const POINTS: FrontierPoint[] = [point(CFG_MID, 0.7, 1.0, 900), point(CFG_STRONG, 0.9, 10.0, 1800)];

const KEY = 'pk_test_override_base';
const KEY_OTHER_ORG = 'pk_test_override_other_org';
// Bound policy: max_quality ceiling 1.5 → mid point.
const POLICY_BOUND: Policy = { type: 'max_quality', costCeilingPer1K: 1.5 };
// Override policy: min_cost floor 0.8 → strong point.
const POLICY_OVERRIDE: Policy = { type: 'min_cost', qualityFloor: 0.8 };
const OVERRIDE_NAME = 'quality-first';
const OTHER_ORG = 'org_override_other';

const PROMPT = 'Write a python function that reverses a string';

let app: FastifyInstance;

function chat(rawKey: string, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${rawKey}`, 'content-type': 'application/json', ...headers },
    payload: { model: 'potion-auto', messages: [{ role: 'user', content: PROMPT }] },
  });
}

beforeAll(async () => {
  app = await buildServer({ seed: false });
  const db = app.potion.db.db;

  await insertPolicy(db, {
    id: 'pol-bound',
    orgId: DEFAULT_ORG_ID,
    name: 'bound-default',
    config: POLICY_BOUND,
  });
  await insertPolicy(db, {
    id: 'pol-override',
    orgId: DEFAULT_ORG_ID,
    name: OVERRIDE_NAME,
    config: POLICY_OVERRIDE,
  });
  await insertApiKey(db, {
    id: 'key-override-base',
    keyHash: sha256(KEY),
    name: 'key-override-base',
    orgId: DEFAULT_ORG_ID,
    policyId: 'pol-bound',
  });

  // A second org whose policy id/name must NOT resolve from the first org.
  await createOrg(db, { id: OTHER_ORG, name: 'Other Org' });
  await insertPolicy(db, {
    id: 'pol-other-org',
    orgId: OTHER_ORG,
    name: 'other-org-policy',
    config: POLICY_OVERRIDE,
  });
  await insertApiKey(db, {
    id: 'key-other-org',
    keyHash: sha256(KEY_OTHER_ORG),
    name: 'key-other-org',
    orgId: OTHER_ORG,
    policyId: 'pol-other-org',
  });

  await saveFrontier(db, 'code-gen', POINTS, 'manual', '2026-08-04');
}, 90_000);

afterAll(async () => {
  await app.close();
});

describe('X-Potion-Policy override (M4 #30)', () => {
  it('header absent → bound policy serves (default path unchanged)', async () => {
    const res = await chat(KEY);
    expect(res.statusCode).toBe(200);
    const trace = res.headers['x-frontier-trace'] as string;
    expect(trace).toContain(`strategy=${H_MID}`);
    expect(trace).toContain('policy=max_quality');
    expect(trace).not.toContain('policy_override=');
    const logs = await listRequestLogs(app.potion.db.db, DEFAULT_ORG_ID, 1);
    expect(logs[0]?.policyType).toBe('max_quality');
    expect(logs[0]?.policyId).toBe('pol-bound');
  });

  it('override by policy id resolves and serves the override policy', async () => {
    const res = await chat(KEY, { 'x-potion-policy': 'pol-override' });
    expect(res.statusCode).toBe(200);
    const trace = res.headers['x-frontier-trace'] as string;
    expect(trace).toContain(`strategy=${H_STRONG}`);
    expect(trace).toContain('policy=min_cost');
    expect(trace).toContain(`policy_override=${OVERRIDE_NAME}`);
    const logs = await listRequestLogs(app.potion.db.db, DEFAULT_ORG_ID, 1);
    expect(logs[0]?.policyType).toBe('min_cost');
    expect(logs[0]?.policyId).toBe('pol-override');
  });

  it('override by policy name resolves identically', async () => {
    const res = await chat(KEY, { 'x-potion-policy': OVERRIDE_NAME });
    expect(res.statusCode).toBe(200);
    const trace = res.headers['x-frontier-trace'] as string;
    expect(trace).toContain(`strategy=${H_STRONG}`);
    expect(trace).toContain(`policy_override=${OVERRIDE_NAME}`);
    const logs = await listRequestLogs(app.potion.db.db, DEFAULT_ORG_ID, 1);
    expect(logs[0]?.policyId).toBe('pol-override');
  });

  it('unknown policy → OpenAI-shaped 400 policy_not_found', async () => {
    const res = await chat(KEY, { 'x-potion-policy': 'no-such-policy' });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.code).toBe('policy_not_found');
    expect(body.error.param).toBe('X-Potion-Policy');
    const logs = await listRequestLogs(app.potion.db.db, DEFAULT_ORG_ID, 1);
    expect(logs[0]?.status).toBe('policy_not_found');
  });

  it("another org's policy name is NOT resolvable (no cross-org oracle)", async () => {
    const res = await chat(KEY, { 'x-potion-policy': 'other-org-policy' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('policy_not_found');
    // ...and by id either.
    const byId = await chat(KEY, { 'x-potion-policy': 'pol-other-org' });
    expect(byId.statusCode).toBe(400);
    expect(byId.json().error.code).toBe('policy_not_found');
  });

  it('the other org can override with its own policy', async () => {
    const res = await chat(KEY_OTHER_ORG, { 'x-potion-policy': 'other-org-policy' });
    expect(res.statusCode).toBe(200);
    const logs = await listRequestLogs(app.potion.db.db, OTHER_ORG, 1);
    expect(logs[0]?.policyId).toBe('pol-other-org');
  });

  it('legacy /v1/completions honors the same override', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/completions',
      headers: {
        authorization: `Bearer ${KEY}`,
        'content-type': 'application/json',
        'x-potion-policy': OVERRIDE_NAME,
      },
      payload: { model: 'potion-auto', prompt: PROMPT },
    });
    expect(res.statusCode).toBe(200);
    const trace = res.headers['x-frontier-trace'] as string;
    expect(trace).toContain(`strategy=${H_STRONG}`);
    expect(trace).toContain(`policy_override=${OVERRIDE_NAME}`);
    const logs = await listRequestLogs(app.potion.db.db, DEFAULT_ORG_ID, 1);
    expect(logs[0]?.policyId).toBe('pol-override');
  });

  it('legacy /v1/completions: unknown policy → 400 policy_not_found', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/completions',
      headers: {
        authorization: `Bearer ${KEY}`,
        'content-type': 'application/json',
        'x-potion-policy': 'nope',
      },
      payload: { model: 'potion-auto', prompt: PROMPT },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('policy_not_found');
    expect(res.json().error.param).toBe('X-Potion-Policy');
  });
});
