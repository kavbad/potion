// Playground chat tests (M4, ROADMAP #31, SPEC §13.3).
//   · POST /api/playground/chat executes the CHOSEN frontier point — the
//     x-frontier-trace strategy hash8 + the meta chunk's strategy_hash prove
//     the selected strategy ran (not a policy-routed one)
//   · SSE is well-formed: role chunk → content → finish stop → meta chunk
//     (usage + latency_ms + cost_usd + provenance) → [DONE]
//   · potion-auto (auto:true) resolves via the org policy / highest-quality
//     fallback; unknown cluster/point → 404; bad bodies → 400
//   · org-scoped: with the dev bypass forced OFF, no session → 401
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256, strategyHash, type FrontierPoint } from '@potion/core';
import { DEFAULT_ORG_ID, insertApiKey, insertPolicy } from '@potion/db';
// G2.4 carryover: multi-org arms name their tenant from the shared fixture —
// the demo org is never the probed subject (see the fixture header).
import { ORG_B, seedIsolationOrgs } from './fixtures/orgs.js';
import { saveFrontier } from '@potion/pareto';
import { buildServer } from '../src/server.js';

const CFG_CHEAP = { type: 'single', model: 'mock-cheap' } as const;
const CFG_MID = { type: 'single', model: 'mock-mid' } as const;
const H_CHEAP = strategyHash(CFG_CHEAP);
const H_MID = strategyHash(CFG_MID);

const POINTS: FrontierPoint[] = [
  {
    clusterId: 'code-gen',
    strategyHash: H_CHEAP,
    strategyConfig: CFG_CHEAP,
    quality: 0.7,
    costPer1K: 0.4,
    latencyP95: 120,
    providerMode: 'mock',
  },
  {
    clusterId: 'code-gen',
    strategyHash: H_MID,
    strategyConfig: CFG_MID,
    quality: 0.95,
    costPer1K: 2.1,
    latencyP95: 340,
    providerMode: 'mock',
  },
];

interface SseEvent {
  data: string;
}

function parseSse(body: string): SseEvent[] {
  return body
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block.startsWith('data:'))
    .map((block) => ({ data: block.slice(5).trim() }));
}

let app: FastifyInstance;
const db = () => app.potion.db.db;

beforeAll(async () => {
  app = await buildServer({ seed: false });
  await saveFrontier(db(), 'code-gen', POINTS, 'manual', 'test-prices');
}, 90_000);

afterAll(async () => {
  await app.close();
});

