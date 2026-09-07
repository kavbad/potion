// C1 remainders (docs/INFERENCE-COMPILER-PLAN.md): a `program` point that is
// SELECTED and SERVED, and what the customer can see afterwards.
//
// C1 made programs reachable — schema, persistence, interpreter, hash. It did
// not make them legible. Three things were declared and not enforced:
//   · strategyCapabilities().canStream was read by nothing; the SSE path
//     enumerated 'single'/'composite' by literal comparison, so a shape whose
//     declaration and route disagreed would ship silently;
//   · result.trace was consumed for exactly one thing (composite's upgraded
//     flag) and never surfaced, so for a program — where the BRANCH TAKEN is
//     the whole point — the receipt could not say which one ran;
//   · x-potion-model flattened every program to `combination:program`, naming
//     the category where a program's mechanism is its name.
// PGlite in-memory, zero network.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { branchStats, pathLengthOf, programCallCount, sha256, strategyHash, type FrontierPoint, type ProgramNode, type StrategyConfig } from '@potion/core';
import { DEFAULT_ORG_ID, insertApiKey, insertPolicy, requestLogs } from '@potion/db';
import { desc } from 'drizzle-orm';
import { strategyCapabilities } from '@potion/strategies';
import { saveFrontier } from '@potion/pareto';
import { buildServer } from '../src/server.js';
import { streamingBranch } from '../src/routes/chat.js';

/** Escalates: a mock prose answer never parses as JSON, so `else` fires. */
const CFG_ESCALATE: StrategyConfig = {
  type: 'program',
  name: 'verified-cascade',
  body: {
    op: 'if',
    check: { kind: 'json', of: { op: 'call', model: 'mock-cheap' } },
    then: { op: 'call', model: 'mock-cheap' },
    else: { op: 'call', model: 'mock-frontier' },
  },
};
/** Keeps: `.` matches any non-empty answer, and `then` IS the checked node, so
 *  the structural memo pays for mock-cheap once — one stage, not two. */
const CFG_KEEP: StrategyConfig = {
  type: 'program',
  name: 'regex-gate',
  body: {
    op: 'if',
    check: { kind: 'regex', of: { op: 'call', model: 'mock-cheap' }, pattern: '.' },
    then: { op: 'call', model: 'mock-cheap' },
    else: { op: 'call', model: 'mock-frontier' },
  },
};
const H_ESCALATE = strategyHash(CFG_ESCALATE).slice(0, 8);
const H_KEEP = strategyHash(CFG_KEEP).slice(0, 8);

const KEY = 'pk_test_program_serving';
let app: FastifyInstance;

async function chat(payload: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    payload: {
      model: 'potion-auto',
      messages: [{ role: 'user', content: 'Write a python function that reverses a string' }],
      ...payload,
    },
  });
}

async function serve(cfg: StrategyConfig, cost: number, toolsMeasured = false): Promise<void> {
  const base = {
    clusterId: 'code-gen' as const,
    strategyHash: strategyHash(cfg),
    strategyConfig: cfg,
    quality: 0.9,
    costPer1K: cost,
    latencyP95: 2000,
  };
  const point: FrontierPoint = toolsMeasured
    ? { ...base, evidence: { cacheKeys: ['ck-1'], runIds: ['run-1'], n: 12, qualityCi95: 0.03, toolsMeasured: true } }
    : base;
  await saveFrontier(app.potion.db.db, 'code-gen', [point], 'manual', '2026-08-04');
}

beforeAll(async () => {
  app = await buildServer({ seed: false });
  const db = app.potion.db.db;
  await insertPolicy(db, {
    id: 'pol-prog',
    orgId: DEFAULT_ORG_ID,
    name: 'pol-prog',
    config: { type: 'max_quality', costCeilingPer1K: 1000 },
  });
  await insertApiKey(db, {
    id: 'key-prog',
    keyHash: sha256(KEY),
    name: 'key-prog',
    orgId: DEFAULT_ORG_ID,
    policyId: 'pol-prog',
  });
}, 90_000);

afterAll(async () => {
  await app.close();
});

describe('a program serves, and the receipt says which branch ran', () => {
  it('escalating branch: the trace names the program and the path it actually took', async () => {
    await serve(CFG_ESCALATE, 2.5);
    const res = await chat();
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-frontier-trace']).toBe(
      `cluster=code-gen;strategy=${H_ESCALATE};frontier=v1;policy=max_quality;fallback=0;` +
        `provenance=mock;program=verified-cascade;path=mock-cheap>mock-frontier`,
    );
  });

  it('kept branch: one stage, because the checked node IS the then-branch', async () => {
    await serve(CFG_KEEP, 2.4);
    const res = await chat();
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-frontier-trace']).toContain(`strategy=${H_KEEP}`);
    expect(res.headers['x-frontier-trace']).toContain('program=regex-gate;path=mock-cheap');
    expect(res.headers['x-frontier-trace']).not.toContain('mock-frontier');
  });

  it('x-potion-model names the mechanism, not just its category', async () => {
    const res = await chat();
    expect(res.headers['x-potion-model']).toBe('combination:program:regex-gate');
  });

  it('stream:true on a program is honestly refused as non-streamed, not silently SSE', async () => {
    const res = await chat({ stream: true });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['x-latency-contract']).toBe('non-streamed');
  });
});

