// Tools no longer collide with a prompt-transforming operating point.
//
// THE DEFECT. `tools`/`tool_choice` can only be honoured by a single-model
// strategy — cascade/ensemble/draft-verify rewrite or fan out what the model
// sees, so tool-call semantics cannot be guaranteed through them. The serving
// path used to answer that collision with a hard 400. Three clusters on the
// committed platform frontier carry a cascade (code-gen, creative,
// rewrite-edit), so a customer whose policy happened to select one and who
// sent tools got a consistent production failure whose only remedy was
// "choose a different policy".
//
// THE FIX, and why it is safe. Selection is NARROWED to single-model points
// when tools are present, and the substitution is labelled on the trace as
// `constrained=tools`. Restricting to a subset can never BREACH a policy's
// stated bound — a quality floor, a cost ceiling and a latency bound all still
// hold, because every candidate considered is one the unrestricted policy
// would also have accepted. It costs optimality only, which is why `fallback`
// stays 0: the request really was routed on measured evidence.
//
// The frontier below is deliberately shaped so the cascade WINS on the
// unconstrained policy — otherwise the test would pass without exercising
// anything.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256, strategyHash, type FrontierPoint, type Policy } from '@potion/core';
import { insertApiKey, insertPolicy } from '@potion/db';
import { saveFrontier } from '@potion/pareto';
import { buildServer } from '../src/server.js';
import { resolveOperatingPoint } from '../src/routes/chat.js';
import { ORG_A, seedIsolationOrgs } from './fixtures/orgs.js';

const CFG_CHEAP = { type: 'single', model: 'mock-cheap' } as const;
const CFG_CASCADE = {
  type: 'cascade',
  models: ['mock-cheap', 'mock-frontier'],
  confidenceThreshold: 0.7,
} as const;
const CFG_STRONG = { type: 'single', model: 'mock-frontier' } as const;

const H_CASCADE = strategyHash(CFG_CASCADE);
const H_STRONG = strategyHash(CFG_STRONG);

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
    providerMode: 'mock',
  };
}

// The cascade is the cheapest point ABOVE a 0.8 floor, so min_cost picks it
// unconstrained — exactly the collision that used to 400.
const POINTS: FrontierPoint[] = [
  point(CFG_CHEAP, 0.72, 0.4, 300), // below the floor
  point(CFG_CASCADE, 0.88, 0.9, 2100), // cheapest above it — and transforming
  point(CFG_STRONG, 0.9, 2.5, 1200), // cheapest SINGLE above it
];

const KEY = 'pk_tools_narrow';
// Classifies to code-gen, which is the cluster the frontier below is saved
// for. A prompt that lands anywhere else gets no frontier and falls back,
// which would make every assertion here vacuous.
const PROMPT = 'Write a python function that reverses a string';
const TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'run_tests',
      description: 'Run the test suite for a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
  },
];

let app: FastifyInstance;
const db = (): FastifyInstance['potion']['db']['db'] => app.potion.db.db;

function chat(payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    payload: { model: 'potion-auto', messages: [{ role: 'user', content: PROMPT }], ...payload },
  });
}

function trace(res: { headers: Record<string, unknown> }): Record<string, string> {
  const raw = String(res.headers['x-frontier-trace'] ?? '');
  return Object.fromEntries(
    raw.split(';').filter(Boolean).map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i), kv.slice(i + 1)];
    }),
  );
}

const MIN_COST: Policy = { type: 'min_cost', qualityFloor: 0.8 };

beforeAll(async () => {
  app = await buildServer({ seed: false });
  await seedIsolationOrgs(db());
  await saveFrontier(db(), 'code-gen', POINTS, 'manual', 'test-prices');
  await insertPolicy(db(), { id: 'pol-tools', orgId: ORG_A, name: 'pol-tools', config: MIN_COST });
  await insertApiKey(db(), {
    id: 'key-tools',
    keyHash: sha256(KEY),
    name: 'tools',
    orgId: ORG_A,
    policyId: 'pol-tools',
  });
}, 90_000);