describe('POST /api/playground/chat — point selection', () => {
  it('executes the CHOSEN frontier point: trace header + meta chunk prove the strategy', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/playground/chat',
      payload: {
        clusterId: 'code-gen',
        strategyHash: H_CHEAP,
        messages: [{ role: 'user', content: 'Write a python function that reverses a string' }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const trace = res.headers['x-frontier-trace'] as string;
    // policy=playground + the CHOSEN hash8 (H_CHEAP, not a policy-routed pick)
    expect(trace).toContain('cluster=code-gen');
    expect(trace).toContain(`strategy=${H_CHEAP.slice(0, 8)}`);
    expect(trace).toContain('frontier=v1');
    expect(trace).toContain('policy=playground');
    expect(trace).toContain('fallback=0');
    expect(trace).toContain('provenance=mock'); // mock-provenance point, never live

    const events = parseSse(res.body);
    expect(events.length).toBeGreaterThan(3);
    const first = JSON.parse(events[0]!.data) as { choices: Array<{ delta: { role?: string } }> };
    expect(first.choices[0]!.delta.role).toBe('assistant');
    // content chunks assemble into a non-empty answer
    const text = events
      .slice(1, -3)
      .map((e) => (JSON.parse(e.data) as { choices: Array<{ delta: { content?: string } }> }).choices[0]?.delta.content ?? '')
      .join('');
    expect(text.length).toBeGreaterThan(0);
    const done = events[events.length - 1]!;
    expect(done.data).toBe('[DONE]');
    // meta chunk (second to last): usage + latency/cost + strategy proof
    const meta = JSON.parse(events[events.length - 2]!.data) as {
      choices: unknown[];
      usage: { total_tokens: number };
      latency_ms: number;
      cost_usd: number;
      strategy_hash: string;
      provenance: string;
    };
    expect(meta.choices).toEqual([]);
    expect(meta.usage.total_tokens).toBeGreaterThan(0);
    expect(meta.latency_ms).toBeGreaterThanOrEqual(0);
    expect(meta.cost_usd).toBeGreaterThanOrEqual(0);
    expect(meta.strategy_hash).toBe(H_CHEAP);
    expect(meta.provenance).toBe('mock');
  });

  it('a different point executes a different strategy (compare-mode primitive)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/playground/chat',
      payload: {
        clusterId: 'code-gen',
        strategyHash: H_MID,
        messages: [{ role: 'user', content: 'reverse a string in python' }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-frontier-trace']).toContain(`strategy=${H_MID.slice(0, 8)}`);
  });

  it('potion-auto (auto:true) falls back to the highest-quality point without a policy', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/playground/chat',
      payload: {
        clusterId: 'code-gen',
        auto: true,
        messages: [{ role: 'user', content: 'hello' }],
      },
    });
    expect(res.statusCode).toBe(200);
    const trace = res.headers['x-frontier-trace'] as string;
    // H_MID has quality 0.95 — the documented highest-quality fallback
    expect(trace).toContain(`strategy=${H_MID.slice(0, 8)}`);
    expect(trace).toContain('fallback=1');
    expect(trace).toContain('policy=playground');
  });

  it("clusterId 'auto' classifies the prompt the way serving does and names the cluster in the receipt", async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/playground/chat',
      payload: { clusterId: 'auto', auto: true, messages: [{ role: 'user', content: 'Write a function that merges overlapping date ranges.' }] },
    });
    // Either the classified cluster has a frontier (200 + cluster_id in the meta
    // chunk) or it does not (400 naming the classified cluster) — never a
    // validation error about 'auto' itself.
    if (res.statusCode === 200) {
      expect(res.body).toMatch(/"cluster_id":"[a-z-]+"/);
      expect(res.body).not.toMatch(/"cluster_id":"auto"/);
    } else {
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatch(/no frontier for cluster '(?!auto')[a-z-]+'/);
    }
  });

  it('potion-auto routes via the org’s bound policy when one exists', async () => {
    // min_cost qualityFloor 0.7 → the cheap point satisfies it at lower cost
    await insertPolicy(db(), {
      id: 'pol-pg-min-cost',
      orgId: DEFAULT_ORG_ID,
      name: 'pg-min-cost',
      config: { type: 'min_cost', qualityFloor: 0.7 },
    });
    await insertApiKey(db(), {
      id: 'key-pg-policy',
      keyHash: sha256('pk_playground_policy'),
      name: 'pg',
      orgId: DEFAULT_ORG_ID,
      policyId: 'pol-pg-min-cost',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/playground/chat',
      payload: { clusterId: 'code-gen', auto: true, messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-frontier-trace']).toContain(`strategy=${H_CHEAP.slice(0, 8)}`);
  });

  it('unknown cluster / unknown point / missing selection → 404/400', async () => {
    const unknownCluster = await app.inject({
      method: 'POST',
      url: '/api/playground/chat',
      payload: { clusterId: 'nope', strategyHash: H_CHEAP, messages: [{ role: 'user', content: 'x' }] },
    });
    expect(unknownCluster.statusCode).toBe(404);
    const unknownPoint = await app.inject({
      method: 'POST',
      url: '/api/playground/chat',
      payload: { clusterId: 'code-gen', strategyHash: 'f'.repeat(32), messages: [{ role: 'user', content: 'x' }] },
    });
    expect(unknownPoint.statusCode).toBe(404);
    const noSelection = await app.inject({
      method: 'POST',
      url: '/api/playground/chat',
      payload: { clusterId: 'code-gen', messages: [{ role: 'user', content: 'x' }] },
    });
    expect(noSelection.statusCode).toBe(400);
    const emptyMessages = await app.inject({
      method: 'POST',
      url: '/api/playground/chat',
      payload: { clusterId: 'code-gen', strategyHash: H_CHEAP, messages: [] },
    });
    expect(emptyMessages.statusCode).toBe(400);
  });

  it('org-scoped: no session with the dev bypass OFF → 401; another org’s key works', async () => {
    const prev = process.env.POTION_DEV_AUTH;
    process.env.POTION_DEV_AUTH = '0';
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/playground/chat',
        payload: { clusterId: 'code-gen', strategyHash: H_CHEAP, messages: [{ role: 'user', content: 'x' }] },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      if (prev === undefined) delete process.env.POTION_DEV_AUTH;
      else process.env.POTION_DEV_AUTH = prev;
    }
    // A second org authenticates and chats within its own org context.
    await seedIsolationOrgs(db());
    await insertApiKey(db(), { id: 'key-pg-b', keyHash: sha256('pk_pg_b'), name: 'b', orgId: ORG_B });
    const ok = await app.inject({
      method: 'POST',
      url: '/api/playground/chat',
      headers: { authorization: 'Bearer pk_pg_b' },
      payload: { clusterId: 'code-gen', strategyHash: H_CHEAP, messages: [{ role: 'user', content: 'x' }] },
    });
    expect(ok.statusCode).toBe(200);
  });
});