describe('canStream is enforced, not merely declared', () => {
  const shapes: StrategyConfig[] = [
    { type: 'single', model: 'mock-cheap' },
    { type: 'cascade', stages: [{ model: 'a' }, { model: 'b' }], confidenceMethod: 'logprob' },
    { type: 'best-of-n', model: 'a', n: 3, judge: { model: 'j' } },
    { type: 'draft-verify', draftModel: 'a', verifierModel: 'b' },
    { type: 'ensemble', models: ['a', 'b'], fusion: { method: 'judge-pick' } },
    { type: 'decompose', decomposerModel: 'd', routing: { default: 'a' } },
    { type: 'composite', startModel: 'a', upgradeModel: 'b', upgradeIf: { confidenceBelow: 0.6 } },
    CFG_KEEP,
  ];

  it('every shape that declares canStream has a streaming branch, and vice versa', () => {
    for (const cfg of shapes) {
      expect(
        { type: cfg.type, hasBranch: streamingBranch(cfg) !== null },
        `capability/route drift for '${cfg.type}'`,
      ).toEqual({ type: cfg.type, hasBranch: strategyCapabilities(cfg).canStream });
    }
  });
});

// ---- C4b: a tool-capable program reaches the serving path ----
describe('a bare-call program can carry tools', () => {
  const CFG_TOOLED: StrategyConfig = {
    type: 'program',
    name: 'effort-single',
    body: { op: 'call', model: 'mock-cheap', reasoningEffort: 'low' },
  };

  it('is not rejected by the fail-closed backstop, which keys on capability now', async () => {
    // Shape CAN plus MEASURED WITH TOOLS — the serving rule needs both, and
    // that is right: a program never measured on tool-bearing items has no
    // business taking tool traffic.
    await serve(CFG_TOOLED, 2.0, true);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      payload: {
        model: 'potion-auto',
        messages: [{ role: 'user', content: 'Write a python function that reverses a string' }],
        tools: [{ type: 'function', function: { name: 'run', description: 'r', parameters: { type: 'object', properties: {} } } }],
      },
    });
    // Before C4b this was a 400: the backstop compared `type !== 'single'`, so
    // a program that CAN carry tools was refused after selection had already
    // chosen it. The capability is the thing that knows.
    expect(res.statusCode).toBe(200);
    // …and it must be the PROGRAM that served, not a fallback single. A 200
    // proves nothing on its own: narrowing to tool-capable points would also
    // return 200 by quietly serving something else.
    expect(res.headers['x-frontier-trace']).toContain(`strategy=${strategyHash(CFG_TOOLED).slice(0, 8)}`);
    expect(res.headers['x-potion-model']).toBe('combination:program:effort-single');
  });

  it('a GATED program is still refused — its check has no text to read', () => {
    expect(strategyCapabilities(CFG_TOOLED).canServeTools).toBe(true);
    expect(strategyCapabilities(CFG_KEEP).canServeTools).toBe(false);
  });
});

// ---- C3: the compiler can read its own decisions ----
describe('a conditional mechanism records which way it went', () => {
  it('the branch reaches the LOG ROW, not only the response header', async () => {
    await serve(CFG_ESCALATE, 1.5);
    const res = await chat();
    expect(res.statusCode).toBe(200);
    const header = res.headers['x-frontier-trace'] as string;
    expect(header).toContain('program=verified-cascade;path=');

    // Before C3 the log row carried the BASE trace: the customer could see
    // which way the mechanism went and Potion could not. A compiler that
    // cannot read its own decisions cannot learn from them.
    const rows = await app.potion.db.db
      .select({ trace: requestLogs.trace })
      .from(requestLogs)
      .orderBy(desc(requestLogs.ts))
      .limit(1);
    expect(rows[0]!.trace).toBe(header);
    expect(pathLengthOf(rows[0]!.trace)).toBe(2); // escalated: two stages
  });

  it('and the recorded path is what the branch statistics read', async () => {
    await serve(CFG_KEEP, 1.4);
    const res = await chat();
    const header = res.headers['x-frontier-trace'] as string;
    expect(pathLengthOf(header)).toBe(1); // kept: the memo paid once
    // A window of servings that never escalate is degenerate, and now sayable.
    const stats = branchStats(Array.from({ length: 30 }, () => 1), programCallCount((CFG_KEEP as { body: ProgramNode }).body));
    expect(stats.verdict).toBe('never-escalates');
  });
});