afterAll(async () => {
  await app.close();
});

describe('tools narrow selection instead of failing the request', () => {
  it('without tools the policy still picks the cheapest point, cascade included', async () => {
    // Asserted on the TRACE, not the status: the trace is written before
    // execution, and a mock cascade does not complete in this harness (the
    // G2.6 suite asserts the same case the same way). Selection is the
    // subject here — this is the control proving the frontier really does
    // prefer the cascade, so the tools case below is exercising something.
    const t = trace(await chat({}));
    expect(t.strategy).toBe(H_CASCADE.slice(0, 8));
    // Ordinary traffic's trace must be byte-identical to before this change.
    expect(t.constrained).toBeUndefined();
  });

  it('WITH tools it serves the best single point rather than returning 400', async () => {
    const res = await chat({ tools: TOOLS });
    expect(res.statusCode).toBe(200); // the defect: this used to be 400
    const t = trace(res);
    expect(t.strategy).toBe(H_STRONG.slice(0, 8));
  });

  it('labels the substitution on the trace', async () => {
    const res = await chat({ tools: TOOLS });
    expect(trace(res).constrained).toBe('tools');
  });

  it('keeps fallback=0 — the policy was satisfied, only its optimum narrowed', async () => {
    const res = await chat({ tools: TOOLS });
    expect(trace(res).fallback).toBe('0');
  });

  it('records what it would have served, so the substitution is auditable', () => {
    const frontier = {
      id: 'f1',
      clusterId: 'code-gen',
      version: 2,
      parentId: null,
      points: POINTS,
      createdAt: new Date().toISOString(),
    } as never;
    const op = resolveOperatingPoint(MIN_COST, frontier, CFG_CHEAP, { toolCapableOnly: true });
    expect(op.config).toEqual(CFG_STRONG);
    expect(op.toolConstraint?.wouldHaveServedType).toBe('cascade');
    expect(op.toolConstraint?.wouldHaveServedHash).toBe(H_CASCADE);
  });

  it('does not label a request whose optimum was already single', () => {
    const frontier = {
      id: 'f1',
      clusterId: 'code-gen',
      version: 2,
      parentId: null,
      points: POINTS,
      createdAt: new Date().toISOString(),
    } as never;
    // A cost ceiling that admits only the cheap single point.
    const op = resolveOperatingPoint(
      { type: 'max_quality', costCeilingPer1K: 0.5 },
      frontier,
      CFG_CHEAP,
      { toolCapableOnly: true },
    );
    expect(op.config).toEqual(CFG_CHEAP);
    expect(op.toolConstraint).toBeUndefined();
  });

  it('THE POLICY BOUND STILL HOLDS: narrowing never serves below the quality floor', () => {
    const frontier = {
      id: 'f1',
      clusterId: 'code-gen',
      version: 2,
      parentId: null,
      points: POINTS,
      createdAt: new Date().toISOString(),
    } as never;
    const op = resolveOperatingPoint(MIN_COST, frontier, CFG_CHEAP, { toolCapableOnly: true });
    const served = POINTS.find((p) => p.strategyHash === strategyHash(op.config!))!;
    expect(served.quality).toBeGreaterThanOrEqual(0.8);
  });

  it('falls back to a single strategy when no single point qualifies at all', () => {
    // Only a cascade clears the floor — nothing single can satisfy the policy,
    // so the last-resort fallback (single by construction) serves.
    const cascadeOnly = [point(CFG_CHEAP, 0.5, 0.4, 300), point(CFG_CASCADE, 0.88, 0.9, 2100)];
    const frontier = {
      id: 'f1',
      clusterId: 'code-gen',
      version: 2,
      parentId: null,
      points: cascadeOnly,
      createdAt: new Date().toISOString(),
    } as never;
    const op = resolveOperatingPoint(MIN_COST, frontier, CFG_CHEAP, { toolCapableOnly: true });
    expect(op.config?.type).toBe('single'); // never a cascade under tools
    expect(op.toolConstraint).toBeDefined();
  });
});