describe('Try page rules (operator, 2026-08-22): optimize for cost / quality / latency', () => {
  it('pickUnderRule applies each rule to one frontier', async () => {
    const { pickUnderRule } = await import('../src/routes/playground.js');
    const pts = [
      { strategyHash: 'a', strategyConfig: { type: 'single', model: 'a' }, quality: 0.9, costPer1K: 0.1, latencyP95: 900 },
      { strategyHash: 'b', strategyConfig: { type: 'single', model: 'b' }, quality: 0.96, costPer1K: 0.5, latencyP95: 300 },
      { strategyHash: 'c', strategyConfig: { type: 'single', model: 'c' }, quality: 0.99, costPer1K: 4, latencyP95: 1200 },
      { strategyHash: 'd', strategyConfig: { type: 'single', model: 'd' }, quality: 0.97, costPer1K: 2, latencyP95: 200 },
    ] as never;
    expect(pickUnderRule(pts, 'cost', 0.95)?.strategyHash).toBe('b');
    expect(pickUnderRule(pts, 'quality', 0.95)?.strategyHash).toBe('c');
    expect(pickUnderRule(pts, 'latency', 0.95)?.strategyHash).toBe('d');
    // nothing above the floor: the rules fall back to the whole frontier
    expect(pickUnderRule(pts, 'cost', 0.999)?.strategyHash).toBe('a');
  });

  it('optimizeFor picks the point and the meta chunk names the model and the three alternatives', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/playground/chat',
      payload: { clusterId: 'code-gen', auto: true, optimizeFor: 'quality', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-frontier-trace']).toContain(`strategy=${H_MID.slice(0, 8)}`);
    const meta = parseSse(res.body).map((e) => e.data).filter((d) => d !== '[DONE]').map((d) => JSON.parse(d) as Record<string, unknown>).find((o) => o.usage);
    expect(meta?.model).toBe('mock-mid');
    expect(meta?.rule).toBe('quality');
    const alts = meta?.alternatives as { rule: string; model: string | null }[];
    expect(alts.map((a) => a.rule)).toEqual(['cost', 'quality', 'latency']);
    expect(alts.every((a) => a.model !== null)).toBe(true);
  });
});
